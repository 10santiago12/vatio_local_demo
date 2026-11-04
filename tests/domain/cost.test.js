const { test } = require('node:test');
const assert = require('node:assert/strict');
const cost = require('../../backend/domain/cost');
const { series, OFFSET } = require('./helpers');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('kWh integration: 1000 W for one hour is 1 kWh', () => {
  const readings = Array.from({ length: 61 }, (_, i) => ({ ts: i * 60000, powerW: 1000 }));
  close(cost.integrateKwh(readings), 1);
});

test('integration is order independent and accepts ISO timestamps', () => {
  const a = [{ ts: '2026-03-01T10:00:00Z', powerW: 600 }, { ts: '2026-03-01T10:30:00Z', powerW: 0 }];
  close(cost.integrateKwh(a, { maxGapMs: 3600000 }), 0.3);
  close(cost.integrateKwh([...a].reverse(), { maxGapMs: 3600000 }), 0.3);
});

test('gaps are capped (no invented consumption) and the tail is optional', () => {
  const readings = [{ ts: 0, powerW: 1000 }, { ts: 3 * 3600000, powerW: 1000 }];
  close(cost.integrateKwh(readings), 1000 * (10 / 60) / 1000); // only 10 minutes counted
  close(cost.integrateKwh(readings, { maxGapMs: 3 * 3600000 }), 3);
  close(cost.integrateKwh(readings, { maxGapMs: 3 * 3600000, tailMs: 3600000 }), 4);
});

test('empty, single and duplicate-timestamp series add up to zero', () => {
  assert.deepEqual(cost.energySegments([]), []);
  assert.equal(cost.integrateKwh([]), 0);
  assert.equal(cost.integrateKwh([{ ts: 0, powerW: 500 }]), 0);
  assert.equal(cost.integrateKwh([{ ts: 0, powerW: 500 }, { ts: 0, powerW: 500 }]), 0);
});

test('zero power costs nothing', () => {
  const r = cost.costOfReadings(series('2026-03-01', 1, () => 0), [{ copPerKwh: 900, effectiveFrom: '2026-01-01' }]);
  assert.equal(r.kwh, 0);
  assert.equal(r.cop, 0);
});

test('tariff lookup: latest effective date on or before the day, never later', () => {
  const tariffs = [{ copPerKwh: 1000, effectiveFrom: '2026-03-03' }, { copPerKwh: 900, effectiveFrom: '2026-01-01' }];
  assert.equal(cost.tariffAt(tariffs, '2026-03-02').copPerKwh, 900);
  assert.equal(cost.tariffAt(tariffs, '2026-03-03').copPerKwh, 1000);
  assert.equal(cost.tariffAt(tariffs, '2026-12-31').copPerKwh, 1000);
  assert.equal(cost.tariffAt(tariffs, '2025-12-31'), null);
  assert.equal(cost.tariffAt([], '2026-03-01'), null);
  assert.equal(cost.tariffAt(undefined, '2026-03-01'), null);
  assert.equal(cost.tariffAt([{ copPerKwh: 5, effectiveFrom: '2026-03-03T00:00:00Z' }], '2026-03-03').copPerKwh, 5);
});

test('a tariff change recalculates only from its effective date', () => {
  const readings = series('2026-03-01', 4, () => 1000); // 24 kWh per day, 4 days (last minute of day 4 not closed)
  const tariffs = [{ copPerKwh: 900, effectiveFrom: '2026-01-01' }, { copPerKwh: 1000, effectiveFrom: '2026-03-03' }];
  const r = cost.costOfReadings(readings, tariffs, { offsetMinutes: OFFSET });
  close(r.byDate['2026-03-01'].cop, 24 * 900, 1e-6);
  close(r.byDate['2026-03-02'].cop, 24 * 900, 1e-6);
  close(r.byDate['2026-03-03'].cop, 24 * 1000, 1e-6);
  close(r.cop, r.byDate['2026-03-01'].cop + r.byDate['2026-03-02'].cop + r.byDate['2026-03-03'].cop + r.byDate['2026-03-04'].cop, 1e-6);
  // Adding the new tariff must not change anything before its date.
  const before = cost.costOfReadings(readings.filter((x) => x.ts < Date.parse('2026-03-03T05:00:00Z')), [tariffs[0]], { offsetMinutes: OFFSET });
  close(before.byDate['2026-03-01'].cop, r.byDate['2026-03-01'].cop, 1e-9);
});

test('cost agrees with a manual calculation within 1 %', () => {
  const readings = series('2026-03-01', 2, ({ hour }) => (hour < 12 ? 500 : 1500));
  const tariffs = [{ copPerKwh: 950, effectiveFrom: '2026-01-01' }];
  const manualKwh = 2 * (12 * 0.5 + 12 * 1.5);
  const r = cost.costOfReadings(readings, tariffs, { offsetMinutes: OFFSET });
  assert.ok(Math.abs(r.cop - manualKwh * 950) / (manualKwh * 950) < 0.01);
  assert.ok(Math.abs(r.kwh - manualKwh) / manualKwh < 0.01);
});

test('readings before the first tariff raise instead of using a later price', () => {
  const readings = series('2026-03-01', 1, () => 100);
  assert.throws(() => cost.costOfReadings(readings, [{ copPerKwh: 900, effectiveFrom: '2026-03-02' }], { offsetMinutes: OFFSET }), RangeError);
  assert.throws(() => cost.costOfKwh(1, [], '2026-03-01'), /No tariff/);
  assert.equal(cost.costOfKwh(2, [{ copPerKwh: 450, effectiveFrom: '2026-01-01' }], '2026-03-01'), 900);
  assert.equal(cost.costOfKwh(0, [{ copPerKwh: 450, effectiveFrom: '2026-01-01' }], '2026-03-01'), 0);
});
