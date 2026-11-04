'use strict';
/**
 * Savings, payback and attributable savings (RF-10, RF-14, HU-10, HU-15; calculation rules 7 and 8).
 *
 * - Cumulative savings = sum over days of (baseline - actual), in kWh and COP (each day priced with
 *   the tariff of its own date). The range uses the baseline band (baseline +- 2 sigma per day).
 * - Payback = investment / average monthly savings (30-day month), with a min-max range taken from the
 *   band. The investment used is ALWAYS returned. If the savings are <= 0 the result is
 *   `not_estimable` ("Retorno no estimable"), never an infinite or negative number.
 * - Attributable savings of an accepted recommendation: the days AFTER the acceptance day are compared
 *   with the baseline of the affected load. Fewer than 7 complete days -> `measuring` (day N of 7).
 *   |difference| within the accumulated band, or too little data -> `inconclusive` ("No concluyente").
 *   Otherwise `conclusive`.
 * - The calculation must match a manual one within 2 % (`matchesManual`).
 * Savings are estimates against a baseline: external factors (weather, more customers) can influence them.
 * Days are complete local days; the current day is never included.
 */

const { DEFAULTS } = require('./constants');
const { dailyBand } = require('./baseline');
const { costOfKwh, energySegments } = require('./cost');
const { sum, withinTolerance } = require('./stats');
const { formatCop, formatNumber } = require('./text');
const { toMs, localDateKey, localDayStartMs, addDays, dateRange, dayTypeOfKey } = require('./time');

const HONEST_NOTE = 'Este ahorro es una estimación basada en la comparación con tu línea base; factores externos (clima, más clientes) pueden influir.';

/**
 * Daily actual-vs-baseline comparison of one load over an inclusive range of complete days.
 * Days without readings, or whose day type has no baseline, are left out.
 * @param {{readings: Array, baseline: object, fromKey: string, toKey: string, offsetMinutes?: number, maxGapMs?: number}} input
 * @returns {Array<{date: string, dayType: string, baselineKwh: number, bandHalfKwh: number, actualKwh: number}>}
 */
function compareDailyToBaseline(input) {
  const offset = input.offsetMinutes ?? DEFAULTS.UTC_OFFSET_MINUTES;
  if (!input.baseline || input.baseline.status !== 'ready') return [];
  const from = localDayStartMs(input.fromKey, offset);
  const to = localDayStartMs(addDays(input.toKey, 1), offset);
  const withData = new Set(input.readings.filter((r) => toMs(r.ts) >= from && toMs(r.ts) < to).map((r) => localDateKey(r.ts, offset)));
  const actual = {};
  const segments = energySegments(input.readings.filter((r) => toMs(r.ts) >= from), { maxGapMs: input.maxGapMs }).filter((s) => s.startMs < to);
  for (const s of segments) actual[localDateKey(s.startMs, offset)] = (actual[localDateKey(s.startMs, offset)] || 0) + s.kwh;
  const days = [];
  for (const date of dateRange(input.fromKey, input.toKey)) {
    if (!withData.has(date)) continue;
    const dayType = dayTypeOfKey(date);
    const band = dailyBand(input.baseline, dayType);
    if (!band) continue;
    days.push({ date, dayType, baselineKwh: band.meanKwh, bandHalfKwh: band.halfWidthKwh, actualKwh: actual[date] || 0 });
  }
  return days;
}

/**
 * Cumulative savings of a list of daily comparisons.
 * @param {{days: Array<{date: string, baselineKwh: number, actualKwh: number, bandHalfKwh?: number}>,
 *   tariffs: Array<{copPerKwh: number, effectiveFrom: string}>}} input
 * @returns {{days: number, baselineKwh: number, actualKwh: number, savingsKwh: number, savingsCop: number,
 *   lowKwh: number, highKwh: number, lowCop: number, highCop: number, perDay: Array<{date: string, savingsKwh: number, savingsCop: number}>}}
 * @throws {RangeError} when a day has no valid tariff.
 */
function cumulativeSavings(input) {
  const perDay = input.days.map((d) => {
    const band = d.bandHalfKwh ?? 0;
    const kwh = d.baselineKwh - d.actualKwh;
    return {
      date: d.date, savingsKwh: kwh, savingsCop: costOfKwh(kwh, input.tariffs, d.date),
      lowKwh: kwh - band, highKwh: kwh + band, lowCop: costOfKwh(kwh - band, input.tariffs, d.date), highCop: costOfKwh(kwh + band, input.tariffs, d.date),
    };
  });
  return {
    days: perDay.length,
    baselineKwh: sum(input.days.map((d) => d.baselineKwh)),
    actualKwh: sum(input.days.map((d) => d.actualKwh)),
    savingsKwh: sum(perDay.map((d) => d.savingsKwh)),
    savingsCop: sum(perDay.map((d) => d.savingsCop)),
    lowKwh: sum(perDay.map((d) => d.lowKwh)),
    highKwh: sum(perDay.map((d) => d.highKwh)),
    lowCop: sum(perDay.map((d) => d.lowCop)),
    highCop: sum(perDay.map((d) => d.highCop)),
    perDay: perDay.map(({ date, savingsKwh, savingsCop }) => ({ date, savingsKwh, savingsCop })),
  };
}

