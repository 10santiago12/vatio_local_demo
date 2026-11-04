const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildScenario } = require('../../backend/adapters/simulator/scenario');
const { generateHistory } = require('../../backend/adapters/simulator/history');
const { createEngine } = require('../../backend/adapters/simulator/engine');
const { createRng } = require('../../backend/adapters/simulator/prng');
const { buildAnalyticsSeries } = require('../../backend/app/series');
const domain = require('../../backend/domain');

// Wednesday 2026-03-11 15:30 in Bogota (UTC-5).
const ANCHOR = Date.parse('2026-03-11T20:30:00.000Z');
const MIN = 60000;
const TARIFFS = [{ copPerKwh: 950, effectiveFrom: '2026-01-01' }];
const hourOf = (ms) => Math.floor(ms / 3600000) * 3600000;

let scenario;
let history; // code -> {raw: [], hourly: []}
let counts;

function collect(sc, loads = sc.loads) {
  const out = {};
  const bucket = (code) => out[code] || (out[code] = { raw: [], hourly: [] });
  const c = generateHistory({
    engine: sc.engine, loads, endMs: ANCHOR, rawFromMs: sc.rawFromMs,
    sink: { raw: (code, r) => bucket(code).raw.push(r), hourly: (code, h) => bucket(code).hourly.push(h) },
  });
  return { out, counts: c };
}

/** Domain-ready series of a load from generated rows. */
function analytics(rows) {
  return buildAnalyticsSeries(
    rows.hourly.map((h) => ({ ts: Date.parse(h.hourStart), powerW: h.avgPowerW })),
    rows.raw.map((r) => ({ ts: Date.parse(r.ts), powerW: r.powerW })),
  );
}

before(() => {
  scenario = buildScenario({ anchorMs: ANCHOR });
  ({ out: history, counts } = collect(scenario));
});

test('prng: same seed gives the same values, in any order; different seeds differ', () => {
  const a = createRng(7);
  const b = createRng(7);
  const keys = ['x', 'y', 'z', 'sign|2026-03-01|all_night'];
  const forward = keys.map((k) => a.unit(k));
  const backward = keys.slice().reverse().map((k) => b.unit(k)).reverse();
  assert.deepEqual(forward, backward);
  assert.notDeepEqual(forward, keys.map((k) => createRng(8).unit(k)));
  assert.ok(forward.every((v) => v >= 0 && v < 1));
  const s1 = createRng('seed').sequence('stream');
  const s2 = createRng('seed').sequence('stream');
  assert.deepEqual([s1(), s1(), s1()], [s2(), s2(), s2()]);
});

test('determinism: the same seed reproduces the whole history, another seed does not', () => {
  const digest = (sc) => {
    const { out } = collect(sc);
    return crypto.createHash('sha256').update(JSON.stringify(out)).digest('hex');
  };
  const first = digest(buildScenario({ anchorMs: ANCHOR }));
  assert.equal(first, digest(buildScenario({ anchorMs: ANCHOR })));
  assert.notEqual(first, digest(buildScenario({ anchorMs: ANCHOR, seed: 99 })));
});

test('history shape: 1-minute readings only in the last 2 days, hourly aggregates before', () => {
  const freezer = history.freezer;
  const rawMinutes = (ANCHOR - scenario.rawFromMs) / MIN + 1;
  assert.equal(freezer.raw.length, Math.floor(rawMinutes));
  assert.ok(freezer.raw.length >= 2880 && freezer.raw.length <= 2880 + 60);
  assert.ok(freezer.raw.every((r) => Date.parse(r.ts) >= scenario.rawFromMs));
  assert.ok(freezer.hourly.every((h) => Date.parse(h.hourStart) < scenario.rawFromMs));
  // Hourly rows cover every hour from the history start to the raw window, exactly once.
  const hours = (scenario.rawFromMs - scenario.historyStartMs) / 3600000;
  assert.equal(freezer.hourly.length, hours);
  assert.equal(new Set(freezer.hourly.map((h) => h.hourStart)).size, hours);
  assert.ok(freezer.hourly.every((h) => h.samples === 60 && h.maxPowerW >= h.avgPowerW && h.energyKwh > 0));
  // 45 complete local days before today plus the partial day of the anchor.
  assert.equal((scenario.historyStartMs), Date.parse('2026-01-25T05:00:00.000Z'));
  assert.equal(counts.raw + counts.hourly > 0, true);
});

