const { test } = require('node:test');
const assert = require('node:assert/strict');
const alerts = require('../../backend/domain/alerts');
const { computeBaseline } = require('../../backend/domain/baseline');
const { series, at, SCHEDULE, OFFSET } = require('./helpers');
const { MS_PER_MINUTE } = require('../../backend/domain/time');

const TARIFFS = [{ copPerKwh: 1000, effectiveFrom: '2026-01-01' }];
const LOAD = { id: 1, name: 'Horno', criticality: 'essential' };
const FLAT = () => 100; // baseline: 100 W all day
const history = series('2026-03-01', 10, FLAT); // Mar 1-10
const NOW = at('2026-03-11', '10:00'); // Wednesday, open
const baseline = computeBaseline(history, { asOf: NOW, offsetMinutes: OFFSET });

/** Per-minute readings from now-minutes to now (inclusive). */
function window(now, minutes, powerFn) {
  const end = Date.parse(now);
  return Array.from({ length: minutes + 1 }, (_, i) => {
    const ts = end - (minutes - i) * MS_PER_MINUTE;
    return { ts, powerW: typeof powerFn === 'function' ? powerFn(ts, i) : powerFn };
  });
}
const consumption = (readings, extra = {}) => alerts.evaluateConsumptionAlert({ load: LOAD, baseline, readings, tariffs: TARIFFS, now: NOW, offsetMinutes: OFFSET, ...extra });

test('baseline sanity for the fixtures', () => {
  assert.equal(baseline.status, 'ready');
});

test('consumption: 30 % over the baseline sustained for 15 minutes fires', () => {
  const r = consumption(window(NOW, 15, 130));
  assert.equal(r.fired, true);
  assert.equal(r.alert.type, 'consumption');
  assert.equal(r.alert.loadId, 1);
  assert.equal(r.alert.excessPct, 30);
});

test('consumption: 29 % does not fire', () => {
  const r = consumption(window(NOW, 15, 129));
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'below_threshold');
});

test('consumption: 40 % injected anomaly reports percentage, cost per hour, monthly projection and Spanish text', () => {
  const r = consumption(window(NOW, 15, 140));
  assert.equal(r.alert.excessPct, 40);
  assert.equal(r.alert.excessCostPerHourCop, 40); // 40 W = 0.04 kW * 1000 COP
  assert.equal(r.alert.projectedMonthlyCostCop, 40 * 720);
  assert.equal(r.alert.detectedAt, '2026-03-11T15:00:00.000Z');
  assert.match(r.alert.message, /Horno está gastando 40 % más de lo normal/);
  assert.match(r.alert.message, /\$ 40 más por hora/);
  assert.equal(r.alert.details.windowMinutes, 15);
});

test('consumption: the whole window must satisfy the condition (one calm minute cancels it)', () => {
  const calmInTheMiddle = window(NOW, 15, (ts, i) => (i === 7 ? 100 : 160));
  assert.equal(consumption(calmInTheMiddle).fired, false);
  const onlyLastTenMinutes = window(NOW, 15, (ts, i) => (i < 6 ? 100 : 160));
  assert.equal(consumption(onlyLastTenMinutes).fired, false);
});

test('consumption: data that does not cover the window is insufficient, not an alert', () => {
  assert.equal(consumption(window(NOW, 5, 200)).reason, 'insufficient_data');
  assert.equal(consumption([]).reason, 'insufficient_data');
  const hole = window(NOW, 15, 200).filter((r, i) => i < 5 || i > 10);
  assert.equal(consumption(hole).reason, 'insufficient_data');
});

test('consumption: window and threshold are configurable', () => {
  const tenMinutes = window(NOW, 10, 140);
  assert.equal(consumption(tenMinutes).fired, false); // default 15-minute window is not covered
  assert.equal(consumption(tenMinutes, { windowMinutes: 10 }).fired, true);
  assert.equal(consumption(window(NOW, 15, 115), { thresholdPct: 10 }).fired, true);
  assert.equal(consumption(window(NOW, 15, 115), { thresholdPct: 20 }).fired, false);
});

