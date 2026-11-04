'use strict';
/**
 * Reading series for the pure domain rules.
 *
 * The database keeps 1-minute readings for the recent window and hourly aggregates for older days.
 * The domain functions expect `{ts, powerW}` points whose gaps are small enough to integrate energy
 * (the default limit is 10 minutes), so:
 *  - `buildAnalyticsSeries` merges both resolutions into one uniform series (baseline, maintenance,
 *    savings): every hourly aggregate is expanded into one point every 5 minutes at its average power,
 *    and raw readings are folded into hourly averages the same way, so old and recent days weigh equally;
 *  - raw 1-minute points are used as they are for the short windows of the alert rules.
 */

const { MS_PER_MINUTE, MS_PER_HOUR } = require('../domain/time');

/** Spacing of the points an hourly aggregate is expanded into. */
const EXPANSION_MINUTES = 5;

function expandHour(hourStartMs, avgPowerW, out) {
  for (let m = 0; m < 60; m += EXPANSION_MINUTES) out.push({ ts: hourStartMs + m * MS_PER_MINUTE, powerW: avgPowerW });
}

/**
 * @param {Array<{ts: number, powerW: number}>} hourlyPoints One point per hour (ts = hour start, powerW = average).
 * @param {Array<{ts: number, powerW: number}>} rawPoints 1-minute readings.
 * @returns {Array<{ts: number, powerW: number}>} Sorted uniform series.
 */
function buildAnalyticsSeries(hourlyPoints, rawPoints) {
  const out = [];
  for (const h of hourlyPoints) expandHour(h.ts, h.powerW, out);
  const byHour = new Map();
  for (const r of rawPoints) {
    const hour = Math.floor(r.ts / MS_PER_HOUR) * MS_PER_HOUR;
    const bucket = byHour.get(hour);
    if (bucket) { bucket.sum += r.powerW; bucket.n += 1; } else byHour.set(hour, { sum: r.powerW, n: 1 });
  }
  for (const [hour, b] of byHour) expandHour(hour, b.sum / b.n, out);
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * Analytics series of one stored load.
 * @param {object} repos Repositories (backend/db/repositories).
 * @param {number} loadId
 * @param {{from: string, to: string}} range ISO instants, `to` exclusive.
 */
function analyticsSeries(repos, loadId, range) {
  const hourly = repos.readings.hourlyRange(loadId, range.from, range.to).map((h) => ({ ts: Date.parse(h.hour_start), powerW: h.avg_power_w }));
  return buildAnalyticsSeries(hourly, recentReadings(repos, loadId, range));
}

/**
 * Raw 1-minute points of a load.
 * @returns {Array<{ts: number, powerW: number}>}
 */
function recentReadings(repos, loadId, range) {
  return repos.readings.range(loadId, range.from, range.to).map((r) => ({ ts: Date.parse(r.ts), powerW: r.power_w }));
}

module.exports = { buildAnalyticsSeries, analyticsSeries, recentReadings, EXPANSION_MINUTES };
