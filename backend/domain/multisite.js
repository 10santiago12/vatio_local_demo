'use strict';
/**
 * Multisite comparison (RF-09, HU-12; calculation rule 10).
 *
 * Rule: every value of a site is divided by the operating days of the period, so a site that opens
 * 6 days is comparable with one that opens 7. The site with the largest percentage reduction
 * against its own baseline is highlighted (only if that reduction is positive; ties go to the
 * smaller site id so the result is deterministic). A site with no operating days has no per-day
 * values and is never highlighted.
 */

const { round } = require('./stats');
const { countOperatingDays } = require('./time');

/**
 * Normalize sites per operating day and highlight the best one.
 * @param {{sites: Array<{siteId: string, name: string, consumptionKwh: number, costCop: number, savingsCop?: number,
 *   baselineKwh: number, operatingDays: number}>, sectorReferenceKwhPerDay?: number}} input
 * @returns {{rows: Array<{siteId: string, name: string, operatingDays: number, kwhPerOperatingDay: (number|null),
 *   copPerOperatingDay: (number|null), savingsCopPerOperatingDay: (number|null), reductionPct: (number|null),
 *   vsSectorPct: (number|null), highlighted: boolean}>, highlightedSiteId: (string|null)}}
 */
function compareSites(input) {
  const ref = input.sectorReferenceKwhPerDay;
  const rows = input.sites.map((s) => {
    const days = s.operatingDays > 0 ? s.operatingDays : 0;
    const perDay = (value) => (days > 0 && value !== undefined && value !== null ? value / days : null);
    const kwhPerDay = perDay(s.consumptionKwh);
    return {
      siteId: s.siteId,
      name: s.name,
      operatingDays: days,
      kwhPerOperatingDay: kwhPerDay,
      copPerOperatingDay: perDay(s.costCop),
      savingsCopPerOperatingDay: perDay(s.savingsCop),
      reductionPct: s.baselineKwh > 0 ? round(((s.baselineKwh - s.consumptionKwh) / s.baselineKwh) * 100, 2) : null,
      vsSectorPct: kwhPerDay !== null && ref > 0 ? round((kwhPerDay / ref - 1) * 100, 2) : null,
      highlighted: false,
    };
  });
  let best = null;
  for (const row of rows) {
    if (row.reductionPct === null || row.operatingDays === 0 || row.reductionPct <= 0) continue;
    if (!best || row.reductionPct > best.reductionPct || (row.reductionPct === best.reductionPct && row.siteId < best.siteId)) best = row;
  }
  if (best) best.highlighted = true;
  return { rows, highlightedSiteId: best ? best.siteId : null };
}

module.exports = { compareSites, countOperatingDays };
