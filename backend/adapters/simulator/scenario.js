'use strict';
/**
 * The demo scenario: one fixed story told by the seeded history, anchored at a given "now".
 *
 *  - 45 days of history for 10 loads, the 11th (new mixer) installed 3 days ago;
 *  - freezer deterioration in the last 5 days (+18 % mean power) for the predictive-maintenance alert;
 *  - two recommendations accepted more than 7 days ago whose effect is built into the data:
 *    the coffee-machine standby (regular waste, removed completely: conclusive savings) and the sign
 *    timer (irregular waste only partly reduced: inconclusive);
 *  - two more sites for the multisite comparison (hourly aggregates only).
 *
 * Pure: depends only on the seed and the anchor, never on the real clock.
 */

const { localDayStartMs, localDateKey, addDays, MS_PER_HOUR, MS_PER_DAY } = require('../../domain/time');
const { createEngine } = require('./engine');
const { HISTORY_DAYS, RAW_DAYS } = require('./history');
const { MAIN_PROFILES, MAIN_SCHEDULE, EXTRA_SITES } = require('./profiles');

const DEFAULT_SEED = 20260311;
const OFFSET = -300;
const floorHour = (ms) => Math.floor(ms / MS_PER_HOUR) * MS_PER_HOUR;

/**
 * @param {{seed?: (number|string), anchorMs: number}} input `anchorMs` is the instant the history ends at.
 */
function buildScenario(input) {
  const seed = input.seed ?? DEFAULT_SEED;
  const anchorMs = input.anchorMs;
  const todayKey = localDateKey(anchorMs, OFFSET);
  const dayStart = (key) => localDayStartMs(key, OFFSET);

  // Recommendations accepted at 10:00 local, 22 and 15 days before the anchor.
  const coffeeKey = addDays(todayKey, -22);
  const signKey = addDays(todayKey, -15);
  const acceptedRecommendations = [
    {
      loadCode: 'coffee', type: 'reduce_standby', title: 'Desconectar la cafetera al cierre',
      assumption: 'La cafetera queda en espera de 150 W durante las horas de cierre; desconectarla evita ese consumo.',
      createdAtMs: dayStart(coffeeKey) - 2 * MS_PER_DAY + 9 * MS_PER_HOUR, acceptedAtMs: dayStart(coffeeKey) + 10 * MS_PER_HOUR,
      monthlySavingsKwh: 45, confidence: 0.9, expectedConclusive: true,
    },
    {
      loadCode: 'sign', type: 'off_hours_shutdown', title: 'Apagar el letrero al cierre',
      assumption: 'El letrero se queda encendido toda la noche algunos días; un temporizador lo apagaría al cierre.',
      createdAtMs: dayStart(signKey) - 2 * MS_PER_DAY + 9 * MS_PER_HOUR, acceptedAtMs: dayStart(signKey) + 10 * MS_PER_HOUR,
      monthlySavingsKwh: 22, confidence: 0.7, expectedConclusive: false,
    },
  ];

  const behavior = {
    // The waste stops the day AFTER the acceptance (savings are measured from the next day on).
    coffeeStandbyEndsMs: dayStart(addDays(coffeeKey, 1)),
    signFixAtMs: dayStart(addDays(signKey, 1)),
  };
  const engine = createEngine({ seed, schedule: MAIN_SCHEDULE, behavior, offsetMinutes: OFFSET });
  engine.modifiers.add({ kind: 'deterioration', loadCode: 'freezer', startMs: floorHour(anchorMs - 5 * MS_PER_DAY), rampMs: 36 * MS_PER_HOUR, factor: 0.18, builtin: true });

  const historyStartMs = dayStart(addDays(todayKey, -HISTORY_DAYS));
  const loads = MAIN_PROFILES.map((p) => ({
    code: p.code,
    startMs: p.installedDaysAgo ? dayStart(addDays(todayKey, -p.installedDaysAgo)) : historyStartMs,
  }));

  const extraSites = EXTRA_SITES.map((site) => ({
    ...site,
    engine: createEngine({
      seed: `${seed}|${site.id}`, schedule: site.schedule, scale: site.scale, offsetMinutes: OFFSET,
      trend: { startMs: historyStartMs, endMs: anchorMs, pct: site.trendPct },
    }),
    loads: site.loadCodes.map((code) => ({ code, startMs: historyStartMs })),
  }));

  return {
    seed, anchorMs, todayKey, engine, behavior, loads, acceptedRecommendations, extraSites,
    historyStartMs,
    /** Raw (1-minute) readings start here; everything older is hourly. */
    rawFromMs: floorHour(anchorMs - RAW_DAYS * MS_PER_DAY),
    /** Sites other than the main one are aggregated at 5-minute resolution, then hourly. */
    extraStepMinutes: 5,
  };
}

module.exports = { buildScenario, DEFAULT_SEED, OFFSET };
