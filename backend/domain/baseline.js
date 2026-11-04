'use strict';
/**
 * Consumption baseline per load (RF-02, HU-02, calculation rule 3).
 *
 * Rule: a baseline needs at least 7 CONTINUOUS days with data. Before that the status is
 * `building` ("día N de 7") and NO baseline numbers are produced, so alerts and recommendations
 * can refuse to act on it. Once ready:
 *  - typical daily consumption = mean daily kWh of the days of the same day type (workday vs Sunday);
 *  - hourly profile = mean power (W) of each hour of the day, per day type;
 *  - uncertainty band = mean +- 2 standard deviations (lower end floored at 0).
 * Only COMPLETE local days before the reference instant `asOf` are used. For a recommendation use
 * the activation instant as `asOf`: the reference window is then the period before it. The window
 * is at most `maxDays` (default 45) most recent days.
 *
 * Continuity is measured over days with at least one reading, counted backwards from the most
 * recent day with data; staleness of the data is the job of the module-inactivity alert.
 * Readings are {ts, powerW}.
 */

const { DAY_TYPE, DEFAULTS } = require('./constants');
const { energySegments } = require('./cost');
const { mean, stdDev } = require('./stats');
const { toMs, toIso, localDateKey, localDayStartMs, localParts, addDays, dayTypeOfKey } = require('./time');

const DAY_TYPES = [DAY_TYPE.WORKDAY, DAY_TYPE.SUNDAY];

function emptyHourly() {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, meanW: 0, stdW: 0, bandLowW: 0, bandHighW: 0, sampleDays: 0 }));
}

/**
 * Compute the baseline of one load.
 * @param {Array<{ts: (number|string|Date), powerW: number}>} readings Readings of ONE load.
 * @param {{asOf: (number|string|Date), offsetMinutes?: number, minDays?: number, maxDays?: number,
 *   sigmas?: number, maxGapMs?: number}} options `asOf` is required and excludes that local day and later.
 * @returns {{status: 'building', dayN: number, requiredDays: number, message: string}
 *   | {status: 'ready', dayN: number, requiredDays: number, sampleDays: number, windowStart: string,
 *      windowEnd: string, asOf: string, offsetMinutes: number, typicalDailyKwh: {workday: (number|null), sunday: (number|null)},
 *      dailyStats: {workday: {n: number, mean: number, std: number}, sunday: {n: number, mean: number, std: number}},
 *      hourly: {workday: Array, sunday: Array}, sigmas: number}} `building` carries no baseline values.
 */
