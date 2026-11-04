'use strict';
/**
 * Demo data: seeds a database from the simulator and regenerates slices of a load's history.
 *
 * `seedDemo` is idempotent and additive: it creates what is missing (sites, loads, modules, tariffs,
 * settings, history, the two accepted recommendations) and never touches what exists, so running it
 * twice changes nothing. It creates no users (roles and demo users belong to the auth work) and the
 * server never runs it by itself: it is a script (`npm run seed:demo`) that production only runs when
 * explicitly enabled.
 */

const { transaction } = require('../db/connection');
const { buildScenario, DEFAULT_SEED } = require('../adapters/simulator/scenario');
const { generateHistory } = require('../adapters/simulator/history');
const { MAIN_PROFILES, MAIN_SCHEDULE, MAIN_SITE_ID } = require('../adapters/simulator/profiles');
const { computeBaseline } = require('../domain/baseline');
const { scoreRecommendation } = require('../domain/recommendations');
const { localDateKey, MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } = require('../domain/time');
const { analyticsSeries } = require('./series');
const { ensureSite, MAIN_SITE, DEFAULT_TARIFF_COP_PER_KWH } = require('./site-setup');

const SOURCE = 'simulator';
const floorHour = (ms) => Math.floor(ms / MS_PER_HOUR) * MS_PER_HOUR;
const floorMinute = (ms) => Math.floor(ms / MS_PER_MINUTE) * MS_PER_MINUTE;
const iso = (ms) => new Date(ms).toISOString();

function rawRow(loadId, moduleId, r) {
  return { loadId, moduleId, ts: r.ts, powerW: r.powerW, voltageV: r.voltageV, currentA: r.currentA, energyKwh: r.energyKwh, source: SOURCE };
}
function hourlyRow(loadId, h) {
  return { loadId, hourStart: h.hourStart, avgPowerW: h.avgPowerW, maxPowerW: h.maxPowerW, energyKwh: h.energyKwh, samples: h.samples };
}

/** Finds or creates a load and (when it has a module id) its module. @returns {{load: object, created: boolean}} */
function ensureLoad(repos, siteId, profile, registeredAtMs) {
  let load = repos.loads.getByCode(siteId, profile.code);
  const created = !load;
  if (!load) {
    load = repos.loads.create({
      siteId, code: profile.code, name: profile.name, icon: profile.icon, typicalPowerW: profile.typicalPowerW,
      criticality: profile.criticality, controlMode: profile.controlMode,
    });
  }
  return { load, created };
}

/**
 * @param {{repos: object, db: object, clock: {now: function(): number}, seed?: (number|string), sites?: boolean}} input
 * @returns {{skipped: boolean, anchor: string, seed: (number|string), loads: number, modules: number, rawReadings: number,
 *   hourlyRows: number, recommendations: number, sites: string[], energyKwhByLoad: Object<string, number>}}
 */
