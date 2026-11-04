const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { seedDemo, loadDemoScenario } = require('../backend/app/demo-data');
const { createDemoControls, DemoControlError } = require('../backend/app/demo-controls');
const { createIngestion } = require('../backend/app/ingestion');
const { analyticsSeries, recentReadings } = require('../backend/app/series');
const { createModuleFleet } = require('../backend/adapters/simulator/module-fleet');
const { MAIN_PROFILES } = require('../backend/adapters/simulator/profiles');
const domain = require('../backend/domain');
const { createTestEnv, ANCHOR, ANCHOR_ISO } = require('./helpers/db');

const SITE = 'la-espiga-chia';
const MIN = 60000;
const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const TABLES = ['sites', 'site_schedules', 'loads', 'modules', 'readings', 'readings_hourly', 'tariffs', 'settings', 'recommendations', 'users', 'audit', 'events'];
const counts = (db) => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));

let shared;
let sharedSummary;
let seedSeconds;

before(() => {
  shared = createTestEnv({ mainSite: false });
  const started = process.hrtime.bigint();
  sharedSummary = seedDemo({ repos: shared.repos, db: shared.db, clock: shared.clock });
  seedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
});

/** A freshly seeded database with live controls (the simulator side wired as the server would). */
function liveEnv() {
  const env = createTestEnv({ mainSite: false });
  const summary = seedDemo({ repos: env.repos, db: env.db, clock: env.clock });
  const scenario = loadDemoScenario({ repos: env.repos, clock: env.clock });
  const fleet = createModuleFleet({
    engine: scenario.engine, clock: env.clock, siteId: SITE, initialEnergyKwh: summary.energyKwhByLoad,
    modules: MAIN_PROFILES.map((p) => ({ moduleId: p.moduleId, loadCode: p.code, manufacturer: p.manufacturer })),
  });
  const ingestion = createIngestion({ repos: env.repos, clock: env.clock, options: { autoRegister: false } });
  const controls = createDemoControls({ repos: env.repos, db: env.db, clock: env.clock, scenario, fleet, ingestion });
  return { ...env, summary, scenario, fleet, ingestion, controls };
}

const seriesOf = (repos, load, nowMs) => analyticsSeries(repos, load.id, { from: '2026-01-01T00:00:00.000Z', to: iso(nowMs + MIN) });
const maintenance = (env, code) => {
  const load = env.repos.loads.getByCode(SITE, code);
  return domain.alerts.evaluateMaintenanceAlert({ load: { id: load.id, name: load.name }, readings: seriesOf(env.repos, load, env.clock.now()), tariffs: [{ copPerKwh: 950, effectiveFrom: '2026-01-01' }], now: env.clock.now() });
};

test('seeding creates the spec scenario: sites, loads, modules, tariff, settings, history', () => {
  const { repos, db } = shared;
  assert.equal(sharedSummary.skipped, false);
  assert.deepEqual(repos.sites.list().map((s) => s.id).sort(), ['la-espiga-chia', 'la-espiga-cajica', 'la-espiga-zipaquira'].sort());
  assert.equal(repos.sites.get(SITE).name, 'Panadería La Espiga – Chía');
  const schedule = repos.sites.getSchedule(SITE);
  assert.deepEqual([schedule[0].opens_at, schedule[0].closes_at, schedule[1].opens_at, schedule[1].closes_at], ['07:00', '13:00', '06:00', '20:00']);
  assert.equal(repos.sites.getSchedule('la-espiga-zipaquira')[0].closed, 1);

  const loads = repos.loads.listBySite(SITE);
  assert.equal(loads.length, 11);
  const by = Object.fromEntries(loads.map((l) => [l.code, l]));
  assert.deepEqual([by.freezer.criticality, by.freezer.control_mode, by.oven.criticality, by.oven.control_mode, by.coffee.control_mode, by.sign.criticality], ['critical', 'monitor_only', 'essential', 'monitor_only', 'control_enabled', 'non_essential']);
  assert.equal(by.whisk.name, 'Batidora nueva');

  const modules = repos.modules.listBySite(SITE);
  assert.equal(modules.length, 11);
  assert.deepEqual([...new Set(modules.map((m) => m.manufacturer))].sort(), ['EnerSense', 'VoltioLab']);
  assert.ok(modules.every((m) => m.status === 'active' && m.last_heartbeat === ANCHOR_ISO && m.load_id !== null));
  assert.equal(repos.modules.get('MX-001').load_id, by.freezer.id, 'the ESP32 demo module ids keep their loads');

  const tariff = repos.tariffs.list(SITE)[0];
  assert.equal(tariff.cop_per_kwh, 950);
  assert.match(tariff.note, /ejemplo/);
  assert.ok(tariff.effective_from <= '2026-01-25');
  assert.equal(repos.tariffs.effectiveAt(SITE, ANCHOR_ISO).cop_per_kwh, 950);
  const settings = repos.settings.get(SITE);
  assert.deepEqual([settings.investment_cop, settings.emission_factor_kg_per_kwh], [1800000, 0.126]);
  assert.match(settings.emission_factor_source, /Valor ilustrativo/);

  assert.equal(counts(db).users, 0, 'demo users are created by the auth work, not by seeding');
  assert.equal(sharedSummary.rawReadings, db.prepare('SELECT COUNT(*) AS n FROM readings').get().n);
});

