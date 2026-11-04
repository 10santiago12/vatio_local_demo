const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeBaseline, baselineSlot, dailyBand } = require('../../backend/domain/baseline');
const { series, OFFSET } = require('./helpers');

// 2026-03-01 is a Sunday. Workday hour h draws 100 + h W; Sunday hour h draws 50 + h W.
const profile = ({ hour, weekday }) => (weekday === 0 ? 50 + hour : 100 + hour);
const close = (a, b, eps = 0.02) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const opts = (asOf, extra = {}) => ({ asOf, offsetMinutes: OFFSET, ...extra });

test('fewer than 7 continuous days: status building, day N of 7, no baseline values', () => {
  const readings = series('2026-03-01', 3, profile);
  const b = computeBaseline(readings, opts('2026-03-04T15:00:00Z'));
  assert.equal(b.status, 'building');
  assert.equal(b.dayN, 3);
  assert.equal(b.requiredDays, 7);
  assert.match(b.message, /día 3 de 7/);
  assert.equal(b.hourly, undefined);
  assert.equal(b.typicalDailyKwh, undefined);
});

test('exactly 6 days is still building and 7 days becomes ready (boundary)', () => {
  const readings = series('2026-03-01', 8, profile);
  assert.equal(computeBaseline(readings, opts('2026-03-07T15:00:00Z')).status, 'building'); // days 1-6
  assert.equal(computeBaseline(readings, opts('2026-03-07T15:00:00Z')).dayN, 6);
  assert.equal(computeBaseline(readings, opts('2026-03-08T15:00:00Z')).status, 'ready'); // days 1-7
});

test('empty input is building with day 0', () => {
  const b = computeBaseline([], opts('2026-03-10T00:00:00Z'));
  assert.deepEqual([b.status, b.dayN], ['building', 0]);
});

test('the current (incomplete) day is never part of the baseline', () => {
  const readings = series('2026-03-01', 7, profile); // Mar 1-7, asOf during Mar 7
  assert.equal(computeBaseline(readings, opts('2026-03-07T20:00:00Z')).status, 'building');
});

test('a gap breaks continuity: only the latest continuous run counts', () => {
  const readings = [...series('2026-03-01', 5, profile), ...series('2026-03-08', 3, profile)];
  const b = computeBaseline(readings, opts('2026-03-12T00:00:00Z'));
  assert.equal(b.status, 'building');
  assert.equal(b.dayN, 3);
});

test('requires asOf', () => {
  assert.throws(() => computeBaseline([], {}), /asOf/);
  assert.throws(() => computeBaseline([]), /asOf/);
});

test('hourly profile equals the known per-hour means and respects day types', () => {
  const readings = series('2026-03-01', 11, profile); // Mar 1 (Sun) .. Mar 11
  const b = computeBaseline(readings, opts('2026-03-11T15:00:00Z')); // days Mar 1-10
  assert.equal(b.status, 'ready');
  assert.equal(b.sampleDays, 10);
  assert.equal(b.windowStart, '2026-03-01');
  assert.equal(b.windowEnd, '2026-03-10');
  for (let h = 0; h < 24; h += 1) {
    close(b.hourly.workday[h].meanW, 100 + h, 1e-9);
    close(b.hourly.sunday[h].meanW, 50 + h, 1e-9);
    assert.equal(b.hourly.workday[h].stdW, 0);
    assert.equal(b.hourly.workday[h].bandLowW, 100 + h);
    assert.equal(b.hourly.workday[h].bandHighW, 100 + h);
  }
  assert.equal(b.hourly.workday[5].sampleDays, 8); // Mar 2-7, 9, 10
  assert.equal(b.hourly.sunday[5].sampleDays, 2); // Mar 1 and Mar 8
  assert.equal(b.dailyStats.workday.n, 8);
  assert.equal(b.dailyStats.sunday.n, 2);
});

test('typical daily kWh is the mean of days of the same type', () => {
  const readings = series('2026-03-01', 11, profile);
  const b = computeBaseline(readings, opts('2026-03-11T15:00:00Z'));
  close(b.typicalDailyKwh.workday, (24 * 100 + 276) / 1000, 0.01);
  close(b.typicalDailyKwh.sunday, (24 * 50 + 276) / 1000, 0.01);
  assert.ok(b.typicalDailyKwh.workday > b.typicalDailyKwh.sunday);
});