test('electrical model: V about 120 +-2 %, I = P / V, cumulative kWh grows with the integral of P', () => {
  const rows = history.oven.raw;
  for (const r of rows) {
    assert.ok(r.voltageV >= 117.5 && r.voltageV <= 122.5, `voltage ${r.voltageV}`);
    assert.ok(Math.abs(r.currentA - r.powerW / r.voltageV) <= 0.002 + r.currentA * 1e-4);
  }
  for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i].energyKwh >= rows[i - 1].energyKwh);
  // Counter at the end = integral of every minute since the history start (hourly part + raw part).
  const hourlyKwh = history.oven.hourly.reduce((s, h) => s + h.energyKwh, 0);
  const rawKwh = rows.reduce((s, r) => s + r.powerW / 60 / 1000, 0);
  assert.ok(Math.abs(rows[rows.length - 1].energyKwh - (hourlyKwh + rawKwh)) < 0.01);
});

test('catalogue: 11 loads with the spec powers, criticality and control modes', () => {
  const profiles = scenario.engine.profiles();
  assert.equal(profiles.length, 11);
  const by = Object.fromEntries(profiles.map((p) => [p.code, p]));
  assert.deepEqual([by.freezer.typicalPowerW, by.oven.typicalPowerW, by.coffee.typicalPowerW, by.ac.typicalPowerW, by.sign.typicalPowerW, by.tv.typicalPowerW, by.whisk.typicalPowerW],
    [350, 6000, 2000, 1200, 250, 110, 700]);
  assert.equal(by.freezer.criticality, 'critical');
  assert.equal(by.oven.controlMode, 'monitor_only');
  assert.equal(by.coffee.controlMode, 'control_enabled');
  assert.equal(by.sign.criticality, 'non_essential');
  const manufacturers = new Set(profiles.map((p) => p.manufacturer));
  assert.equal(manufacturers.size, 2);
  const modules = profiles.map((p) => p.moduleId);
  assert.equal(new Set(modules).size, 11);
  // Oven peaks near 6000 W and the coffee machine keeps 150 W standby when not brewing.
  assert.ok(Math.max(...history.oven.raw.map((r) => r.powerW)) > 5800);
  assert.ok(history.coffee.hourly.some((h) => h.avgPowerW > 100 && h.avgPowerW < 200), 'night standby of the coffee machine');
});

test('the new mixer has only 3 days of data, so its baseline is building (day 3 of 7)', () => {
  const whisk = history.whisk;
  const first = Date.parse((whisk.hourly[0] || whisk.raw[0]).hourStart || whisk.raw[0].ts);
  assert.equal(first, Date.parse('2026-03-08T05:00:00.000Z'));
  const baseline = domain.baseline.computeBaseline(analytics(whisk), { asOf: ANCHOR, maxGapMs: 10 * MIN });
  assert.equal(baseline.status, 'building');
  assert.equal(baseline.dayN, 3);
  assert.match(baseline.message, /día 3 de 7/);
  const freezerBaseline = domain.baseline.computeBaseline(analytics(history.freezer), { asOf: ANCHOR, maxGapMs: 10 * MIN });
  assert.equal(freezerBaseline.status, 'ready');
  assert.equal(freezerBaseline.dayN, 45);
});

test('freezer deterioration of the last 5 days makes the domain maintenance alert fire', () => {
  const freezer = domain.alerts.evaluateMaintenanceAlert({
    load: { id: 1, name: 'Congelador vertical' }, readings: analytics(history.freezer), tariffs: TARIFFS, now: ANCHOR,
  });
  assert.equal(freezer.fired, true);
  assert.equal(freezer.alert.type, 'maintenance');
  assert.ok(freezer.alert.excessPct > 15 && freezer.alert.excessPct < 25, `excess ${freezer.alert.excessPct}`);
  // Healthy equipment does not fire.
  const fridge = domain.alerts.evaluateMaintenanceAlert({
    load: { id: 2, name: 'Nevera exhibidora' }, readings: analytics(history.fridge), tariffs: TARIFFS, now: ANCHOR,
  });
  assert.equal(fridge.fired, false);
});

test('simulate deterioration on another load (demo control) fires the maintenance alert for it', () => {
  const sc = buildScenario({ anchorMs: ANCHOR });
  sc.engine.modifiers.add({ kind: 'deterioration', loadCode: 'fridge', startMs: hourOf(ANCHOR - 5 * 86400000), rampMs: 36 * 3600000, factor: 0.18 });
  const { out } = collect(sc, sc.loads.filter((l) => l.code === 'fridge'));
  const r = domain.alerts.evaluateMaintenanceAlert({ load: { id: 2, name: 'Nevera exhibidora' }, readings: analytics(out.fridge), tariffs: TARIFFS, now: ANCHOR });
  assert.equal(r.fired, true);
});

