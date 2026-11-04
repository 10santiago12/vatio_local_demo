const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareSites, countOperatingDays } = require('../../backend/domain/multisite');
const { SCHEDULE } = require('./helpers');

const SITES = [
  { siteId: 'la-espiga-chia', name: 'La Espiga - Chía', consumptionKwh: 600, costCop: 570000, savingsCop: 120000, baselineKwh: 800, operatingDays: 6 },
  { siteId: 'la-espiga-cajica', name: 'La Espiga - Cajicá', consumptionKwh: 700, costCop: 665000, savingsCop: 30000, baselineKwh: 750, operatingDays: 7 },
];

test('values are normalized per operating day', () => {
  const { rows } = compareSites({ sites: SITES });
  assert.equal(rows[0].kwhPerOperatingDay, 100);
  assert.equal(rows[0].copPerOperatingDay, 95000);
  assert.equal(rows[0].savingsCopPerOperatingDay, 20000);
  assert.equal(rows[1].kwhPerOperatingDay, 100);
  assert.ok(Math.abs(rows[1].copPerOperatingDay - 95000) < 1e-9);
});

test('the site with the largest % reduction against its own baseline is highlighted', () => {
  const r = compareSites({ sites: SITES });
  assert.equal(r.rows[0].reductionPct, 25);
  assert.equal(r.rows[1].reductionPct, 6.67);
  assert.equal(r.highlightedSiteId, 'la-espiga-chia');
  assert.deepEqual(r.rows.map((x) => x.highlighted), [true, false]);
});

test('ties go to the smaller site id; nothing is highlighted when no site reduced consumption', () => {
  const tie = compareSites({ sites: [{ ...SITES[1], siteId: 'b' }, { ...SITES[1], siteId: 'a' }] });
  assert.equal(tie.highlightedSiteId, 'a');
  const worse = compareSites({ sites: [{ ...SITES[0], consumptionKwh: 900 }, { ...SITES[1], consumptionKwh: 750 }] });
  assert.equal(worse.highlightedSiteId, null);
  assert.ok(worse.rows.every((x) => !x.highlighted));
});

test('sites with no operating days or no baseline have no per-day values and are not highlighted', () => {
  const r = compareSites({ sites: [{ ...SITES[0], operatingDays: 0 }, { ...SITES[1], baselineKwh: 0 }, { ...SITES[1], siteId: 'neg', operatingDays: -3 }] });
  assert.equal(r.rows[0].kwhPerOperatingDay, null);
  assert.equal(r.rows[0].operatingDays, 0);
  assert.equal(r.rows[1].reductionPct, null);
  assert.equal(r.rows[2].operatingDays, 0);
  assert.equal(r.highlightedSiteId, null);
});

test('empty list and optional fields', () => {
  assert.deepEqual(compareSites({ sites: [] }), { rows: [], highlightedSiteId: null });
  const r = compareSites({ sites: [{ siteId: 's', name: 'S', consumptionKwh: 90, costCop: 90000, baselineKwh: 100, operatingDays: 3 }] });
  assert.equal(r.rows[0].savingsCopPerOperatingDay, null);
});

test('sector reference compares kWh per operating day', () => {
  const r = compareSites({ sites: SITES, sectorReferenceKwhPerDay: 80 });
  assert.equal(r.rows[0].vsSectorPct, 25);
  assert.equal(compareSites({ sites: SITES }).rows[0].vsSectorPct, null);
  assert.equal(compareSites({ sites: SITES, sectorReferenceKwhPerDay: 0 }).rows[0].vsSectorPct, null);
});

test('operating days of a period come from the weekly schedule', () => {
  assert.equal(countOperatingDays(SCHEDULE, '2026-03-01', '2026-03-31'), 31);
  const noSunday = SCHEDULE.map((e) => (e.weekday === 0 ? { weekday: 0, closed: true } : e));
  assert.equal(countOperatingDays(noSunday, '2026-03-01', '2026-03-31'), 26); // 5 Sundays in March 2026
});