test('band is +-2 standard deviations, floored at zero', () => {
  // Workday hour 10 alternates 100 / 200 W between days; everything else constant.
  const readings = series('2026-03-02', 8, ({ hour, dayIndex }) => (hour === 10 ? (dayIndex % 2 ? 200 : 100) : 20));
  const b = computeBaseline(readings, opts('2026-03-10T15:00:00Z'));
  const e = b.hourly.workday[10]; // 7 days: 3 x 100 and 4 x 200 on workdays
  const mean = (3 * 100 + 4 * 200) / 7;
  const sd = Math.sqrt((3 * (100 - mean) ** 2 + 4 * (200 - mean) ** 2) / 6);
  close(e.meanW, mean, 1e-9);
  close(e.stdW, sd, 1e-9);
  close(e.bandHighW, mean + 2 * sd, 1e-9);
  close(e.bandLowW, Math.max(0, mean - 2 * sd), 1e-9);
  assert.equal(b.sigmas, 2);
  const wide = computeBaseline(readings, opts('2026-03-10T15:00:00Z', { sigmas: 100 }));
  assert.equal(wide.hourly.workday[10].bandLowW, 0);
});

test('reference window: asOf (activation date) excludes later data', () => {
  const calm = series('2026-03-01', 9, () => 100);
  const afterChange = series('2026-03-10', 5, () => 10); // savings after the activation
  const b = computeBaseline([...calm, ...afterChange], opts('2026-03-10T10:00:00Z'));
  assert.equal(b.windowEnd, '2026-03-09');
  close(b.hourly.workday[3].meanW, 100, 1e-9);
});

test('maxDays limits the window to the most recent days', () => {
  const readings = series('2026-03-01', 12, ({ dayIndex }) => (dayIndex < 4 ? 500 : 100));
  const b = computeBaseline(readings, opts('2026-03-13T15:00:00Z', { maxDays: 8 }));
  assert.equal(b.sampleDays, 8);
  assert.equal(b.windowStart, '2026-03-05');
  close(b.hourly.workday[0].meanW, 100, 1e-9);
});

test('hours without samples have zero values and sampleDays 0', () => {
  const sparse = series('2026-03-02', 8, ({ hour }) => (hour < 6 ? 30 : 0)).filter((r) => new Date(r.ts - 5 * 3600000).getUTCHours() < 12);
  const b = computeBaseline(sparse, opts('2026-03-10T15:00:00Z'));
  assert.equal(b.status, 'ready');
  assert.equal(b.hourly.workday[15].sampleDays, 0);
  assert.equal(b.hourly.workday[15].meanW, 0);
  assert.equal(baselineSlot(b, '2026-03-11T20:30:00Z'), null); // 15:30 local has no samples
});

test('baselineSlot finds the entry by day type and local hour; null while building', () => {
  const readings = series('2026-03-01', 10, profile);
  const b = computeBaseline(readings, opts('2026-03-11T15:00:00Z'));
  assert.equal(baselineSlot(b, '2026-03-11T15:30:00Z').meanW, 110); // Wednesday 10:30 local
  assert.equal(baselineSlot(b, '2026-03-15T15:30:00Z').meanW, 60); // Sunday 10:30 local
  assert.equal(baselineSlot(computeBaseline(series('2026-03-01', 2, profile), opts('2026-03-04T00:00:00Z')), '2026-03-04T15:00:00Z'), null);
  assert.equal(baselineSlot(null, '2026-03-04T15:00:00Z'), null);
});

test('dailyBand: mean +- 2 sigma, with a fallback for a day type that has a single sample', () => {
  const readings = series('2026-03-02', 8, ({ dayIndex }) => (dayIndex % 2 ? 150 : 100)); // Mar 2 .. Mar 9
  const b = computeBaseline(readings, opts('2026-03-10T15:00:00Z')); // 7 workdays? Mar 2-9 -> 7 workdays, 1 Sunday (Mar 8)
  assert.equal(b.dailyStats.sunday.n, 1);
  const w = dailyBand(b, 'workday');
  assert.ok(w.halfWidthKwh > 0);
  close(w.highKwh - w.meanKwh, w.halfWidthKwh, 1e-9);
  assert.ok(w.lowKwh >= 0);
  const s = dailyBand(b, 'sunday'); // single sample: coefficient of variation of workdays is applied
  close(s.halfWidthKwh, 2 * (b.dailyStats.workday.std / b.dailyStats.workday.mean) * b.dailyStats.sunday.mean, 1e-9);
  assert.equal(dailyBand({ status: 'building' }, 'workday'), null);
  assert.equal(dailyBand(null, 'workday'), null);
});

test('dailyBand without any variability or data returns zero width or null', () => {
  const flat = computeBaseline(series('2026-03-01', 8, () => 100), opts('2026-03-09T00:00:00Z'));
  assert.equal(dailyBand(flat, 'workday').halfWidthKwh, 0);
  const noSunday = computeBaseline(series('2026-03-02', 6, () => 100), opts('2026-03-08T15:00:00Z', { minDays: 3, maxDays: 3 }));
  assert.equal(dailyBand(noSunday, 'sunday'), null);
});
