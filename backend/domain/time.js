'use strict';
/**
 * Pure calendar helpers: local day keys, day types and operating-hours checks.
 *
 * Rule: the domain never reads the clock. Every function receives instants explicitly (epoch
 * milliseconds, Date or ISO-8601 string) and a fixed UTC offset in minutes (America/Bogota = -300,
 * no daylight saving). A "date key" is a local calendar date written YYYY-MM-DD.
 * Requirements covered: RF-02 (day types for the baseline), RF-04 (off-hours alerts), RF-12
 * (operating schedule), RF-09 (operating days).
 *
 * Schedule format (camelCase of the site_schedules table): array of
 * {weekday (0 = Sunday ... 6), closed (boolean), opensAt 'HH:MM', closesAt 'HH:MM'}.
 * A weekday without an entry is treated as closed.
 */

const { DAY_TYPE, DEFAULTS } = require('./constants');

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Normalize an instant to epoch milliseconds.
 * @param {number|Date|string} value Epoch ms, Date, or ISO-8601 string.
 * @returns {number}
 * @throws {TypeError} when the value is not a valid instant.
 */
function toMs(value) {
  let ms = NaN;
  if (typeof value === 'number') ms = value;
  else if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'string') ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`Invalid instant: ${String(value)}`);
  return ms;
}

/**
 * ISO-8601 UTC string of an instant.
 * @param {number|Date|string} value
 * @returns {string}
 */
function toIso(value) {
  return new Date(toMs(value)).toISOString();
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * Local calendar parts of an instant.
 * @param {number|Date|string} value
 * @param {number} [offsetMinutes] UTC offset of the site.
 * @returns {{date: string, year: number, month: number, day: number, hour: number, minute: number, weekday: number}}
 */
function localParts(value, offsetMinutes = DEFAULTS.UTC_OFFSET_MINUTES) {
  const d = new Date(toMs(value) + offsetMinutes * MS_PER_MINUTE);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return { date: `${year}-${pad(month)}-${pad(day)}`, year, month, day, hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() };
}

/**
 * Local date key (YYYY-MM-DD) of an instant.
 * @param {number|Date|string} value
 * @param {number} [offsetMinutes]
 * @returns {string}
 */
function localDateKey(value, offsetMinutes = DEFAULTS.UTC_OFFSET_MINUTES) {
  return localParts(value, offsetMinutes).date;
}

function keyToUtcMs(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  if (!m) throw new TypeError(`Invalid date key: ${String(key)}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Epoch ms of local midnight at the start of a date key.
 * @param {string} key YYYY-MM-DD
 * @param {number} [offsetMinutes]
 * @returns {number}
 */
function localDayStartMs(key, offsetMinutes = DEFAULTS.UTC_OFFSET_MINUTES) {
  return keyToUtcMs(key) - offsetMinutes * MS_PER_MINUTE;
}

/**
 * Date key `n` days after (or before, if negative) another date key.
 * @param {string} key
 * @param {number} n
 * @returns {string}
 */
function addDays(key, n) {
  return new Date(keyToUtcMs(key) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Inclusive list of date keys between two date keys (empty when end < start).
 * @param {string} startKey
 * @param {string} endKey
 * @returns {string[]}
 */
function dateRange(startKey, endKey) {
  const out = [];
  for (let k = startKey; keyToUtcMs(k) <= keyToUtcMs(endKey); k = addDays(k, 1)) out.push(k);
  return out;
}

/**
 * Weekday (0 = Sunday) of a date key.
 * @param {string} key
 * @returns {number}
 */
function weekdayOfKey(key) {
  return new Date(keyToUtcMs(key)).getUTCDay();
}

/**
 * Day type of a date key: Sunday vs working day (Monday-Saturday).
 * @param {string} key
 * @returns {'workday'|'sunday'}
 */
function dayTypeOfKey(key) {
  return weekdayOfKey(key) === 0 ? DAY_TYPE.SUNDAY : DAY_TYPE.WORKDAY;
}

/**
 * Day type of an instant in the site's local time.
 * @param {number|Date|string} value
 * @param {number} [offsetMinutes]
 * @returns {'workday'|'sunday'}
 */
function dayTypeOf(value, offsetMinutes = DEFAULTS.UTC_OFFSET_MINUTES) {
  return dayTypeOfKey(localDateKey(value, offsetMinutes));
}

/**
 * Minutes since midnight of an 'HH:MM' string.
 * @param {string} hm
 * @returns {number}
 */
function parseHm(hm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hm));
  if (!m) throw new TypeError(`Invalid time: ${String(hm)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function entryFor(schedule, weekday) {
  return (schedule || []).find((e) => e.weekday === weekday) || null;
}

/**
 * Whether the site is open at an instant. Opening is inclusive, closing is exclusive.
 * @param {Array<{weekday: number, closed: boolean, opensAt?: string, closesAt?: string}>} schedule
 * @param {number|Date|string} value
 * @param {number} [offsetMinutes]
 * @returns {boolean}
 */
function isOperatingHours(schedule, value, offsetMinutes = DEFAULTS.UTC_OFFSET_MINUTES) {
  const p = localParts(value, offsetMinutes);
  const entry = entryFor(schedule, p.weekday);
  if (!entry || entry.closed) return false;
  const minutes = p.hour * 60 + p.minute;
  return minutes >= parseHm(entry.opensAt) && minutes < parseHm(entry.closesAt);
}

/**
 * Operating minutes of a calendar date according to the weekly schedule.
 * @param {Array} schedule
 * @param {string} key
 * @returns {number}
 */
function operatingMinutesOnDate(schedule, key) {
  const entry = entryFor(schedule, weekdayOfKey(key));
  if (!entry || entry.closed) return 0;
  return Math.max(0, parseHm(entry.closesAt) - parseHm(entry.opensAt));
}

/**
 * Number of days on which the site operates inside an inclusive date range (RF-09).
 * @param {Array} schedule
 * @param {string} startKey
 * @param {string} endKey
 * @returns {number}
 */
function countOperatingDays(schedule, startKey, endKey) {
  return dateRange(startKey, endKey).filter((k) => operatingMinutesOnDate(schedule, k) > 0).length;
}

/**
 * Average closed hours per day over a week; used to project off-hours waste per month.
 * @param {Array} schedule
 * @returns {number}
 */
function averageClosedHoursPerDay(schedule) {
  let closed = 0;
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const entry = entryFor(schedule, weekday);
    const open = entry && !entry.closed ? parseHm(entry.closesAt) - parseHm(entry.opensAt) : 0;
    closed += 24 - open / 60;
  }
  return closed / 7;
}

module.exports = {
  MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY, toMs, toIso, localParts, localDateKey, localDayStartMs, addDays, dateRange,
  weekdayOfKey, dayTypeOfKey, dayTypeOf, parseHm, isOperatingHours, operatingMinutesOnDate, countOperatingDays,
  averageClosedHoursPerDay,
};