test('seeded history is readable through the repositories with the expected shape', () => {
  const { repos } = shared;
  const freezer = repos.loads.getByCode(SITE, 'freezer');
  const latest = repos.readings.latest(freezer.id);
  assert.equal(latest.ts, ANCHOR_ISO);
  assert.equal(latest.source, 'simulator');
  assert.equal(latest.module_id, 'MX-001');
  assert.ok(latest.voltage_v > 117 && latest.voltage_v < 123);
  const raw = repos.readings.range(freezer.id, '2026-01-01', '2027-01-01');
  assert.ok(raw.length >= 2880 && raw.length <= 2940, `1-minute rows ${raw.length}`);
  const firstRaw = raw[0].ts;
  const hourly = repos.readings.hourlyRange(freezer.id, '2026-01-01', '2027-01-01');
  assert.ok(hourly.every((h) => h.hour_start < firstRaw), 'hourly rows only before the raw window');
  assert.equal(hourly.length, (Date.parse(firstRaw) - Date.parse(hourly[0].hour_start)) / HOUR);
  // 45 days of history for the main loads, 3 for the new mixer, no raw readings for the other sites.
  const whisk = repos.loads.getByCode(SITE, 'whisk');
  const whiskSeries = seriesOf(repos, whisk, ANCHOR);
  assert.equal(domain.baseline.computeBaseline(whiskSeries, { asOf: ANCHOR }).status, 'building');
  assert.equal(domain.baseline.computeBaseline(whiskSeries, { asOf: ANCHOR }).dayN, 3);
  assert.equal(domain.baseline.computeBaseline(seriesOf(repos, freezer, ANCHOR), { asOf: ANCHOR }).dayN, 45);
  for (const site of ['la-espiga-cajica', 'la-espiga-zipaquira']) {
    const loads = repos.loads.listBySite(site);
    assert.equal(loads.length, 6);
    assert.ok(loads.every((l) => repos.readings.range(l.id, '2026-01-01', '2027-01-01').length === 0 && repos.readings.hourlyRange(l.id, '2026-01-01', '2027-01-01').length > 1000));
  }
  // The recent-window helpers used by the dashboards.
  assert.equal(repos.readings.latestBySite(SITE).length, 11);
  assert.equal(repos.readings.recentBySite(SITE, { limit: 5 }).length, 5);
});

test('seeded recommendations: accepted more than 7 days ago, one conclusive and one not', () => {
  const { repos } = shared;
  const recs = repos.recommendations.list({ siteId: SITE, status: 'accepted' });
  assert.equal(recs.length, 2);
  assert.ok(recs.every((r) => ANCHOR - Date.parse(r.accepted_at) > 7 * 86400000 && r.baseline_window_end));
  const results = {};
  for (const rec of recs) {
    const load = repos.loads.get(rec.load_id);
    const series = seriesOf(repos, load, ANCHOR);
    const baseline = domain.baseline.computeBaseline(series, { asOf: rec.accepted_at });
    results[load.code] = domain.savings.attributableSavings({ recommendation: { acceptedAt: rec.accepted_at }, readings: series, baseline, tariffs: [{ copPerKwh: 950, effectiveFrom: '2026-01-01' }], now: ANCHOR });
  }
  assert.equal(results.coffee.status, 'conclusive');
  assert.equal(results.sign.status, 'inconclusive');
});