function seedDemo({ repos, db, clock, seed = DEFAULT_SEED }) {
  const anchorMs = floorMinute(clock.now());
  const sc = buildScenario({ seed, anchorMs });
  const anchor = iso(anchorMs);
  const summary = { skipped: false, anchor, seed, loads: 0, modules: 0, rawReadings: 0, hourlyRows: 0, recommendations: 0, sites: [], energyKwhByLoad: {} };

  transaction(db, () => {
    const tariffFrom = localDateKey(sc.historyStartMs);
    ensureSite({ repos, clock, site: MAIN_SITE, schedule: MAIN_SCHEDULE, tariffFrom });
    for (const site of sc.extraSites) ensureSite({ repos, clock, site: { id: site.id, name: site.name, city: site.city }, schedule: site.schedule, tariffFrom });
    summary.sites = [MAIN_SITE_ID, ...sc.extraSites.map((s) => s.id)];

    // Main site: loads, modules (the registry) and 1-minute + hourly history.
    const ids = {};
    const toGenerate = [];
    for (const profile of MAIN_PROFILES) {
      const startMs = sc.loads.find((l) => l.code === profile.code).startMs;
      const { load, created } = ensureLoad(repos, MAIN_SITE_ID, profile);
      ids[profile.code] = load.id;
      summary.loads += created ? 1 : 0;
      if (!repos.modules.get(profile.moduleId)) {
        repos.modules.register({ id: profile.moduleId, siteId: MAIN_SITE_ID, loadId: load.id, manufacturer: profile.manufacturer, registeredAt: iso(startMs) });
        summary.modules += 1;
      }
      if (!repos.readings.hasData(load.id)) toGenerate.push(sc.loads.find((l) => l.code === profile.code));
    }
    const moduleOf = Object.fromEntries(MAIN_PROFILES.map((p) => [p.code, p.moduleId]));
    const rows = {};
    const bucket = (code) => rows[code] || (rows[code] = { raw: [], hourly: [] });
    generateHistory({
      engine: sc.engine, loads: toGenerate, endMs: anchorMs, rawFromMs: sc.rawFromMs,
      sink: { raw: (code, r) => bucket(code).raw.push(rawRow(ids[code], moduleOf[code], r)), hourly: (code, h) => bucket(code).hourly.push(hourlyRow(ids[code], h)) },
    });
    for (const [code, r] of Object.entries(rows)) {
      summary.rawReadings += repos.readings.insertMany(r.raw);
      summary.hourlyRows += repos.readings.insertHourlyMany(r.hourly);
    }
    for (const profile of MAIN_PROFILES) {
      const latest = repos.readings.latest(ids[profile.code]);
      if (latest) summary.energyKwhByLoad[profile.code] = latest.energy_kwh;
      if (repos.modules.get(profile.moduleId)?.site_id === MAIN_SITE_ID) repos.modules.heartbeat(profile.moduleId, anchor);
    }

    // Additional sites: aggregated hourly history only (no 1-minute readings).
    for (const site of sc.extraSites) {
      const siteIds = {};
      const pending = [];
      for (const spec of site.loads) {
        const profile = MAIN_PROFILES.find((p) => p.code === spec.code);
        const { load, created } = ensureLoad(repos, site.id, profile);
        siteIds[spec.code] = load.id;
        summary.loads += created ? 1 : 0;
        if (!repos.readings.hasData(load.id)) pending.push(spec);
      }
      const hourly = [];
      generateHistory({
        engine: site.engine, loads: pending, endMs: anchorMs, rawFromMs: floorHour(anchorMs), stepMinutes: sc.extraStepMinutes,
        sink: { hourly: (code, h) => hourly.push(hourlyRow(siteIds[code], h)) },
      });
      summary.hourlyRows += repos.readings.insertHourlyMany(hourly);
    }

    // Two recommendations accepted more than 7 days ago (their effect is part of the generated data).
    const maxSavingsCop = Math.max(...sc.acceptedRecommendations.map((r) => r.monthlySavingsKwh * DEFAULT_TARIFF_COP_PER_KWH));
    for (const rec of sc.acceptedRecommendations) {
      const loadId = ids[rec.loadCode];
      if (repos.recommendations.list({ siteId: MAIN_SITE_ID, loadId }).some((r) => r.title === rec.title)) continue;
      const profile = MAIN_PROFILES.find((p) => p.code === rec.loadCode);
      const series = analyticsSeries(repos, loadId, { from: iso(sc.historyStartMs), to: iso(anchorMs + MS_PER_MINUTE) });
      const baseline = computeBaseline(series, { asOf: rec.acceptedAtMs });
      const monthlySavingsCop = rec.monthlySavingsKwh * DEFAULT_TARIFF_COP_PER_KWH;
      const scored = scoreRecommendation({ monthlySavingsCop, maxSavingsCop, criticality: profile.criticality, confidence: rec.confidence });
      const created = repos.recommendations.create({
        siteId: MAIN_SITE_ID, loadId, type: rec.type, title: rec.title, assumption: rec.assumption, monthlySavingsKwh: rec.monthlySavingsKwh,
        monthlySavingsCop, score: scored.score, confidence: scored.confidence, createdAt: iso(rec.createdAtMs),
        baselineWindowStart: baseline.status === 'ready' ? baseline.windowStart : null, baselineWindowEnd: baseline.status === 'ready' ? baseline.windowEnd : null,
      });
      repos.recommendations.decide(created.id, { status: 'accepted', at: iso(rec.acceptedAtMs) });
      summary.recommendations += 1;
    }

    summary.skipped = summary.loads + summary.modules + summary.rawReadings + summary.hourlyRows + summary.recommendations === 0;
    if (!summary.skipped) {
      repos.audit.append({ at: anchor, actor: 'system', event: 'demo_seeded', siteId: MAIN_SITE_ID, details: { seed, anchor, loads: summary.loads, modules: summary.modules } });
      repos.events.track({ at: anchor, name: 'demo_seeded', siteId: MAIN_SITE_ID, properties: { seed, anchor } });
    }
  });

  return summary;
}

