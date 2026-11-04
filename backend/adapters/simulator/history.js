'use strict';
/**
 * History generator: turns the engine into stored-shape rows.
 *
 * For each load it walks the minute grid from its own start to `endMs`. Minutes at or after
 * `rawFromMs` become 1-minute readings with a cumulative kWh counter; earlier minutes are folded into
 * hourly aggregates (spec: 1-minute readings only for the last 2 days, hourly aggregates for the
 * older history). Output goes to a sink so nothing large is held in memory.
 */

const { MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } = require('../../domain/time');

/** Raw (1-minute) retention window of the demo history, in days. */
const RAW_DAYS = 2;
/** Length of the demo history, in days. */
const HISTORY_DAYS = 45;

const floorTo = (ms, unit) => Math.floor(ms / unit) * unit;

/**
 * @param {{engine: object, loads: Array<{code: string, startMs: number, energyKwh?: number}>, endMs: number, rawFromMs: number,
 *   stepMinutes?: number,
 *   sink: {raw?: function(string, object): void, hourly?: function(string, object): void}}} input
 *   `rawFromMs` must fall on an hour boundary. `energyKwh` is the counter the load starts from (default 0). With `stepMinutes` > 1 (aggregated history of extra sites)
 *   the energy of each sample covers the whole step.
 * @returns {{raw: number, hourly: number}} Rows emitted.
 */
function generateHistory(input) {
  const { engine, loads, sink } = input;
  const step = input.stepMinutes ?? 1;
  const stepMs = step * MS_PER_MINUTE;
  const endMs = floorTo(input.endMs, stepMs);
  const rawFromMs = input.rawFromMs;
  if (rawFromMs % MS_PER_HOUR !== 0) throw new RangeError('rawFromMs must be aligned to an hour');
  const counts = { raw: 0, hourly: 0 };

  for (const load of loads) {
    let cumulativeKwh = load.energyKwh ?? 0;
    let bucket = null;
    const flush = () => {
      if (!bucket) return;
      if (sink.hourly) {
        sink.hourly(load.code, {
          hourStart: new Date(bucket.hour).toISOString(),
          avgPowerW: bucket.sum / bucket.count,
          maxPowerW: bucket.max,
          energyKwh: (bucket.sum * step) / 60 / 1000,
          samples: bucket.count,
        });
      }
      counts.hourly += 1;
      bucket = null;
    };
    for (let ts = floorTo(load.startMs, stepMs); ts <= endMs; ts += stepMs) {
      const s = engine.sample(load.code, ts);
      cumulativeKwh += (s.powerW * step) / 60 / 1000;
      if (ts >= rawFromMs) {
        flush();
        if (sink.raw) sink.raw(load.code, { ts: new Date(ts).toISOString(), powerW: s.powerW, voltageV: s.voltageV, currentA: s.currentA, energyKwh: Math.round(cumulativeKwh * 1e6) / 1e6 });
        counts.raw += 1;
        continue;
      }
      const hour = floorTo(ts, MS_PER_HOUR);
      if (bucket && bucket.hour !== hour) flush();
      if (!bucket) bucket = { hour, sum: 0, max: 0, count: 0 };
      bucket.sum += s.powerW;
      bucket.max = Math.max(bucket.max, s.powerW);
      bucket.count += 1;
    }
    flush();
  }
  return counts;
}

module.exports = { generateHistory, RAW_DAYS, HISTORY_DAYS, MS_PER_DAY };