test('seeding is idempotent: a second run changes nothing', () => {
  const env = createTestEnv({ mainSite: false });
  const first = seedDemo({ repos: env.repos, db: env.db, clock: env.clock });
  const before = counts(env.db);
  const second = seedDemo({ repos: env.repos, db: env.db, clock: env.clock });
  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.deepEqual(counts(env.db), before);
  // Even from a different instant it only adds what is missing (nothing).
  env.clock.advance(3 * 86400000);
  assert.equal(seedDemo({ repos: env.repos, db: env.db, clock: env.clock }).skipped, true);
  assert.deepEqual(counts(env.db), before);
});

test('seeding time stays reasonable (measured)', () => {
  console.log(`# demo seed time: ${seedSeconds.toFixed(2)} s for ${sharedSummary.rawReadings} raw readings and ${sharedSummary.hourlyRows} hourly rows`);
  assert.ok(seedSeconds < 20, `seeding took ${seedSeconds} s`);
});

test('seeding keeps what already exists: an auto-registered ESP32 module is not duplicated', () => {
  const env = createTestEnv({ mainSite: true });
  const load = env.repos.loads.create({ siteId: SITE, code: 'freezer', name: 'Congelador (ESP32)', criticality: 'critical' });
  env.repos.modules.register({ id: 'MX-001', siteId: SITE, loadId: load.id, manufacturer: 'ESP32 virtual' });
  const summary = seedDemo({ repos: env.repos, db: env.db, clock: env.clock });
  assert.equal(env.repos.loads.listBySite(SITE).length, 11);
  assert.equal(summary.modules, 10);
  assert.equal(env.repos.modules.get('MX-001').manufacturer, 'ESP32 virtual');
  assert.equal(env.repos.loads.getByCode(SITE, 'freezer').name, 'Congelador (ESP32)');
});

test('freezer deterioration of the seeded history fires the maintenance alert from stored data', () => {
  const alert = maintenance(shared, 'freezer');
  assert.equal(alert.fired, true);
  assert.equal(alert.alert.type, 'maintenance');
  assert.equal(maintenance(shared, 'fridge').fired, false);
});

test('demo control: inject an anomaly (percent and duration) and the consumption alert fires with the right excess', () => {
  const env = liveEnv();
  const load = env.repos.loads.getByCode(SITE, 'tv');
  const tariffs = [{ copPerKwh: 950, effectiveFrom: '2026-01-01' }];
  const evaluate = () => {
    const now = env.clock.now();
    const baseline = domain.baseline.computeBaseline(seriesOf(env.repos, load, now), { asOf: now });
    const readings = recentReadings(env.repos, load.id, { from: iso(now - 20 * MIN), to: iso(now + MIN) });
    return domain.alerts.evaluateConsumptionAlert({ load: { id: load.id, name: load.name }, baseline, readings, tariffs, now });
  };
  assert.equal(evaluate().fired, false);
  const injected = env.controls.injectAnomaly({ loadCode: 'tv', pct: 60, durationMinutes: 30 });
  assert.equal(Date.parse(injected.endsAt) - env.clock.now(), 30 * MIN);
  const result = evaluate();
  assert.equal(result.fired, true, result.reason);
  assert.ok(Math.abs(result.alert.excessPct - 60) < 12, `excess ${result.alert.excessPct}`);
  // Live ticks keep the anomaly going while it lasts and stop after the duration.
  env.clock.advance(10 * MIN);
  for (const batch of env.fleet.tick()) env.ingestion.ingest(batch);
  assert.equal(evaluate().fired, true);
  env.clock.advance(40 * MIN);
  for (const batch of env.fleet.tick()) env.ingestion.ingest(batch);
  assert.equal(evaluate().fired, false);
  assert.throws(() => env.controls.injectAnomaly({ loadCode: 'tv', pct: 0, durationMinutes: 5 }), DemoControlError);
  assert.throws(() => env.controls.injectAnomaly({ loadCode: 'tv', pct: 50, durationMinutes: 0 }), DemoControlError);
  assert.throws(() => env.controls.injectAnomaly({ loadCode: 'toaster', pct: 50, durationMinutes: 5 }), /No existe esa carga/);
});

