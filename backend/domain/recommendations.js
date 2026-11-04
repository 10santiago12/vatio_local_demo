'use strict';
/**
 * Recommendation generation and scoring (RF-05, HU-05; calculation rule 6).
 *
 * Types (matching the recommendations table):
 *  - off_hours_shutdown: the load consumes outside operating hours on most days.
 *  - schedule: same waste, but only on some days (a schedule is the better fix than a manual habit).
 *  - reduce_standby: the load idles in a low-power state while the site is open.
 *  - maintenance_review: a predictive-maintenance alert is active for the load.
 *  - replacement: measured operating power is persistently >= 25 % above the rated power.
 *
 * Monthly savings assumption (always stored in `assumption`): average kWh per day of the wasted
 * consumption over the last `lookbackDays` days * 30 days * tariff valid today. Standby reduction
 * assumes half of the standby energy can be removed.
 *
 * Score = normalizedSavings (0-100, relative to the largest estimated saving of the batch)
 *         * criticalityFactor (non-essential 1.0, essential 0.6, critical 0.3) * confidence (0-1).
 *
 * HARD RULES: (1) a CRITICAL load only ever receives maintenance_review or replacement, never a
 * suggestion to switch it off or schedule it; (2) loads whose baseline is `building` get no
 * recommendations at all. Results are sorted by score, highest first.
 */

const { CRITICALITY, CRITICALITY_FACTOR, CRITICALITY_LABEL, DEFAULTS, RECOMMENDATION_TYPE } = require('./constants');
const { energySegments, tariffAt } = require('./cost');
const { clamp, mean, percentile, round } = require('./stats');
const { formatCop, formatNumber } = require('./text');
const { toMs, localDateKey, localDayStartMs, addDays, isOperatingHours } = require('./time');

const MIN_WASTE_KWH_PER_DAY = 0.05;
const STANDBY_REDUCTION_SHARE = 0.5;
const REPLACEMENT_RATIO = 1.25;
const MAX_CONFIDENCE_DAYS = 30;
const SWITCH_OFF_TYPES = [RECOMMENDATION_TYPE.OFF_HOURS_SHUTDOWN, RECOMMENDATION_TYPE.SCHEDULE, RECOMMENDATION_TYPE.REDUCE_STANDBY];

/**
 * Whether a recommendation type may be proposed for a criticality (hard safety rule).
 * @param {string} criticality
 * @param {string} type
 * @returns {boolean}
 */
function isRecommendationAllowed(criticality, type) {
  if (criticality === CRITICALITY.CRITICAL) return !SWITCH_OFF_TYPES.includes(type);
  return true;
}

/**
 * Normalized savings, criticality factor and final score of one recommendation.
 * @param {{monthlySavingsCop: number, maxSavingsCop: number, criticality: string, confidence: number}} input
 * @returns {{normalizedSavings: number, criticalityFactor: number, confidence: number, score: number, scoreExplanation: string}}
 */
function scoreRecommendation(input) {
  const factor = CRITICALITY_FACTOR[input.criticality] ?? CRITICALITY_FACTOR.essential;
  const normalized = input.maxSavingsCop > 0 ? round(clamp((input.monthlySavingsCop / input.maxSavingsCop) * 100, 0, 100), 2) : 0;
  const confidence = round(clamp(input.confidence, 0, 1), 2);
  const score = round(normalized * factor * confidence, 2);
  const label = CRITICALITY_LABEL[input.criticality] || CRITICALITY_LABEL.essential;
  return {
    normalizedSavings: normalized, criticalityFactor: factor, confidence, score,
    scoreExplanation: `Puntaje ${formatNumber(score, 2)} = ahorro normalizado ${formatNumber(normalized, 2)} (de 100) × factor de criticidad ${formatNumber(factor, 1)} (${label}) × confianza ${formatNumber(confidence, 2)}.`,
  };
}

/**
 * Confidence grows with the days of evidence: 0.4 with the 7-day minimum up to 1.0 with 30 days.
 * @param {number} sampleDays
 * @returns {number}
 */
function confidenceFromDays(sampleDays) {
  return round(0.4 + 0.6 * clamp((sampleDays - DEFAULTS.MIN_BASELINE_DAYS) / (MAX_CONFIDENCE_DAYS - DEFAULTS.MIN_BASELINE_DAYS), 0, 1), 2);
}

/**
 * Measure the waste patterns of one load over its last complete days.
 * @param {{readings: Array, schedule: Array, now: (number|string|Date), offsetMinutes?: number, lookbackDays?: number}} input
 * @returns {{sampleDays: number, offHoursKwhPerDay: number, offHoursDayShare: number, standbyKwhPerDay: number,
 *   meanOperatingW: number, operatingShare: number}}
 */
