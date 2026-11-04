const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../../backend/domain/time');
const s = require('../../backend/domain/stats');
const { SCHEDULE, OFFSET } = require('./helpers');

test('toMs accepts ms, Date and ISO strings and rejects garbage', () => {
  assert.equal(t.toMs(5), 5);
  assert.equal(t.toMs(new Date(7)), 7);
  assert.equal(t.toMs('1970-01-01T00:00:01Z'), 1000);
  assert.throws(() => t.toMs('nope'), TypeError);
  assert.throws(() => t.toMs(NaN), TypeError);
  assert.throws(() => t.toMs(null), TypeError);
  assert.equal(t.toIso(0), '1970-01-01T00:00:00.000Z');
});

test('local parts use the site offset (Bogota is UTC-5)', () => {
  const p = t.localParts('2026-03-02T03:30:00Z', OFFSET); // Sunday 22:30 local on 03-01
  assert.equal(p.date, '2026-03-01');
  assert.equal(p.hour, 22);
  assert.equal(p.minute, 30);
  assert.equal(p.weekday, 0);
  assert.equal(t.localDateKey('2026-03-01T04:59:59Z', OFFSET), '2026-02-28');
  assert.equal(t.localDateKey('2026-03-01T05:00:00Z', OFFSET), '2026-03-01');
  assert.equal(t.localDateKey('2026-03-01T05:00:00Z'), '2026-03-01'); // default offset
});

test('date key arithmetic crosses months, leap years and ranges', () => {
  assert.equal(t.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(t.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(t.addDays('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(t.dateRange('2026-03-01', '2026-03-03'), ['2026-03-01', '2026-03-02', '2026-03-03']);
  assert.deepEqual(t.dateRange('2026-03-03', '2026-03-01'), []);
  assert.equal(t.localDayStartMs('2026-03-01', OFFSET), Date.parse('2026-03-01T05:00:00Z'));
  assert.throws(() => t.localDayStartMs('2026/03/01'), TypeError);
});

test('day types: Sunday vs working day', () => {
  assert.equal(t.weekdayOfKey('2026-03-01'), 0);
  assert.equal(t.dayTypeOfKey('2026-03-01'), 'sunday');
  assert.equal(t.dayTypeOfKey('2026-03-02'), 'workday');
  assert.equal(t.dayTypeOfKey('2026-03-07'), 'workday'); // Saturday
  assert.equal(t.dayTypeOf('2026-03-02T04:59:00Z', OFFSET), 'sunday'); // still Sunday locally
});

test('operating hours: inclusive opening, exclusive closing, Sunday and closed days', () => {
  const open = (iso) => t.isOperatingHours(SCHEDULE, iso, OFFSET);
  assert.equal(open('2026-03-02T11:00:00Z'), true); // Monday 06:00 local
  assert.equal(open('2026-03-02T10:59:00Z'), false); // 05:59
  assert.equal(open('2026-03-03T00:59:00Z'), true); // Monday 19:59
  assert.equal(open('2026-03-03T01:00:00Z'), false); // Monday 20:00
  assert.equal(open('2026-03-01T17:00:00Z'), true); // Sunday 12:00
  assert.equal(open('2026-03-01T18:00:00Z'), false); // Sunday 13:00
  assert.equal(t.isOperatingHours([], '2026-03-02T15:00:00Z', OFFSET), false);
  assert.equal(t.isOperatingHours(undefined, '2026-03-02T15:00:00Z', OFFSET), false);
  const closedSunday = SCHEDULE.map((e) => (e.weekday === 0 ? { weekday: 0, closed: true } : e));
  assert.equal(t.isOperatingHours(closedSunday, '2026-03-01T17:00:00Z', OFFSET), false);
});

test('operating minutes, operating days and average closed hours', () => {
  assert.equal(t.operatingMinutesOnDate(SCHEDULE, '2026-03-02'), 14 * 60);
  assert.equal(t.operatingMinutesOnDate(SCHEDULE, '2026-03-01'), 6 * 60);
  assert.equal(t.operatingMinutesOnDate([], '2026-03-01'), 0);
  assert.equal(t.countOperatingDays(SCHEDULE, '2026-03-01', '2026-03-07'), 7);
  const noSunday = SCHEDULE.filter((e) => e.weekday !== 0);
  assert.equal(t.countOperatingDays(noSunday, '2026-03-01', '2026-03-07'), 6);
  assert.equal(t.countOperatingDays(SCHEDULE, '2026-03-07', '2026-03-01'), 0);
  assert.equal(t.parseHm('06:30'), 390);
  assert.throws(() => t.parseHm('6:30'), TypeError);
  assert.ok(Math.abs(t.averageClosedHoursPerDay(SCHEDULE) - ((6 * 10 + 18) / 7)) < 1e-9);
  assert.equal(t.averageClosedHoursPerDay([]), 24);
});

test('stats: empty inputs never throw', () => {
  assert.equal(s.sum([]), 0);
  assert.equal(s.mean([]), 0);
  assert.equal(s.stdDev([]), 0);
  assert.equal(s.stdDev([5]), 0);
  assert.equal(s.percentile([], 50), 0);
});

test('stats: mean, sample deviation and percentile on known data', () => {
  const v = [2, 4, 4, 4, 5, 5, 7, 9];
  assert.equal(s.sum(v), 40);
  assert.equal(s.mean(v), 5);
  assert.ok(Math.abs(s.stdDev(v) - Math.sqrt(32 / 7)) < 1e-12);
  assert.equal(s.percentile([1, 2, 3, 4], 0), 1);
  assert.equal(s.percentile([1, 2, 3, 4], 100), 4);
  assert.equal(s.percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(s.percentile([1, 2, 3, 4], 500), 4);
  assert.equal(s.percentile([4, 1, 3, 2], -5), 1);
});

test('stats: round, clamp and tolerance (zero and boundary values)', () => {
  assert.equal(s.round(1.005, 2), 1.01);
  assert.equal(s.round(2.5, 0), 3);
  assert.equal(s.clamp(5, 0, 3), 3);
  assert.equal(s.clamp(-1, 0, 3), 0);
  assert.equal(s.clamp(2, 0, 3), 2);
  assert.equal(s.withinTolerance(102, 100, 0.02), true);
  assert.equal(s.withinTolerance(102.01, 100, 0.02), false);
  assert.equal(s.withinTolerance(98, 100, 0.02), true);
  assert.equal(s.withinTolerance(0, 0, 0.02), true);
  assert.equal(s.withinTolerance(1, 0, 0.02), false);
});