test('demo control: simulate deterioration makes a healthy load fire the maintenance alert', () => {
  const env = liveEnv();
  assert.equal(maintenance(env, 'fridge').fired, false);
  const countBefore = env.db.prepare('SELECT COUNT(*) AS n FROM readings').get().n;
  env.controls.simulateDeterioration({ loadCode: 'fridge' });
  const after = maintenance(env, 'fridge');
  assert.equal(after.fired, true);
  assert.ok(after.alert.excessPct > 15);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM readings').get().n, countBefore, 'the raw window was regenerated in place');
  // The cumulative counter stays monotonic through the rewritten rows.
  const rows = env.repos.readings.range(env.repos.loads.getByCode(SITE, 'fridge').id, '2026-01-01', '2027-01-01');
  for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i].energy_kwh >= rows[i - 1].energy_kwh - 1e-9, `row ${i}`);
  assert.throws(() => env.controls.simulateDeterioration({ loadCode: 'fridge', days: 1 }), DemoControlError);
});

test('demo control: leave the sign on tonight fires the off-hours alert', () => {
  const env = liveEnv();
  env.clock.advance(7 * HOUR + 30 * MIN); // 23:00 local
  const load = env.repos.loads.getByCode(SITE, 'sign');
  const evaluate = () => {
    const now = env.clock.now();
    const readings = recentReadings(env.repos, load.id, { from: iso(now - 20 * MIN), to: iso(now + MIN) });
    return domain.alerts.evaluateOffHoursAlert({
      load: { id: load.id, name: load.name, criticality: load.criticality }, readings, now,
      schedule: env.repos.sites.getSchedule(SITE).map((s) => ({ weekday: s.weekday, closed: Boolean(s.closed), opensAt: s.opens_at, closesAt: s.closes_at })),
      tariffs: [{ copPerKwh: 950, effectiveFrom: '2026-01-01' }],
    });
  };
  env.controls.leaveSignOn();
  const result = evaluate();
  assert.equal(result.fired, true, result.reason);
  assert.match(result.alert.message, /Letrero luminoso/);
});

test('demo control: disconnect and reconnect a module syncs its offline buffer without losing readings', () => {
  const env = liveEnv();
  for (const batch of env.fleet.tick()) env.ingestion.ingest(batch);
  env.controls.disconnectModule('MX-003');
  env.clock.advance(600 * MIN);
  for (const batch of env.fleet.tick()) env.ingestion.ingest(batch);
  assert.equal(env.fleet.bufferedCount('MX-003'), 600);
  assert.deepEqual(env.ingestion.refreshModuleStatuses().map((c) => c.moduleId), ['MX-003'], 'only the silent module goes inactive');
  const synced = env.controls.reconnectModule('MX-003');
  assert.deepEqual([synced.readingsBuffered, synced.stored, synced.lost], [600, 600, 0]);
  assert.equal(synced.message, 'Se sincronizaron 600 lecturas, 0 perdidas');
  assert.equal(env.repos.modules.get('MX-003').status, 'active');
});

test('demo control: generate 20 extra loads for the performance test', () => {
  const env = liveEnv();
  const started = process.hrtime.bigint();
  const first = env.controls.generateLoads({ count: 20 });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  console.log(`# generate 20 loads: ${seconds.toFixed(2)} s`);
  assert.equal(first.created, 20);
  assert.equal(env.repos.loads.listBySite(SITE).length, 31);
  assert.equal(env.repos.modules.listBySite(SITE).length, 31);
  const load = env.repos.loads.getByCode(SITE, 'extra-01');
  assert.equal(load.control_mode, 'monitor_only');
  assert.ok(env.repos.readings.range(load.id, '2026-01-01', '2027-01-01').length >= 2880);
  assert.ok(env.repos.readings.hourlyRange(load.id, '2026-01-01', '2027-01-01').length >= 100);
  // The new modules join the live fleet and report like any other.
  env.clock.advance(MIN);
  const batches = env.fleet.tick();
  const result = batches.map((b) => env.ingestion.ingest(b));
  assert.ok(result.every((r) => r.rejected.length === 0));
  // Numbering continues instead of colliding.
  assert.equal(env.controls.generateLoads({ count: 2 }).loadCodes.join(), 'extra-21,extra-22');
  assert.throws(() => env.controls.generateLoads({ count: 0 }), DemoControlError);
});

test('the scenario is restored from the stored seed, and anchored at now when never seeded', () => {
  const seeded = loadDemoScenario({ repos: shared.repos, clock: shared.clock });
  assert.equal(seeded.seeded, true);
  assert.equal(seeded.anchorMs, ANCHOR);
  const fresh = createTestEnv({ mainSite: false });
  const unseeded = loadDemoScenario({ repos: fresh.repos, clock: fresh.clock });
  assert.equal(unseeded.seeded, false);
  assert.equal(unseeded.anchorMs, ANCHOR);
});