function analyzeUsage(input) {
  const offset = input.offsetMinutes ?? DEFAULTS.UTC_OFFSET_MINUTES;
  const lookback = input.lookbackDays ?? 14;
  const todayKey = localDateKey(input.now, offset);
  const firstKey = addDays(todayKey, -lookback);
  const from = localDayStartMs(firstKey, offset);
  const to = localDayStartMs(todayKey, offset);
  const inRange = input.readings.filter((r) => toMs(r.ts) >= from && toMs(r.ts) < to);
  const days = [...new Set(inRange.map((r) => localDateKey(r.ts, offset)))];
  // Integrate with the next reading included so the last interval before the cutoff is closed.
  const segments = energySegments(input.readings.filter((r) => toMs(r.ts) >= from)).filter((s) => s.startMs < to);
  const open = segments.filter((s) => isOperatingHours(input.schedule, s.startMs, offset));
  const p95 = percentile(open.map((s) => s.powerW), 95);
  const standbyMax = 0.2 * p95;
  const perDay = (list) => {
    const byDay = {};
    for (const s of list) byDay[localDateKey(s.startMs, offset)] = (byDay[localDateKey(s.startMs, offset)] || 0) + s.kwh;
    return days.map((d) => byDay[d] || 0);
  };
  const offDaily = perDay(segments.filter((s) => !isOperatingHours(input.schedule, s.startMs, offset)));
  const standbyDaily = perDay(open.filter((s) => s.powerW > 2 && s.powerW < standbyMax));
  const allPowers = inRange.map((r) => r.powerW);
  const operatingMin = 0.5 * percentile(allPowers, 90);
  const operating = allPowers.filter((w) => w > 0 && w >= operatingMin);
  return {
    sampleDays: days.length,
    offHoursKwhPerDay: mean(offDaily),
    offHoursDayShare: days.length ? offDaily.filter((k) => k >= MIN_WASTE_KWH_PER_DAY).length / days.length : 0,
    standbyKwhPerDay: mean(standbyDaily),
    meanOperatingW: mean(operating),
    operatingShare: allPowers.length ? operating.length / allPowers.length : 0,
  };
}

function candidate(load, type, fields) {
  return { loadId: load.id, loadName: load.name, criticality: load.criticality, type, ...fields };
}

