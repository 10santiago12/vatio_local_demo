const { test } = require('node:test');
const assert = require('node:assert/strict');
const sv = require('../../backend/domain/savings');
const { computeBaseline } = require('../../backend/domain/baseline');
const { series, at, OFFSET } = require('./helpers');

const TARIFFS = [{ copPerKwh: 1000, effectiveFrom: '2026-01-01' }];
const FLAT = () => 100; // 2.4 kWh per day
const calm = series('2026-03-01', 10, FLAT);
const ACCEPTED = at('2026-03-11', '09:00');
const acceptedDay = series('2026-03-11', 1, FLAT);
const flatBaseline = computeBaseline([...calm, ...acceptedDay], { asOf: ACCEPTED, offsetMinutes: OFFSET });
const attributable = (post, over = {}) => sv.attributableSavings({
  recommendation: { acceptedAt: ACCEPTED }, readings: [...calm, ...acceptedDay, ...post], baseline: flatBaseline, tariffs: TARIFFS,
  now: at('2026-03-20', '10:00'), offsetMinutes: OFFSET, ...over,
});

test('attributable: fewer than 7 days after acceptance is "measuring" with day N of 7', () => {
  const r = attributable(series('2026-03-12', 2, () => 60), { now: at('2026-03-14', '10:00') });
  assert.deepEqual([r.status, r.dayN, r.requiredDays], ['measuring', 3, 7]);
  assert.equal(r.message, 'En medición (día 3 de 7)');
  assert.equal(attributable([], { now: at('2026-03-11', '15:00') }).dayN, 1); // accepted today
  assert.equal(attributable([], { now: at('2026-03-18', '10:00') }).status, 'measuring'); // 6 complete days: day 7 in progress
  assert.equal(attributable([], { now: at('2026-03-18', '10:00') }).dayN, 7);
});

test('attributable: 7 complete days after acceptance gives a verdict', () => {
  const r = attributable(series('2026-03-12', 8, () => 60), { now: at('2026-03-19', '10:00') });
  assert.equal(r.status, 'conclusive');
  assert.equal(r.daysMeasured, 7);
});

test('attributable: a clear reduction is conclusive with kWh and COP of the affected load', () => {
  const r = attributable(series('2026-03-12', 9, () => 60)); // Mar 12-19 = 8 complete days
  assert.equal(r.status, 'conclusive');
  assert.equal(r.direction, 'saving');
  assert.ok(Math.abs(r.savingsKwh - 8 * 0.96) < 1e-6);
  assert.ok(Math.abs(r.savingsCop - 8 * 960) < 1e-3);
  assert.match(r.message, /Ahorro atribuible: 7,7 kWh \(\$ 7\.680\) en 8 días\./);
  assert.match(r.message, /factores externos \(clima, más clientes\) pueden influir/);
});

test('attributable: a clear increase is conclusive and described as such', () => {
  const r = attributable(series('2026-03-12', 9, () => 150));
  assert.equal(r.status, 'conclusive');
  assert.equal(r.direction, 'increase');
  assert.ok(r.savingsKwh < 0);
  assert.match(r.message, /El consumo subió/);
});

test('attributable: a difference within the uncertainty band is "No concluyente"', () => {
  const noisy = series('2026-03-01', 10, ({ dayIndex }) => 100 + (dayIndex % 2 ? 20 : -20));
  const baseline = computeBaseline(noisy, { asOf: ACCEPTED, offsetMinutes: OFFSET });
  const r = sv.attributableSavings({
    recommendation: { acceptedAt: ACCEPTED }, readings: [...noisy, ...series('2026-03-12', 9, () => 95)], baseline, tariffs: TARIFFS,
    now: at('2026-03-20', '10:00'), offsetMinutes: OFFSET,
  });
  assert.equal(r.status, 'inconclusive');
  assert.equal(r.reason, 'within_uncertainty_band');
  assert.ok(Math.abs(r.differenceKwh) <= r.bandKwh);
  assert.match(r.message, /^No concluyente/);
});

test('attributable: band boundary decides between inconclusive and conclusive', () => {
  const baseline = { status: 'ready', offsetMinutes: OFFSET, sigmas: 2, dailyStats: { workday: { n: 6, mean: 3.3, std: 0.2 }, sunday: { n: 6, mean: 3.3, std: 0.2 } } };
  const run = (watts) => sv.attributableSavings({
    recommendation: { acceptedAt: ACCEPTED }, readings: series('2026-03-12', 9, () => watts), baseline, tariffs: TARIFFS,
    now: at('2026-03-20', '10:00'), offsetMinutes: OFFSET,
  });
  assert.equal(run(125).status, 'inconclusive'); // 3.0 kWh/day: difference 0.3 < band 0.4
  assert.equal(run(120).status, 'conclusive'); // 2.88 kWh/day: difference 0.42 > band 0.4
});

test('attributable: too little data or a building baseline is "No concluyente" for lack of data', () => {
  const few = attributable(series('2026-03-12', 3, () => 60));
  assert.deepEqual([few.status, few.reason, few.daysMeasured], ['inconclusive', 'insufficient_data', 3]);
  const building = computeBaseline(series('2026-03-08', 3, FLAT), { asOf: ACCEPTED, offsetMinutes: OFFSET });
  const r = attributable(series('2026-03-12', 9, () => 60), { baseline: building });
  assert.deepEqual([r.status, r.reason], ['inconclusive', 'insufficient_data']);
  assert.equal(attributable([], { baseline: null }).reason, 'insufficient_data');
});