test('anomaly injection followed by the domain consumption alert reports the right excess', () => {
  // [load, percent, instant]: each load is in use at that local time of a workday (oven peak: 08:30).
  for (const [code, pct, at] of [['tv', 60, '2026-03-11T15:30:00.000Z'], ['warmer', 50, '2026-03-11T15:30:00.000Z'], ['oven', 45, '2026-03-11T13:30:00.000Z']]) {
    const sc = buildScenario({ anchorMs: ANCHOR });
    const now = Date.parse(at);
    const start = now - 20 * MIN;
    sc.engine.modifiers.add({ kind: 'anomaly', loadCode: code, startMs: start, endMs: now + MIN, pct });
    const { out } = collect(sc, sc.loads.filter((l) => l.code === code));
    const baseline = domain.baseline.computeBaseline(analytics(out[code]), { asOf: ANCHOR, maxGapMs: 10 * MIN });
    const readings = [];
    for (let ts = now - 20 * MIN; ts <= now; ts += MIN) readings.push({ ts, powerW: sc.engine.sample(code, ts).powerW });
    const r = domain.alerts.evaluateConsumptionAlert({ load: { id: 1, name: code }, baseline, readings, tariffs: TARIFFS, now });
    assert.equal(r.fired, true, `${code} alert (${r.reason})`);
    assert.ok(Math.abs(r.alert.excessPct - pct) < 12, `${code}: expected about ${pct} %, got ${r.alert.excessPct}`);
    assert.ok(r.alert.projectedMonthlyCostCop > 0);
  }
});

test('without an anomaly the normal day produces no consumption alerts (cycling is not a deviation)', () => {
  const noWaste = ['tv', 'fridge', 'freezer', 'oven', 'pos', 'mixer', 'coffee'];
  for (const code of noWaste) {
    const baseline = domain.baseline.computeBaseline(analytics(history[code]), { asOf: ANCHOR, maxGapMs: 10 * MIN });
    const raw = history[code].raw.map((r) => ({ ts: Date.parse(r.ts), powerW: r.powerW }));
    for (let ts = scenario.rawFromMs + 3600000; ts <= ANCHOR; ts += 15 * MIN) {
      const window = raw.filter((r) => r.ts <= ts && r.ts >= ts - 20 * MIN);
      const r = domain.alerts.evaluateConsumptionAlert({ load: { id: 1, name: code }, baseline, readings: window, tariffs: TARIFFS, now: ts });
      assert.equal(r.fired, false, `${code} at ${new Date(ts).toISOString()}`);
    }
  }
});

test('natural waste patterns are detectable: sign all night, AC after closing, coffee standby at night', () => {
  const closedAt = (code, dayOffset, loadName = code, utcHour = 4) => {
    // Local night of the given day offset: 04:00 UTC = 23:00 local; 02:00 UTC = 21:00 local.
    const ts = Date.parse('2026-03-11T00:00:00.000Z') + utcHour * 3600000 - dayOffset * 86400000;
    const readings = [];
    for (let t = ts - 15 * MIN; t <= ts; t += MIN) readings.push({ ts: t, powerW: scenario.engine.sample(code, t).powerW });
    return domain.alerts.evaluateOffHoursAlert({ load: { id: 1, name: loadName, criticality: 'non_essential' }, readings, schedule: scenario.engine.schedule, tariffs: TARIFFS, now: ts });
  };
  const nights = Array.from({ length: 44 }, (_, i) => i + 1);
  const fired = (code, from, to, utcHour) => nights.filter((n) => n >= from && n <= to).filter((n) => closedAt(code, n, code, utcHour).fired).length;
  const total = (from, to) => nights.filter((n) => n >= from && n <= to).length;
  // The sign stays on some nights, not all of them.
  const signNights = fired('sign', 1, 44);
  assert.ok(signNights >= 4 && signNights < 25, `sign nights ${signNights}`);
  // The AC is left on after closing on some days.
  const acNights = fired('ac', 1, 44, 2); // 21:00 local, an hour after closing
  assert.ok(acNights >= 1 && acNights <= 20, `ac nights ${acNights}`);
  // Coffee standby: every night before the recommendation was accepted (22 days ago), never after.
  assert.equal(fired('coffee', 24, 44), total(24, 44));
  assert.equal(fired('coffee', 1, 20), 0);
  // The standby draw is the 150 W of the spec.
  assert.ok(Math.abs(scenario.engine.sample('coffee', Date.parse('2026-02-10T04:00:00.000Z')).powerW - 150) < 4);
});