function computeBaseline(readings, options) {
  if (!options || options.asOf === undefined) throw new TypeError('computeBaseline requires options.asOf');
  const offset = options.offsetMinutes ?? DEFAULTS.UTC_OFFSET_MINUTES;
  const minDays = options.minDays ?? DEFAULTS.MIN_BASELINE_DAYS;
  const maxDays = options.maxDays ?? 45;
  const sigmas = options.sigmas ?? DEFAULTS.BAND_SIGMAS;
  const asOfMs = toMs(options.asOf);
  const cutoffMs = localDayStartMs(localDateKey(asOfMs, offset), offset);

  const usable = readings.filter((r) => toMs(r.ts) < cutoffMs);
  const keysWithData = new Set(usable.map((r) => localDateKey(r.ts, offset)));
  const lastKey = [...keysWithData].sort().pop();
  let run = 0;
  if (lastKey) for (let k = lastKey; keysWithData.has(k); k = addDays(k, -1)) run += 1;

  if (run < minDays) {
    return {
      status: 'building', dayN: run, requiredDays: minDays,
      message: `Línea base en construcción (día ${run} de ${minDays})`,
    };
  }

  const dayCount = Math.min(run, maxDays);
  const firstKey = addDays(lastKey, -(dayCount - 1));
  const windowReadings = usable.filter((r) => localDateKey(r.ts, offset) >= firstKey);

  // Energy is integrated over every reading so the last interval of the window is closed by the next
  // reading, but only intervals that START before the cutoff are attributed to the window.
  const dailyKwh = {};
  const firstMs = localDayStartMs(firstKey, offset);
  const forEnergy = readings.filter((r) => toMs(r.ts) >= firstMs);
  for (const s of energySegments(forEnergy, { maxGapMs: options.maxGapMs }).filter((seg) => seg.startMs < cutoffMs)) {
    const key = localDateKey(s.startMs, offset);
    dailyKwh[key] = (dailyKwh[key] || 0) + s.kwh;
  }
  const hourSamples = {}; // key -> hour -> number[]
  for (const r of windowReadings) {
    const p = localParts(r.ts, offset);
    const byHour = hourSamples[p.date] || (hourSamples[p.date] = {});
    (byHour[p.hour] || (byHour[p.hour] = [])).push(r.powerW);
  }

  const typicalDailyKwh = { workday: null, sunday: null };
  const dailyStats = { workday: { n: 0, mean: 0, std: 0 }, sunday: { n: 0, mean: 0, std: 0 } };
  const hourly = { workday: emptyHourly(), sunday: emptyHourly() };
  const dayKeys = Object.keys(hourSamples).sort();
  for (const type of DAY_TYPES) {
    const keys = dayKeys.filter((k) => dayTypeOfKey(k) === type);
    const daily = keys.map((k) => dailyKwh[k] || 0);
    if (keys.length) {
      typicalDailyKwh[type] = mean(daily);
      dailyStats[type] = { n: keys.length, mean: mean(daily), std: stdDev(daily) };
    }
    for (let hour = 0; hour < 24; hour += 1) {
      const perDay = keys.filter((k) => hourSamples[k][hour]).map((k) => mean(hourSamples[k][hour]));
      if (!perDay.length) continue;
      const m = mean(perDay);
      const sd = stdDev(perDay);
      hourly[type][hour] = {
        hour, meanW: m, stdW: sd, bandLowW: Math.max(0, m - sigmas * sd), bandHighW: m + sigmas * sd, sampleDays: perDay.length,
      };
    }
  }

  return {
    status: 'ready', dayN: run, requiredDays: minDays, sampleDays: dayCount, windowStart: firstKey, windowEnd: lastKey,
    asOf: toIso(asOfMs), offsetMinutes: offset, typicalDailyKwh, dailyStats, hourly, sigmas,
  };
}

/**
 * Hourly baseline entry that applies to an instant (day type + hour of the day).
 * @param {{status: string, hourly?: object}} baseline Result of computeBaseline.
 * @param {number|string|Date} instant
 * @returns {{hour: number, meanW: number, stdW: number, bandLowW: number, bandHighW: number, sampleDays: number}|null}
 *   null while the baseline is building or when that hour has no samples.
 */
function baselineSlot(baseline, instant) {
  if (!baseline || baseline.status !== 'ready') return null;
  const p = localParts(instant, baseline.offsetMinutes);
  const entry = baseline.hourly[dayTypeOfKey(p.date)][p.hour];
  return entry.sampleDays > 0 ? entry : null;
}

/**
 * Expected daily consumption and its +-sigma band for a day type.
 * When a day type has a single sample day its own deviation is unknown, so the coefficient of
 * variation of the other day type is applied to its mean.
 * @param {{status: string, dailyStats?: object, sigmas?: number}} baseline
 * @param {'workday'|'sunday'} dayType
 * @returns {{meanKwh: number, lowKwh: number, highKwh: number, halfWidthKwh: number}|null} null when unavailable.
 */
function dailyBand(baseline, dayType) {
  if (!baseline || baseline.status !== 'ready') return null;
  const stats = baseline.dailyStats[dayType];
  if (!stats || stats.n === 0) return null;
  const sigmas = baseline.sigmas ?? DEFAULTS.BAND_SIGMAS;
  let sd = stats.std;
  if (stats.n < 2) {
    const other = baseline.dailyStats[dayType === DAY_TYPE.SUNDAY ? DAY_TYPE.WORKDAY : DAY_TYPE.SUNDAY];
    sd = other && other.n >= 2 && other.mean > 0 ? (other.std / other.mean) * stats.mean : 0;
  }
  const halfWidthKwh = sigmas * sd;
  return { meanKwh: stats.mean, lowKwh: Math.max(0, stats.mean - halfWidthKwh), highKwh: stats.mean + halfWidthKwh, halfWidthKwh };
}

module.exports = { computeBaseline, baselineSlot, dailyBand };
