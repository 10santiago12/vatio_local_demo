'use strict';
/**
 * Energy integration and cost in COP (RF-03, calculation rules 1 and 2).
 *
 * Rule 1: kWh += P(W) * dt(h) / 1000. Each reading holds its power until the next reading; a gap
 * longer than `maxGapMs` (default 10 minutes, e.g. a module that went offline) only counts up to
 * that limit, so missing data is never invented as consumption.
 * Rule 2: COP = kWh * tariff valid on the local date of each interval. A tariff has an
 * `effectiveFrom` date and applies from that date onwards, never backwards: readings older than the
 * first tariff have no price and raise an error instead of silently using a later one.
 *
 * Readings are {ts, powerW}. Tariffs are {copPerKwh, effectiveFrom 'YYYY-MM-DD'}.
 * The money value is returned unrounded; formatting is a UI concern.
 */

const { DEFAULTS } = require('./constants');
const { toMs, localDateKey, MS_PER_HOUR, MS_PER_MINUTE } = require('./time');

const DEFAULT_MAX_GAP_MS = 10 * MS_PER_MINUTE;

/**
 * Split a reading series into constant-power intervals with their energy.
 * @param {Array<{ts: (number|string|Date), powerW: number}>} readings Any order; sorted internally.
 * @param {{maxGapMs?: number, tailMs?: number}} [options] `tailMs` is how long the LAST reading is
 *   assumed to hold (default 0: only closed intervals count).
 * @returns {Array<{startMs: number, endMs: number, powerW: number, kwh: number}>}
 */
function energySegments(readings, options = {}) {
  const maxGapMs = options.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const tailMs = options.tailMs ?? 0;
  const sorted = readings.map((r) => ({ ts: toMs(r.ts), powerW: r.powerW })).sort((a, b) => a.ts - b.ts);
  const segments = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const next = sorted[i + 1];
    const rawDt = next ? next.ts - sorted[i].ts : tailMs;
    const dt = Math.min(rawDt, maxGapMs);
    if (dt <= 0) continue;
    segments.push({ startMs: sorted[i].ts, endMs: sorted[i].ts + dt, powerW: sorted[i].powerW, kwh: (sorted[i].powerW * (dt / MS_PER_HOUR)) / 1000 });
  }
  return segments;
}

/**
 * Total energy of a reading series in kWh.
 * @param {Array<{ts: (number|string|Date), powerW: number}>} readings
 * @param {{maxGapMs?: number, tailMs?: number}} [options]
 * @returns {number}
 */
function integrateKwh(readings, options) {
  let total = 0;
  for (const s of energySegments(readings, options)) total += s.kwh;
  return total;
}

/**
 * Tariff valid on a local date: the latest one whose effectiveFrom is on or before the date.
 * @param {Array<{copPerKwh: number, effectiveFrom: string}>} tariffs
 * @param {string} dateKey YYYY-MM-DD
 * @returns {{copPerKwh: number, effectiveFrom: string}|null} null when none applies yet.
 */
function tariffAt(tariffs, dateKey) {
  let best = null;
  for (const t of tariffs || []) {
    const from = String(t.effectiveFrom).slice(0, 10);
    if (from <= dateKey && (!best || from > best.from)) best = { from, tariff: t };
  }
  return best ? best.tariff : null;
}

/**
 * Cost of an amount of energy on a given local date.
 * @param {number} kwh
 * @param {Array<{copPerKwh: number, effectiveFrom: string}>} tariffs
 * @param {string} dateKey YYYY-MM-DD
 * @returns {number} COP
 * @throws {RangeError} when no tariff is valid on that date.
 */
function costOfKwh(kwh, tariffs, dateKey) {
  const t = tariffAt(tariffs, dateKey);
  if (!t) throw new RangeError(`No tariff valid on ${dateKey}`);
  return kwh * t.copPerKwh;
}

/**
 * Energy and cost of a reading series, pricing every interval with the tariff of its own date.
 * @param {Array<{ts: (number|string|Date), powerW: number}>} readings
 * @param {Array<{copPerKwh: number, effectiveFrom: string}>} tariffs
 * @param {{offsetMinutes?: number, maxGapMs?: number, tailMs?: number}} [options]
 * @returns {{kwh: number, cop: number, byDate: Object<string, {kwh: number, cop: number}>}}
 * @throws {RangeError} when an interval falls before the first tariff.
 */
function costOfReadings(readings, tariffs, options = {}) {
  const offset = options.offsetMinutes ?? DEFAULTS.UTC_OFFSET_MINUTES;
  const byDate = {};
  let kwh = 0;
  let cop = 0;
  for (const s of energySegments(readings, options)) {
    const date = localDateKey(s.startMs, offset);
    const segmentCop = costOfKwh(s.kwh, tariffs, date);
    const day = byDate[date] || (byDate[date] = { kwh: 0, cop: 0 });
    day.kwh += s.kwh;
    day.cop += segmentCop;
    kwh += s.kwh;
    cop += segmentCop;
  }
  return { kwh, cop, byDate };
}

module.exports = { DEFAULT_MAX_GAP_MS, energySegments, integrateKwh, tariffAt, costOfKwh, costOfReadings };
