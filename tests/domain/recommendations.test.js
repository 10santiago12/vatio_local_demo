const { test } = require('node:test');
const assert = require('node:assert/strict');
const rec = require('../../backend/domain/recommendations');
const { computeBaseline } = require('../../backend/domain/baseline');
const { series, at, OFFSET } = require('./helpers');

const TARIFFS = [{ copPerKwh: 1000, effectiveFrom: '2026-01-01' }];
const NOW = at('2026-03-15', '10:00');
// Same hours every day so that fixtures do not depend on the Sunday schedule.
const WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, closed: false, opensAt: '06:00', closesAt: '20:00' }));
const SWITCH_OFF = ['off_hours_shutdown', 'schedule', 'reduce_standby'];
const isNight = (hour) => hour >= 20 || hour < 6;
const isOpen = (hour) => hour >= 6 && hour < 20;

function entry(load, readings, extra = {}) {
  return { load, readings, baseline: computeBaseline(readings, { asOf: NOW, offsetMinutes: OFFSET }), ...extra };
}
const days = 15; // Mar 1 - Mar 15
const LOADS = {
  sign: entry({ id: 1, name: 'Letrero luminoso', criticality: 'non_essential' }, series('2026-03-01', days, ({ hour }) => (isNight(hour) ? 250 : 0))),
  ac: entry({ id: 2, name: 'Aire acondicionado', criticality: 'non_essential' },
    series('2026-03-01', days, ({ hour, dayIndex }) => ((hour >= 14 && hour < 18) || (hour >= 20 && hour < 22 && dayIndex % 7 < 3) ? 1200 : 0))),
  freezer: entry({ id: 3, name: 'Congelador', criticality: 'critical', typicalPowerW: 350 },
    series('2026-03-01', days, ({ minute }) => (minute % 30 < 10 ? 350 : 5)),
    { maintenanceAlert: { type: 'maintenance', excessPct: 18, projectedMonthlyCostCop: 20000 } }),
  coffee: entry({ id: 4, name: 'Cafetera industrial', criticality: 'essential' },
    series('2026-03-01', days, ({ hour }) => (isOpen(hour) ? (hour < 8 ? 2000 : 150) : 150))),
  mixer: entry({ id: 5, name: 'Batidora nueva', criticality: 'essential' }, series('2026-03-12', 3, ({ hour }) => (isNight(hour) ? 700 : 0))),
  oven: entry({ id: 6, name: 'Horno', criticality: 'essential', typicalPowerW: 1000 }, series('2026-03-01', days, ({ hour }) => (isOpen(hour) ? 1500 : 0))),
  pos: entry({ id: 7, name: 'Computador / POS', criticality: 'critical', typicalPowerW: 100 }, series('2026-03-01', days, () => 160)),
};
const run = (entries, extra = {}) => rec.generateRecommendations({ loads: entries, schedule: WEEK, tariffs: TARIFFS, now: NOW, offsetMinutes: OFFSET, ...extra });
const all = run(Object.values(LOADS));
const byLoad = (id) => all.filter((r) => r.loadId === id);

test('recommendations are sorted by score, highest first', () => {
  assert.ok(all.length >= 5);
  for (let i = 1; i < all.length; i += 1) assert.ok(all[i - 1].score >= all[i].score, `${i}`);
  assert.deepEqual(run(Object.values(LOADS)).map((r) => r.score), all.map((r) => r.score)); // deterministic
});

test('no recommendation ever switches off a critical load (hard rule)', () => {
  const critical = all.filter((r) => r.criticality === 'critical');
  assert.ok(critical.length >= 2);
  for (const r of critical) assert.ok(['maintenance_review', 'replacement'].includes(r.type), r.type);
  assert.equal(all.filter((r) => r.criticality === 'critical' && SWITCH_OFF.includes(r.type)).length, 0);
  // The critical freezer consumes 24 hours a day: nothing about shutting it down may appear.
  assert.deepEqual(byLoad(3).map((r) => r.type), ['maintenance_review']);
});

test('the safety predicate allows only review or replacement for critical loads', () => {
  for (const type of SWITCH_OFF) {
    assert.equal(rec.isRecommendationAllowed('critical', type), false, type);
    assert.equal(rec.isRecommendationAllowed('essential', type), true);
    assert.equal(rec.isRecommendationAllowed('non_essential', type), true);
  }
  assert.equal(rec.isRecommendationAllowed('critical', 'maintenance_review'), true);
  assert.equal(rec.isRecommendationAllowed('critical', 'replacement'), true);
});

test('loads whose baseline is building get no recommendations', () => {
  assert.equal(LOADS.mixer.baseline.status, 'building');
  assert.equal(byLoad(5).length, 0);
});

test('off-hours waste: every day -> shutdown, some days -> schedule, with the stated assumption', () => {
  const [sign] = byLoad(1);
  assert.equal(sign.type, 'off_hours_shutdown');
  assert.equal(sign.monthlySavingsKwh, 75); // 10 h * 0.25 kW * 30 days
  assert.equal(sign.monthlySavingsCop, 75000);
  assert.match(sign.assumption, /^Supuesto: se ahorra el consumo promedio fuera de horario \(2,5 kWh al día en los últimos 14 días\) × 30 días × tarifa de \$ 1\.000 por kWh\.$/);
  assert.match(sign.title, /Apagar Letrero luminoso/);
  const [ac] = byLoad(2);
  assert.equal(ac.type, 'schedule');
  assert.ok(ac.evidence.offHoursDayShare < 0.5);
  assert.ok(ac.monthlySavingsCop > 0);
});