test('leave the sign on tonight (demo control): off-hours alert on a night it is normally off', () => {
  const sc = buildScenario({ anchorMs: ANCHOR });
  const probe = (ts) => {
    const readings = [];
    for (let t = ts - 15 * MIN; t <= ts; t += MIN) readings.push({ ts: t, powerW: sc.engine.sample('sign', t).powerW });
    return domain.alerts.evaluateOffHoursAlert({ load: { id: 1, name: 'Letrero luminoso', criticality: 'non_essential' }, readings, schedule: sc.engine.schedule, tariffs: TARIFFS, now: ts });
  };
  // First night after the anchor on which the sign is normally off at 23:00 local (04:00 UTC next day).
  let night = null;
  for (let d = 0; d < 30 && night === null; d += 1) {
    const ts = Date.parse('2026-03-12T04:00:00.000Z') + d * 86400000;
    if (!probe(ts).fired) night = ts;
  }
  assert.notEqual(night, null);
  sc.engine.modifiers.add({ kind: 'force_on', loadCode: 'sign', startMs: night - 4 * 3600000, endMs: night + 7 * 3600000, powerW: 250 });
  const after = probe(night);
  assert.equal(after.fired, true);
  assert.match(after.alert.message, /Letrero luminoso/);
});

test('accepted recommendations: the coffee standby saving is conclusive, the sign timer is not', () => {
  const results = {};
  for (const rec of scenario.acceptedRecommendations) {
    assert.ok(ANCHOR - rec.acceptedAtMs > 7 * 86400000, 'accepted more than 7 days ago');
    const series = analytics(history[rec.loadCode]);
    const baseline = domain.baseline.computeBaseline(series, { asOf: rec.acceptedAtMs, maxGapMs: 10 * MIN });
    assert.equal(baseline.status, 'ready');
    results[rec.loadCode] = domain.savings.attributableSavings({ recommendation: { acceptedAt: rec.acceptedAtMs }, readings: series, baseline, tariffs: TARIFFS, now: ANCHOR });
  }
  assert.equal(results.coffee.status, 'conclusive');
  assert.equal(results.coffee.direction, 'saving');
  assert.equal(results.sign.status, 'inconclusive');
});

test('extra sites: aggregated hourly history only, with their own schedule and trend', () => {
  assert.deepEqual(scenario.extraSites.map((s) => s.id), ['la-espiga-cajica', 'la-espiga-zipaquira']);
  const rows = {};
  for (const site of scenario.extraSites) {
    const hourly = [];
    let raw = 0;
    generateHistory({
      engine: site.engine, loads: site.loads, endMs: ANCHOR, rawFromMs: scenario.rawFromMs, stepMinutes: scenario.extraStepMinutes,
      sink: { raw: () => { raw += 1; }, hourly: (code, h) => hourly.push({ code, ...h }) },
    });
    rows[site.id] = { hourly, raw };
    assert.ok(hourly.length > 6 * 44 * 24 - 6 * 48);
    assert.ok(hourly.every((h) => h.samples === 12));
  }
  // The trend: Cajica ends lower than it started (improving), Zipaquira about flat or slightly higher.
  const dayKwh = (site, from, to) => rows[site].hourly.filter((h) => h.code === 'oven' && h.hourStart >= from && h.hourStart < to).reduce((s, h) => s + h.energyKwh, 0);
  const early = dayKwh('la-espiga-cajica', '2026-01-26', '2026-02-02');
  const late = dayKwh('la-espiga-cajica', '2026-03-01', '2026-03-08');
  assert.ok(late < early, `Cajica ${early} -> ${late}`);
  // Zipaquira is closed on Sundays: a Sunday (2026-03-01) oven draws only its idle watt.
  const sunday = rows['la-espiga-zipaquira'].hourly.filter((h) => h.code === 'oven' && h.hourStart.startsWith('2026-03-01T1'));
  assert.ok(sunday.every((h) => h.avgPowerW < 5));
});

test('engine rejects unknown loads and is independent of call order', () => {
  const e1 = createEngine({ seed: 5 });
  const e2 = createEngine({ seed: 5 });
  assert.throws(() => e1.sample('toaster', ANCHOR), RangeError);
  const a = [e1.sample('oven', ANCHOR), e1.sample('freezer', ANCHOR - MIN), e1.sample('oven', ANCHOR + MIN)];
  const b = [e2.sample('oven', ANCHOR + MIN), e2.sample('freezer', ANCHOR - MIN), e2.sample('oven', ANCHOR)];
  assert.deepEqual([a[0], a[1], a[2]], [b[2], b[1], b[0]]);
});