/**
 * The scenario that produced the stored demo history (same seed and anchor), or one anchored at "now"
 * when the database was never seeded. The engine of the returned scenario is what live ticks use.
 */
function loadDemoScenario({ repos, clock, seed = DEFAULT_SEED }) {
  const seeded = repos.events.list({ name: 'demo_seeded', limit: 1 })[0];
  if (seeded) {
    const props = JSON.parse(seeded.properties);
    return { seeded: true, ...buildScenario({ seed: props.seed ?? seed, anchorMs: Date.parse(props.anchor) }) };
  }
  return { seeded: false, ...buildScenario({ seed, anchorMs: floorMinute(clock.now()) }) };
}

/**
 * Regenerates the stored history of one load from `fromMs` to now with the engine as it is now
 * (after a demo control added a modifier). Hourly rows are replaced before the raw window, raw rows
 * inside it. Returns the number of rows written and the new cumulative counter.
 */
function rewriteLoadHistory({ repos, db, engine, clock, load, moduleId, fromMs }) {
  const nowMs = floorMinute(clock.now());
  const rawFromMs = floorHour(nowMs - 2 * MS_PER_DAY);
  const from = floorHour(fromMs);
  const rawStart = Math.max(from, rawFromMs);
  const code = load.code;
  return transaction(db, () => {
    // The cumulative counter must stay continuous with the readings that are not rewritten.
    let energyKwh = 0;
    if (from < rawFromMs) {
      const firstRaw = repos.readings.range(load.id, iso(rawFromMs), iso(rawFromMs + MS_PER_HOUR))[0];
      const replaced = repos.readings.hourlyRange(load.id, iso(from), iso(rawFromMs)).reduce((total, h) => total + h.energy_kwh, 0);
      energyKwh = firstRaw ? Math.max(0, firstRaw.energy_kwh - replaced) : 0;
    } else {
      const before = repos.readings.range(load.id, iso(rawStart - MS_PER_MINUTE), iso(rawStart));
      energyKwh = before.length ? before[0].energy_kwh : 0;
    }
    repos.readings.deleteRange(load.id, iso(rawStart), iso(nowMs + MS_PER_MINUTE));
    if (from < rawFromMs) repos.readings.deleteHourlyRange(load.id, iso(from), iso(rawFromMs));
    const raw = [];
    const hourly = [];
    generateHistory({
      engine, loads: [{ code, startMs: from, energyKwh }], endMs: nowMs, rawFromMs,
      sink: { raw: (c, r) => raw.push(rawRow(load.id, moduleId, r)), hourly: (c, h) => hourly.push(hourlyRow(load.id, h)) },
    });
    const rawWritten = repos.readings.insertMany(raw);
    const hourlyWritten = repos.readings.insertHourlyMany(hourly);
    const last = raw.length ? raw[raw.length - 1].energyKwh : energyKwh;
    return { rawWritten, hourlyWritten, energyKwh: last };
  });
}

module.exports = { seedDemo, loadDemoScenario, rewriteLoadHistory, rawRow, hourlyRow, ensureLoad, MS_PER_DAY };
