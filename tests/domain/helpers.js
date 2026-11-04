'use strict';
// Test-only builders for deterministic reading series (no randomness, no clock).
const { localDayStartMs, addDays, localParts, MS_PER_MINUTE } = require('../../backend/domain/time');

const OFFSET = -300; // America/Bogota

/** La Espiga schedule: Monday-Saturday 06:00-20:00, Sunday 07:00-13:00. */
const SCHEDULE = [
  { weekday: 0, closed: false, opensAt: '07:00', closesAt: '13:00' },
  ...[1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, closed: false, opensAt: '06:00', closesAt: '20:00' })),
];

/**
 * Readings every `stepMin` minutes for `days` local days starting at `startKey` local midnight.
 * `fn({date, hour, minute, weekday, dayIndex, ts})` returns watts.
 * @returns {Array<{ts: number, powerW: number}>}
 */
function series(startKey, days, fn, stepMin = 1) {
  const out = [];
  for (let d = 0; d < days; d += 1) {
    const key = addDays(startKey, d);
    const start = localDayStartMs(key, OFFSET);
    for (let m = 0; m < 1440; m += stepMin) {
      const ts = start + m * MS_PER_MINUTE;
      const p = localParts(ts, OFFSET);
      out.push({ ts, powerW: fn({ date: key, hour: p.hour, minute: p.minute, weekday: p.weekday, dayIndex: d, ts }) });
    }
  }
  return out;
}

/** Local instant helper: ISO string of local `key` at HH:MM. */
function at(key, hm) {
  const [h, m] = hm.split(':').map(Number);
  return new Date(localDayStartMs(key, OFFSET) + (h * 60 + m) * MS_PER_MINUTE).toISOString();
}

module.exports = { OFFSET, SCHEDULE, series, at };