test('attributable: the window is capped at maxDays', () => {
  const r = attributable(series('2026-03-12', 20, () => 60), { now: at('2026-04-10', '10:00'), maxDays: 10 });
  assert.equal(r.daysMeasured, 10);
});

test('daily comparison skips days without readings', () => {
  const days = sv.compareDailyToBaseline({ readings: series('2026-03-12', 2, () => 60), baseline: flatBaseline, fromKey: '2026-03-12', toKey: '2026-03-16', offsetMinutes: OFFSET });
  assert.deepEqual(days.map((d) => d.date), ['2026-03-12', '2026-03-13']);
  assert.ok(Math.abs(days[0].baselineKwh - 2.4) < 0.01);
  assert.deepEqual(sv.compareDailyToBaseline({ readings: [], baseline: flatBaseline, fromKey: '2026-03-12', toKey: '2026-03-13' }), []);
});

test('cumulative savings add (baseline - actual) per day, pricing each day with its own tariff', () => {
  const tariffs = [{ copPerKwh: 900, effectiveFrom: '2026-01-01' }, { copPerKwh: 1000, effectiveFrom: '2026-03-03' }];
  const days = [
    { date: '2026-03-02', baselineKwh: 10, actualKwh: 7, bandHalfKwh: 1 },
    { date: '2026-03-03', baselineKwh: 10, actualKwh: 8, bandHalfKwh: 1 },
    { date: '2026-03-04', baselineKwh: 10, actualKwh: 11 },
  ];
  const r = sv.cumulativeSavings({ days, tariffs });
  assert.equal(r.days, 3);
  assert.equal(r.savingsKwh, 4); // 3 + 2 - 1
  assert.equal(r.savingsCop, 3 * 900 + 2 * 1000 - 1 * 1000);
  assert.equal(r.baselineKwh, 30);
  assert.equal(r.actualKwh, 26);
  assert.equal(r.lowKwh, 4 - 2);
  assert.equal(r.highKwh, 4 + 2);
  assert.equal(r.lowCop, 2 * 900 + 1 * 1000 - 1000);
  assert.equal(r.highCop, 4 * 900 + 3 * 1000 - 1000);
  assert.equal(r.perDay.length, 3);
  assert.equal(r.perDay[2].savingsCop, -1000);
});

test('cumulative savings: empty input is zero and a missing tariff raises', () => {
  const r = sv.cumulativeSavings({ days: [], tariffs: TARIFFS });
  assert.deepEqual([r.days, r.savingsKwh, r.savingsCop], [0, 0, 0]);
  assert.throws(() => sv.cumulativeSavings({ days: [{ date: '2025-01-01', baselineKwh: 1, actualKwh: 0 }], tariffs: TARIFFS }), RangeError);
});

test('cumulative savings from real readings agree with a manual calculation within 2 %', () => {
  const post = series('2026-03-12', 8, () => 60);
  const days = sv.compareDailyToBaseline({ readings: post, baseline: flatBaseline, fromKey: '2026-03-12', toKey: '2026-03-19', offsetMinutes: OFFSET });
  const r = sv.cumulativeSavings({ days, tariffs: TARIFFS });
  const manualKwh = 8 * (2.4 - 1.44);
  assert.equal(sv.matchesManual(r.savingsKwh, manualKwh), true);
  assert.equal(sv.matchesManual(r.savingsCop, manualKwh * 1000), true);
  assert.equal(sv.matchesManual(manualKwh * 1.03, manualKwh), false);
  assert.equal(sv.matchesManual(manualKwh * 1.02, manualKwh), true);
  assert.equal(sv.matchesManual(manualKwh * 1.025, manualKwh, 0.03), true);
});

const savings = (over = {}) => ({ days: 30, savingsCop: 450000, lowCop: 300000, highCop: 600000, ...over });

test('payback: investment / average monthly savings with a min-max range from the band', () => {
  const r = sv.estimatePayback({ investmentCop: 1800000, savings: savings() });
  assert.equal(r.status, 'estimated');
  assert.equal(r.investmentCop, 1800000);
  assert.equal(r.months, 4);
  assert.equal(r.minMonths, 3);
  assert.equal(r.maxMonths, 6);
  assert.equal(r.avgMonthlySavingsCop, 450000);
  assert.match(r.message, /La inversión de \$ 1\.800\.000 se recuperaría en unos 4 meses \(entre 3 y 6 meses\)\./);
});

test('payback: savings are averaged per observed day and scaled to a 30-day month', () => {
  const r = sv.estimatePayback({ investmentCop: 900000, savings: savings({ days: 15, savingsCop: 150000, lowCop: 150000, highCop: 150000 }) });
  assert.equal(r.avgMonthlySavingsCop, 300000);
  assert.equal(r.months, 3);
});

test('payback: savings <= 0 (or no days) is "Retorno no estimable" and still returns the investment', () => {
  for (const s of [savings({ savingsCop: 0 }), savings({ savingsCop: -500 }), savings({ days: 0, savingsCop: 100 })]) {
    const r = sv.estimatePayback({ investmentCop: 1800000, savings: s });
    assert.equal(r.status, 'not_estimable');
    assert.equal(r.investmentCop, 1800000);
    assert.match(r.message, /^Retorno no estimable/);
    assert.equal(r.months, undefined);
  }
});

test('payback: an open upper bound when the low end of the band is not a saving; zero investment pays back at once', () => {
  const open = sv.estimatePayback({ investmentCop: 1800000, savings: savings({ lowCop: -10 }) });
  assert.equal(open.maxMonths, null);
  assert.match(open.message, /desde 3 meses/);
  assert.equal(sv.estimatePayback({ investmentCop: 0, savings: savings() }).months, 0);
});