function candidatesForLoad(entry, context, tariff) {
  const { load } = entry;
  const usage = analyzeUsage({ readings: entry.readings, schedule: context.schedule, now: context.now, offsetMinutes: context.offsetMinutes, lookbackDays: context.lookbackDays });
  const days = usage.sampleDays;
  const confidence = confidenceFromDays(entry.baseline.sampleDays ?? days);
  const perKwh = tariff.copPerKwh;
  const out = [];
  const name = load.name;
  const monthly = (kwhPerDay) => kwhPerDay * DEFAULTS.DAYS_PER_MONTH;

  if (load.criticality !== CRITICALITY.CRITICAL && usage.offHoursKwhPerDay >= MIN_WASTE_KWH_PER_DAY) {
    const kwh = monthly(usage.offHoursKwhPerDay);
    const regular = usage.offHoursDayShare >= 0.5;
    out.push(candidate(load, regular ? RECOMMENDATION_TYPE.OFF_HOURS_SHUTDOWN : RECOMMENDATION_TYPE.SCHEDULE, {
      title: regular ? `Apagar ${name} cuando el local esté cerrado` : `Programar el apagado de ${name} al cierre`,
      description: regular
        ? `${name} sigue consumiendo fuera del horario de atención casi todos los días.`
        : `${name} se queda encendido fuera del horario de atención algunos días. Un apagado programado evita el olvido.`,
      monthlySavingsKwh: kwh, confidence,
      assumption: `Supuesto: se ahorra el consumo promedio fuera de horario (${formatNumber(usage.offHoursKwhPerDay, 2)} kWh al día en los últimos ${days} días) × ${DEFAULTS.DAYS_PER_MONTH} días × tarifa de ${formatCop(perKwh)} por kWh.`,
      evidence: { offHoursKwhPerDay: round(usage.offHoursKwhPerDay, 3), offHoursDayShare: round(usage.offHoursDayShare, 2), sampleDays: days },
    }));
  }
  if (load.criticality !== CRITICALITY.CRITICAL && usage.standbyKwhPerDay >= MIN_WASTE_KWH_PER_DAY) {
    const kwh = monthly(usage.standbyKwhPerDay) * STANDBY_REDUCTION_SHARE;
    out.push(candidate(load, RECOMMENDATION_TYPE.REDUCE_STANDBY, {
      title: `Reducir el consumo en espera de ${name}`,
      description: `${name} pasa tiempo encendido sin trabajar, aun con el local abierto.`,
      monthlySavingsKwh: kwh, confidence,
      assumption: `Supuesto: se elimina el ${STANDBY_REDUCTION_SHARE * 100} % del consumo en espera (${formatNumber(usage.standbyKwhPerDay, 2)} kWh al día) × ${DEFAULTS.DAYS_PER_MONTH} días × tarifa de ${formatCop(perKwh)} por kWh.`,
      evidence: { standbyKwhPerDay: round(usage.standbyKwhPerDay, 3), sampleDays: days },
    }));
  }
  const alert = entry.maintenanceAlert;
  if (alert) {
    const kwh = alert.projectedMonthlyCostCop ? alert.projectedMonthlyCostCop / perKwh : 0;
    out.push(candidate(load, RECOMMENDATION_TYPE.MAINTENANCE_REVIEW, {
      title: `Revisar ${name}: consume más de lo habitual`,
      description: `${name} gasta más energía cuando funciona. Una revisión a tiempo evita una falla y un sobrecosto.`,
      monthlySavingsKwh: kwh, confidence,
      assumption: `Supuesto: el sobreconsumo detectado en la alerta de mantenimiento (${formatNumber(alert.excessPct ?? 0, 0)} %) se corrige y vuelve al promedio histórico.`,
      evidence: { alertType: alert.type, excessPct: alert.excessPct ?? null },
    }));
  } else if (load.typicalPowerW > 0 && usage.meanOperatingW > load.typicalPowerW * REPLACEMENT_RATIO) {
    const excessKw = (usage.meanOperatingW - load.typicalPowerW) / 1000;
    const kwh = excessKw * usage.operatingShare * 24 * DEFAULTS.DAYS_PER_MONTH;
    out.push(candidate(load, RECOMMENDATION_TYPE.REPLACEMENT, {
      title: `Considerar reemplazar ${name}`,
      description: `${name} gasta de forma constante bastante más que lo esperado para un equipo de su tipo.`,
      monthlySavingsKwh: kwh, confidence,
      assumption: `Supuesto: un equipo nuevo consume su potencia nominal (${formatNumber(load.typicalPowerW, 0)} W) en lugar de ${formatNumber(usage.meanOperatingW, 0)} W medidos, durante el mismo tiempo de uso.`,
      evidence: { meanOperatingW: round(usage.meanOperatingW, 1), ratedPowerW: load.typicalPowerW },
    }));
  }
  return out;
}

/**
 * Generate, score and sort the recommendations of a site.
 * @param {{loads: Array<{load: {id: number, name: string, criticality: string, typicalPowerW?: number},
 *   baseline: object, readings: Array, maintenanceAlert?: object}>, schedule: Array, tariffs: Array,
 *   now: (number|string|Date), offsetMinutes?: number, lookbackDays?: number}} input
 * @returns {Array<{loadId: number, loadName: string, criticality: string, type: string, title: string, description: string,
 *   assumption: string, monthlySavingsKwh: number, monthlySavingsCop: number, confidence: number, normalizedSavings: number,
 *   criticalityFactor: number, score: number, scoreExplanation: string, evidence: object}>} Highest score first.
 * @throws {RangeError} when no tariff is valid today.
 */
function generateRecommendations(input) {
  const tariff = tariffAt(input.tariffs, localDateKey(input.now, input.offsetMinutes ?? DEFAULTS.UTC_OFFSET_MINUTES));
  if (!tariff) throw new RangeError('No tariff valid today: recommendations need a price per kWh');
  const raw = [];
  for (const entry of input.loads) {
    if (!entry.baseline || entry.baseline.status !== 'ready') continue;
    for (const c of candidatesForLoad(entry, input, tariff)) {
      if (!isRecommendationAllowed(c.criticality, c.type)) continue;
      raw.push({ ...c, monthlySavingsKwh: round(c.monthlySavingsKwh, 2), monthlySavingsCop: round(c.monthlySavingsKwh * tariff.copPerKwh, 0) });
    }
  }
  const maxCop = Math.max(0, ...raw.map((r) => r.monthlySavingsCop));
  return raw
    .map((r) => ({ ...r, ...scoreRecommendation({ monthlySavingsCop: r.monthlySavingsCop, maxSavingsCop: maxCop, criticality: r.criticality, confidence: r.confidence }) }))
    .sort((a, b) => b.score - a.score || b.monthlySavingsCop - a.monthlySavingsCop || a.loadId - b.loadId || a.type.localeCompare(b.type));
}

module.exports = { isRecommendationAllowed, scoreRecommendation, confidenceFromDays, analyzeUsage, generateRecommendations };