test('consumption: each reading is compared with the baseline of its own hour', () => {
  const stepped = series('2026-03-01', 10, ({ hour }) => (hour === 9 ? 200 : 100));
  const b = computeBaseline(stepped, { asOf: NOW, offsetMinutes: OFFSET });
  const now = at('2026-03-11', '10:05');
  const crossing = window(now, 15, 140); // 09:50-10:05: 140 W is below 200 * 1.3 in the 9 o'clock slot
  const r = alerts.evaluateConsumptionAlert({ load: LOAD, baseline: b, readings: crossing, tariffs: TARIFFS, now, offsetMinutes: OFFSET });
  assert.equal(r.fired, false);
});

test('consumption: a load whose baseline is building never gets deviation alerts', () => {
  const young = computeBaseline(series('2026-03-08', 3, FLAT), { asOf: NOW, offsetMinutes: OFFSET });
  assert.equal(young.status, 'building');
  const r = consumption(window(NOW, 15, 500), { baseline: young });
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'baseline_building');
  assert.equal(consumption(window(NOW, 15, 500), { baseline: null }).reason, 'baseline_building');
});

test('consumption: a ~0 W reference is left to the off-hours rule', () => {
  const zero = computeBaseline(series('2026-03-01', 10, () => 0), { asOf: NOW, offsetMinutes: OFFSET });
  assert.equal(consumption(window(NOW, 15, 300), { baseline: zero }).reason, 'no_reference');
});

test('consumption: missing tariff still alerts, without cost figures', () => {
  const r = consumption(window(NOW, 15, 150), { tariffs: [] });
  assert.equal(r.fired, true);
  assert.equal(r.alert.excessCostPerHourCop, null);
  assert.equal(r.alert.projectedMonthlyCostCop, null);
  assert.doesNotMatch(r.alert.message, /\$/);
});

// ----- off hours -----
const NIGHT = at('2026-03-11', '22:00'); // Wednesday, closed
const offHours = (readings, extra = {}) => alerts.evaluateOffHoursAlert({
  load: { id: 2, name: 'Letrero luminoso', criticality: 'non_essential' }, readings, schedule: SCHEDULE, tariffs: TARIFFS, now: NIGHT, offsetMinutes: OFFSET, ...extra,
});

test('off hours: a non-critical load consuming while the site is closed fires', () => {
  const r = offHours(window(NIGHT, 15, 250));
  assert.equal(r.fired, true);
  assert.equal(r.alert.type, 'off_hours');
  assert.equal(r.alert.excessCostPerHourCop, 250);
  assert.match(r.alert.message, /Letrero luminoso sigue consumiendo y el local está cerrado\. Te cuesta unos \$ [\d.]+ por noche/);
  assert.ok(r.alert.projectedMonthlyCostCop > 0);
});

test('off hours: essential loads count, critical loads never do', () => {
  assert.equal(offHours(window(NIGHT, 15, 150), { load: { id: 3, name: 'Cafetera', criticality: 'essential' } }).fired, true);
  const freezer = offHours(window(NIGHT, 15, 350), { load: { id: 4, name: 'Congelador', criticality: 'critical' } });
  assert.deepEqual([freezer.fired, freezer.reason], [false, 'critical_load']);
});

test('off hours: no alert during operating hours or when the window touches them', () => {
  assert.equal(offHours(window(NOW, 15, 250), { now: NOW }).reason, 'within_operating_hours');
  const closing = at('2026-03-11', '20:10'); // window starts 19:55, still open
  assert.equal(offHours(window(closing, 15, 250), { now: closing }).reason, 'within_operating_hours');
  const justClosed = at('2026-03-11', '20:15'); // window 20:00-20:15 is closed (closing is exclusive)
  assert.equal(offHours(window(justClosed, 15, 250), { now: justClosed }).fired, true);
});