test('standby reduction assumes half of the standby energy is removed', () => {
  const standby = byLoad(4).find((r) => r.type === 'reduce_standby');
  assert.ok(standby);
  assert.ok(Math.abs(standby.monthlySavingsKwh - 27) < 0.01); // 12 h * 0.15 kW * 30 * 0.5
  const off = byLoad(4).find((r) => r.type === 'off_hours_shutdown');
  assert.ok(Math.abs(off.monthlySavingsKwh - 45) < 0.01); // 10 h * 0.15 kW * 30
});

test('maintenance review comes from the predictive alert; replacement from persistent excess over rated power', () => {
  const [review] = byLoad(3);
  assert.equal(review.type, 'maintenance_review');
  assert.equal(review.monthlySavingsKwh, 20);
  const oven = byLoad(6);
  assert.deepEqual(oven.map((r) => r.type), ['replacement']);
  assert.ok(Math.abs(oven[0].monthlySavingsKwh - 210) < 0.01);
  assert.match(oven[0].assumption, /potencia nominal \(1\.000 W\)/);
  // A critical load may be reviewed or replaced, never switched off.
  assert.deepEqual(byLoad(7).map((r) => r.type), ['replacement']);
});

test('score = normalized savings x criticality factor x confidence', () => {
  const factor = { non_essential: 1, essential: 0.6, critical: 0.3 };
  for (const r of all) {
    assert.equal(r.criticalityFactor, factor[r.criticality]);
    assert.equal(r.score, Math.round((r.normalizedSavings * r.criticalityFactor * r.confidence + Number.EPSILON) * 100) / 100);
    assert.ok(r.normalizedSavings >= 0 && r.normalizedSavings <= 100);
    assert.ok(r.confidence > 0 && r.confidence <= 1);
  }
  assert.equal(Math.max(...all.map((r) => r.normalizedSavings)), 100);
});

test('scoreExplanation spells out the three factors in Spanish', () => {
  const [top] = all;
  assert.match(top.scoreExplanation, /^Puntaje [\d.,]+ = ahorro normalizado [\d.,]+ \(de 100\) × factor de criticidad [\d,]+ \((no esencial|esencial|crítico)\) × confianza [\d,]+\.$/);
});

test('scoreRecommendation edge cases: zero, clamping, unknown criticality, rounding', () => {
  assert.equal(rec.scoreRecommendation({ monthlySavingsCop: 0, maxSavingsCop: 0, criticality: 'non_essential', confidence: 1 }).score, 0);
  assert.equal(rec.scoreRecommendation({ monthlySavingsCop: 500, maxSavingsCop: 100, criticality: 'non_essential', confidence: 1 }).normalizedSavings, 100);
  assert.equal(rec.scoreRecommendation({ monthlySavingsCop: -5, maxSavingsCop: 100, criticality: 'essential', confidence: 1 }).normalizedSavings, 0);
  assert.equal(rec.scoreRecommendation({ monthlySavingsCop: 50, maxSavingsCop: 100, criticality: 'critical', confidence: 2 }).confidence, 1);
  assert.equal(rec.scoreRecommendation({ monthlySavingsCop: 50, maxSavingsCop: 100, criticality: 'critical', confidence: 1 }).score, 15);
  assert.equal(rec.scoreRecommendation({ monthlySavingsCop: 80, maxSavingsCop: 100, criticality: 'essential', confidence: 0.5 }).score, 24);
  assert.equal(rec.scoreRecommendation({ monthlySavingsCop: 80, maxSavingsCop: 100, criticality: 'weird', confidence: 1 }).criticalityFactor, 0.6);
});

test('confidence grows with the days of evidence', () => {
  assert.equal(rec.confidenceFromDays(7), 0.4);
  assert.equal(rec.confidenceFromDays(0), 0.4);
  assert.equal(rec.confidenceFromDays(30), 1);
  assert.equal(rec.confidenceFromDays(100), 1);
  assert.ok(rec.confidenceFromDays(14) > 0.4 && rec.confidenceFromDays(14) < 1);
});

test('empty inputs and missing tariff', () => {
  assert.deepEqual(run([]), []);
  assert.throws(() => run(Object.values(LOADS), { tariffs: [] }), RangeError);
  const quiet = entry({ id: 9, name: 'Televisor', criticality: 'non_essential' }, series('2026-03-01', days, ({ hour }) => (isOpen(hour) ? 110 : 0)));
  assert.deepEqual(run([quiet]), []); // nothing wasted: nothing to recommend
});

test('analyzeUsage measures off-hours and standby energy; empty readings give zeros', () => {
  const u = rec.analyzeUsage({ readings: LOADS.sign.readings, schedule: WEEK, now: NOW, offsetMinutes: OFFSET });
  assert.equal(u.sampleDays, 14);
  assert.ok(Math.abs(u.offHoursKwhPerDay - 2.5) < 1e-6);
  assert.equal(u.offHoursDayShare, 1);
  const empty = rec.analyzeUsage({ readings: [], schedule: WEEK, now: NOW });
  assert.deepEqual(empty, { sampleDays: 0, offHoursKwhPerDay: 0, offHoursDayShare: 0, standbyKwhPerDay: 0, meanOperatingW: 0, operatingShare: 0 });
});