/**
 * Payback period of the investment.
 * @param {{investmentCop: number, savings: {days: number, savingsCop: number, lowCop: number, highCop: number}}} input
 *   `savings` is the result of cumulativeSavings.
 * @returns {{status: 'not_estimable', investmentCop: number, message: string}
 *   | {status: 'estimated', investmentCop: number, months: number, minMonths: number, maxMonths: (number|null),
 *      avgMonthlySavingsCop: number, message: string}} `maxMonths` is null when the low end of the band is not a saving.
 */
function estimatePayback(input) {
  const { investmentCop, savings } = input;
  const monthly = (cop) => (savings.days > 0 ? (cop / savings.days) * DEFAULTS.DAYS_PER_MONTH : 0);
  const avg = monthly(savings.savingsCop);
  if (!(avg > 0)) {
    return {
      status: 'not_estimable', investmentCop,
      message: 'Retorno no estimable: todavía no hay un ahorro positivo frente a la línea base para calcular cuándo se recupera la inversión.',
    };
  }
  const high = monthly(savings.highCop);
  const low = monthly(savings.lowCop);
  const months = investmentCop / avg;
  const minMonths = investmentCop / Math.max(high, avg);
  const maxMonths = low > 0 ? investmentCop / low : null;
  const range = maxMonths === null ? `desde ${formatNumber(minMonths, 1)} meses` : `entre ${formatNumber(minMonths, 1)} y ${formatNumber(maxMonths, 1)} meses`;
  return {
    status: 'estimated', investmentCop, months, minMonths, maxMonths, avgMonthlySavingsCop: avg,
    message: `La inversión de ${formatCop(investmentCop)} se recuperaría en unos ${formatNumber(months, 1)} meses (${range}).`,
  };
}

/**
 * Savings attributable to one accepted recommendation (RF-14).
 * @param {{recommendation: {acceptedAt: (string|number|Date)}, readings: Array, baseline: object,
 *   tariffs: Array, now: (string|number|Date), offsetMinutes?: number, windowDays?: number, maxDays?: number}} input
 *   `baseline` must be the reference baseline computed with asOf = acceptance instant. `readings` are those of the affected load.
 * @returns {{status: 'measuring', dayN: number, requiredDays: number, message: string}
 *   | {status: 'inconclusive', reason: string, daysMeasured: number, differenceKwh?: number, bandKwh?: number, message: string}
 *   | {status: 'conclusive', direction: 'saving'|'increase', daysMeasured: number, savingsKwh: number, savingsCop: number,
 *      differenceKwh: number, bandKwh: number, message: string}}
 */
function attributableSavings(input) {
  const offset = input.offsetMinutes ?? DEFAULTS.UTC_OFFSET_MINUTES;
  const windowDays = input.windowDays ?? DEFAULTS.ATTRIBUTION_WINDOW_DAYS;
  const maxDays = input.maxDays ?? 30;
  const acceptedKey = localDateKey(input.recommendation.acceptedAt, offset);
  const todayKey = localDateKey(input.now, offset);
  const firstKey = addDays(acceptedKey, 1);
  const completeDays = Math.max(0, dateRange(firstKey, addDays(todayKey, -1)).length);
  if (completeDays < windowDays) {
    const dayN = Math.min(windowDays, completeDays + 1);
    return { status: 'measuring', dayN, requiredDays: windowDays, message: `En medición (día ${dayN} de ${windowDays})` };
  }
  const lastKey = addDays(todayKey, -1) < addDays(firstKey, maxDays - 1) ? addDays(todayKey, -1) : addDays(firstKey, maxDays - 1);
  const days = compareDailyToBaseline({ readings: input.readings, baseline: input.baseline, fromKey: firstKey, toKey: lastKey, offsetMinutes: offset });
  if (days.length < windowDays) {
    return {
      status: 'inconclusive', reason: 'insufficient_data', daysMeasured: days.length,
      message: 'No concluyente: todavía no hay datos suficientes del equipo para comparar contra su línea base.',
    };
  }
  const total = cumulativeSavings({ days, tariffs: input.tariffs });
  const bandKwh = sum(days.map((d) => d.bandHalfKwh));
  const differenceKwh = total.savingsKwh;
  if (Math.abs(differenceKwh) <= bandKwh) {
    return {
      status: 'inconclusive', reason: 'within_uncertainty_band', daysMeasured: days.length, differenceKwh, bandKwh,
      message: 'No concluyente: la diferencia con la línea base está dentro del margen normal de variación del equipo.',
    };
  }
  const direction = differenceKwh > 0 ? 'saving' : 'increase';
  const lead = direction === 'saving'
    ? `Ahorro atribuible: ${formatNumber(differenceKwh, 1)} kWh (${formatCop(total.savingsCop)}) en ${days.length} días.`
    : `El consumo subió ${formatNumber(-differenceKwh, 1)} kWh (${formatCop(-total.savingsCop)}) en ${days.length} días frente a la línea base.`;
  return {
    status: 'conclusive', direction, daysMeasured: days.length, savingsKwh: differenceKwh, savingsCop: total.savingsCop, differenceKwh, bandKwh,
    message: `${lead} ${HONEST_NOTE}`,
  };
}

/**
 * Whether a computed figure agrees with a manual calculation (default tolerance +-2 %).
 * @param {number} computed
 * @param {number} manual
 * @param {number} [tolerance] Relative tolerance.
 * @returns {boolean}
 */
function matchesManual(computed, manual, tolerance = DEFAULTS.CALC_TOLERANCE_SAVINGS) {
  return withinTolerance(computed, manual, tolerance);
}

module.exports = { HONEST_NOTE, compareDailyToBaseline, cumulativeSavings, estimatePayback, attributableSavings, matchesManual };