test('off hours: standby below the minimum power or one quiet minute does not fire', () => {
  assert.equal(offHours(window(NIGHT, 15, 5)).reason, 'below_minimum_power'); // boundary: must be strictly above
  assert.equal(offHours(window(NIGHT, 15, 6)).fired, true);
  assert.equal(offHours(window(NIGHT, 15, (ts, i) => (i === 3 ? 0 : 250))).fired, false);
  assert.equal(offHours([]).reason, 'insufficient_data');
});

// ----- inactive module -----
const mod = (lastSeenAt) => ({ id: 'MX-7', loadId: 5, loadName: 'Congelador', lastSeenAt });

test('inactive module: silent for more than 2 minutes fires, exactly 2 does not', () => {
  const now = Date.parse(NOW);
  const run = (silentMs) => alerts.evaluateInactiveModuleAlert({ module: mod(now - silentMs), now });
  assert.equal(run(2 * 60000).fired, false);
  assert.equal(run(2 * 60000 + 1000).fired, true);
  assert.equal(run(0).reason, 'reporting');
  const r = run(3 * 60000);
  assert.equal(r.alert.type, 'inactive_module');
  assert.equal(r.alert.loadId, 5);
  assert.match(r.alert.message, /No estamos recibiendo datos de Congelador desde hace 3 minutos\. Revisa que esté conectado\./);
  assert.equal(r.alert.details.moduleId, 'MX-7');
});

test('inactive module: unknown heartbeat and anonymous modules', () => {
  assert.equal(alerts.evaluateInactiveModuleAlert({ module: mod(null), now: NOW }).reason, 'no_heartbeat_yet');
  const r = alerts.evaluateInactiveModuleAlert({ module: { id: 'MX-9', lastSeenAt: '2026-03-11T14:00:00Z' }, now: NOW });
  assert.equal(r.fired, true);
  assert.equal(r.alert.loadId, null);
  assert.match(r.alert.message, /el módulo MX-9/);
  assert.equal(alerts.evaluateInactiveModuleAlert({ module: mod(NOW), now: NOW, thresholdMinutes: 0 }).fired, false);
});

// ----- predictive maintenance -----
const cycle = ({ minute }) => (minute % 30 < 10 ? 350 : 5); // compressor on 10 of every 30 minutes
function freezer(days, recentFactor, recentFromDay) {
  return series('2026-03-01', days, (c) => cycle(c) * (c.dayIndex >= recentFromDay && cycle(c) > 100 ? recentFactor : 1));
}
const MNOW = '2026-04-15T04:59:00Z'; // 2026-04-14 23:59 local, day 45 of the series
const maintenance = (readings, extra = {}) => alerts.evaluateMaintenanceAlert({
  load: { id: 6, name: 'Congelador', criticality: 'critical' }, readings, tariffs: TARIFFS, now: MNOW, offsetMinutes: OFFSET, ...extra,
});

test('maintenance: +16 % operating power over 3 days with 45 days of history fires as its own type with a trend', () => {
  const r = maintenance(freezer(45, 1.16, 42));
  assert.equal(r.fired, true);
  assert.equal(r.alert.type, 'maintenance');
  assert.ok(r.alert.excessPct > 15 && r.alert.excessPct < 17);
  assert.equal(r.alert.details.kind, 'predictive_maintenance');
  assert.ok(r.alert.details.trend.length >= 3 && r.alert.details.trend.length <= 14);
  const last = r.alert.details.trend[r.alert.details.trend.length - 1];
  assert.ok(last.meanW > r.alert.details.historicalMeanW);
  assert.ok(r.alert.projectedMonthlyCostCop > 0);
  assert.match(r.alert.message, /Congelador usa \d+ % más energía cuando funciona/);
});

test('maintenance: +14 % does not fire', () => {
  const r = maintenance(freezer(45, 1.14, 42));
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'within_normal_range');
});

test('maintenance: exactly 15 % does not fire (strict comparison) and just above does', () => {
  const base = series('2026-03-01', 34, () => 100, 60);
  const lastTs = base.at(-1).ts;
  const recentFrom = lastTs - 3 * 86400000;
  const withFactor = (factor) => base.map((r) => ({ ts: r.ts, powerW: r.ts >= recentFrom ? 100 * factor : 100 }));
  const run = (factor) => alerts.evaluateMaintenanceAlert({ load: LOAD, readings: withFactor(factor), tariffs: TARIFFS, now: lastTs, offsetMinutes: OFFSET });
  assert.equal(run(1.15).fired, false);
  assert.equal(run(1.152).fired, true);
});

test('maintenance: needs at least 30 days of history', () => {
  const short = freezer(32, 1.3, 29); // 29 history days
  const r = maintenance(short, { now: '2026-04-02T04:59:00Z' });
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'insufficient_history');
  assert.ok(r.historyDays < 30);
  assert.equal(maintenance([]).reason, 'insufficient_history');
});

test('maintenance: needs data on the last 3 days and operating samples', () => {
  const stale = freezer(45, 1.3, 42).filter((r) => r.ts < Date.parse('2026-04-13T05:00:00Z'));
  assert.equal(maintenance(stale).reason, 'insufficient_recent');
  const idle = series('2026-03-01', 45, () => 0);
  assert.equal(maintenance(idle).reason, 'no_operating_data');
});

test('maintenance: threshold and recent window are configurable', () => {
  const data = freezer(45, 1.1, 42);
  assert.equal(maintenance(data).fired, false);
  assert.equal(maintenance(data, { thresholdPct: 5 }).fired, true);
});

// ----- all rules together -----
test('detectAlerts runs every rule, skips building loads for deviation and reports inactive modules', () => {
  const now = at('2026-03-11', '22:00');
  const loads = [
    { id: 1, name: 'Horno', criticality: 'essential' },
    { id: 2, name: 'Batidora', criticality: 'essential' },
    { id: 3, name: 'Letrero luminoso', criticality: 'non_essential' },
  ];
  const readingsByLoad = {
    1: [...history, ...window(now, 15, 300)],
    2: [...series('2026-03-08', 3, FLAT), ...window(now, 15, 900)],
    3: window(now, 15, 250),
  };
  // At 22:00 the baseline hour is 100 W for the oven, so 300 W is +200 %.
  const out = alerts.detectAlerts({
    loads, modules: [{ id: 'MX-1', loadId: 3, loadName: 'Letrero luminoso', lastSeenAt: '2026-03-12T02:50:00Z' }],
    readingsByLoad, baselines: {}, schedule: SCHEDULE, tariffs: TARIFFS, now, offsetMinutes: OFFSET,
  });
  const summary = out.map((a) => `${a.loadId}:${a.type}`);
  assert.ok(summary.includes('1:consumption'));
  assert.ok(summary.includes('1:off_hours')); // non-critical and closed
  assert.ok(!summary.includes('2:consumption')); // baseline building
  assert.ok(summary.includes('2:off_hours')); // off-hours is not a deviation alert
  assert.ok(summary.includes('3:off_hours'));
  assert.ok(summary.includes('3:inactive_module'));
});

test('detectAlerts with nothing to evaluate returns an empty list', () => {
  assert.deepEqual(alerts.detectAlerts({ loads: [], readingsByLoad: {}, schedule: SCHEDULE, tariffs: TARIFFS, now: NOW }), []);
  const quiet = alerts.detectAlerts({ loads: [LOAD], readingsByLoad: {}, schedule: SCHEDULE, tariffs: TARIFFS, now: NOW });
  assert.deepEqual(quiet, []);
});
