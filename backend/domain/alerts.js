'use strict';
/**
 * Alert detection rules (RF-04, RF-08, RF-15, HU-04, HU-08; calculation rules 4 and 5).
 *
 * Four independent rules, each returning {fired, reason, alert?} so the caller can log why nothing
 * fired. `detectAlerts` runs them all for a site. Alerts use the persisted shape (camelCase of the
 * alerts table) and a plain-Spanish message.
 *
 *  1. Consumption: every reading of the last `windowMinutes` (default 15) is at least
 *     baseline-of-its-hour * (1 + threshold) (default 30 %). The threshold is INCLUSIVE (30 % fires,
 *     29 % does not) and the whole window must satisfy it, so one calm minute cancels the alert.
 *     Loads whose baseline is still `building` never produce deviation alerts.
 *  2. Off hours: a non-critical load draws more than `minPowerW` during the whole window while the
 *     site is closed.
 *  3. Inactive module: no report for more than 2 minutes.
 *  4. Predictive maintenance (distinct type): mean operating power of the last 3 days is STRICTLY
 *     above the historical mean (>= 30 days of history) * 1.15. The payload carries a daily trend.
 *
 * Cost of the excess is estimated per hour and projected per month under a stated assumption
 * (stored in `details`). Pure: `now` is always an argument.
 */

const { ALERT_TYPE, CRITICALITY, DEFAULTS } = require('./constants');
const { computeBaseline, baselineSlot } = require('./baseline');
const { tariffAt } = require('./cost');
const { mean, percentile, round } = require('./stats');
const { formatCop, formatNumber } = require('./text');
const { MS_PER_DAY, MS_PER_MINUTE, toMs, toIso, localDateKey, isOperatingHours, averageClosedHoursPerDay } = require('./time');

const EPS = 1e-9;
/** Longest silence inside a window that is still considered "continuous data". */
const DEFAULT_MAX_GAP_MS = 2 * MS_PER_MINUTE;
/** Hours assumed in a month when projecting an excess that is never switched off. */
const HOURS_PER_MONTH = 24 * DEFAULTS.DAYS_PER_MONTH;

function none(reason, extra = {}) {
  return { fired: false, reason, ...extra };
}

/**
 * Readings inside [now - window, now] sorted by time, or null when they do not cover the window.
 * @param {Array<{ts: (number|string|Date), powerW: number}>} readings
 * @param {number} nowMs
 * @param {number} windowMinutes
 * @param {number} maxGapMs
 * @returns {Array<{ts: number, powerW: number}>|null}
 */
function windowSamples(readings, nowMs, windowMinutes, maxGapMs) {
  const start = nowMs - windowMinutes * MS_PER_MINUTE;
  const inside = readings.map((r) => ({ ts: toMs(r.ts), powerW: r.powerW })).filter((r) => r.ts >= start && r.ts <= nowMs).sort((a, b) => a.ts - b.ts);
  if (inside.length < 2) return null;
  if (inside[0].ts - start > maxGapMs || nowMs - inside[inside.length - 1].ts > maxGapMs) return null;
  for (let i = 1; i < inside.length; i += 1) if (inside[i].ts - inside[i - 1].ts > maxGapMs) return null;
  return inside;
}

function costPerHour(excessW, tariff) {
  return tariff ? (Math.max(0, excessW) / 1000) * tariff.copPerKwh : null;
}

/**
 * Consumption alert (rule 4): window consumption above the baseline of that time slot by the threshold.
 * @param {{load: {id: number, name: string}, baseline: object, readings: Array, tariffs: Array, now: (number|string|Date),
 *   thresholdPct?: number, windowMinutes?: number, offsetMinutes?: number, maxGapMs?: number, minBaselineW?: number}} input
 *   `baseline` is the result of computeBaseline. `minBaselineW` (default 1 W) skips slots whose reference is
 *   ~0 W: a load that should be off is the off-hours rule's job, and a percentage of zero is meaningless.
 * @returns {{fired: boolean, reason: string, alert?: object}} reasons: baseline_building, insufficient_data,
 *   no_reference, below_threshold, consumption_excess.
 */
function evaluateConsumptionAlert(input) {
  const { load, baseline, readings, tariffs, now } = input;
  const thresholdPct = input.thresholdPct ?? DEFAULTS.ALERT_THRESHOLD_PCT;
  const windowMinutes = input.windowMinutes ?? DEFAULTS.ALERT_WINDOW_MINUTES;
  const offset = input.offsetMinutes ?? DEFAULTS.UTC_OFFSET_MINUTES;
  const minBaselineW = input.minBaselineW ?? 1;
  if (!baseline || baseline.status !== 'ready') return none('baseline_building');
  const nowMs = toMs(now);
  const samples = windowSamples(readings, nowMs, windowMinutes, input.maxGapMs ?? DEFAULT_MAX_GAP_MS);
  if (!samples) return none('insufficient_data');
  const factor = 1 + thresholdPct / 100;
  const references = [];
  for (const s of samples) {
    const slot = baselineSlot(baseline, s.ts);
    if (!slot || slot.meanW < minBaselineW) return none('no_reference');
    references.push(slot.meanW);
  }
  const sustained = samples.every((s, i) => s.powerW >= references[i] * factor * (1 - EPS));
  if (!sustained) return none('below_threshold');
  const avgW = mean(samples.map((s) => s.powerW));
  const baselineW = mean(references);
  const excessPct = (avgW / baselineW - 1) * 100;
  const hourly = costPerHour(avgW - baselineW, tariffAt(tariffs, localDateKey(nowMs, offset)));
  const monthly = hourly === null ? null : hourly * HOURS_PER_MONTH;
  const costText = hourly === null ? '' : ` Te cuesta unos ${formatCop(hourly)} más por hora; si sigue así todo el mes serían unos ${formatCop(monthly)}.`;
  return {
    fired: true,
    reason: 'consumption_excess',
    alert: {
      type: ALERT_TYPE.CONSUMPTION, loadId: load.id, loadName: load.name, detectedAt: toIso(nowMs),
      excessPct: round(excessPct, 1),
      excessCostPerHourCop: hourly === null ? null : round(hourly, 0),
      projectedMonthlyCostCop: monthly === null ? null : round(monthly, 0),
      message: `${load.name} está gastando ${formatNumber(excessPct, 0)} % más de lo normal para esta hora durante los últimos ${windowMinutes} minutos.${costText}`,
      details: { thresholdPct, windowMinutes, samples: samples.length, avgPowerW: round(avgW, 1), baselineAvgW: round(baselineW, 1), monthlyHoursAssumed: HOURS_PER_MONTH },
    },
  };
}

/**
 * Off-hours alert: a non-critical load keeps consuming while the site is closed for the whole window.
 * @param {{load: {id: number, name: string, criticality: string}, readings: Array, schedule: Array, tariffs: Array,
 *   now: (number|string|Date), windowMinutes?: number, minPowerW?: number, offsetMinutes?: number, maxGapMs?: number}} input
 * @returns {{fired: boolean, reason: string, alert?: object}} reasons: critical_load, insufficient_data,
 *   within_operating_hours, below_minimum_power, off_hours_consumption.
 */
function evaluateOffHoursAlert(input) {
  const { load, readings, schedule, tariffs, now } = input;
  const windowMinutes = input.windowMinutes ?? DEFAULTS.ALERT_WINDOW_MINUTES;
  const offset = input.offsetMinutes ?? DEFAULTS.UTC_OFFSET_MINUTES;
  const minPowerW = input.minPowerW ?? 5;
  if (load.criticality === CRITICALITY.CRITICAL) return none('critical_load');
  const nowMs = toMs(now);
  const samples = windowSamples(readings, nowMs, windowMinutes, input.maxGapMs ?? DEFAULT_MAX_GAP_MS);
  if (!samples) return none('insufficient_data');
  if (samples.some((s) => isOperatingHours(schedule, s.ts, offset))) return none('within_operating_hours');
  if (!samples.every((s) => s.powerW > minPowerW)) return none('below_minimum_power');
  const avgW = mean(samples.map((s) => s.powerW));
  const hourly = costPerHour(avgW, tariffAt(tariffs, localDateKey(nowMs, offset)));
  const closedHours = averageClosedHoursPerDay(schedule);
  const perNight = hourly === null ? null : hourly * closedHours;
  const monthly = perNight === null ? null : perNight * DEFAULTS.DAYS_PER_MONTH;
  const costText = perNight === null ? '' : ` Te cuesta unos ${formatCop(perNight)} por noche.`;
  return {
    fired: true,
    reason: 'off_hours_consumption',
    alert: {
      type: ALERT_TYPE.OFF_HOURS, loadId: load.id, loadName: load.name, detectedAt: toIso(nowMs), excessPct: null,
      excessCostPerHourCop: hourly === null ? null : round(hourly, 0),
      projectedMonthlyCostCop: monthly === null ? null : round(monthly, 0),
      message: `${load.name} sigue consumiendo y el local está cerrado.${costText}`,
      details: { windowMinutes, avgPowerW: round(avgW, 1), closedHoursPerDayAssumed: round(closedHours, 2), daysPerMonthAssumed: DEFAULTS.DAYS_PER_MONTH },
    },
  };
}

/**
 * Inactive-module alert (RF-08): no report for more than `thresholdMinutes` (default 2).
 * @param {{module: {id: string, loadId?: number, loadName?: string, lastSeenAt: (string|number|Date|null)},
 *   now: (number|string|Date), thresholdMinutes?: number}} input
 * @returns {{fired: boolean, reason: string, alert?: object}} reasons: no_heartbeat_yet, reporting, module_inactive.
 */
function evaluateInactiveModuleAlert(input) {
  const { module: mod, now } = input;
  const thresholdMinutes = input.thresholdMinutes ?? DEFAULTS.MODULE_INACTIVE_MINUTES;
  if (mod.lastSeenAt === null || mod.lastSeenAt === undefined) return none('no_heartbeat_yet');
  const nowMs = toMs(now);
  const silentMinutes = (nowMs - toMs(mod.lastSeenAt)) / MS_PER_MINUTE;
  if (silentMinutes <= thresholdMinutes) return none('reporting', { silentMinutes });
  const name = mod.loadName || `el módulo ${mod.id}`;
  return {
    fired: true,
    reason: 'module_inactive',
    alert: {
      type: ALERT_TYPE.INACTIVE_MODULE, loadId: mod.loadId ?? null, loadName: mod.loadName ?? null, detectedAt: toIso(nowMs), excessPct: null,
      excessCostPerHourCop: null, projectedMonthlyCostCop: null,
      message: `No estamos recibiendo datos de ${name} desde hace ${Math.ceil(silentMinutes)} minutos. Revisa que esté conectado.`,
      details: { moduleId: mod.id, silentMinutes: round(silentMinutes, 1), thresholdMinutes },
    },
  };
}

/**
 * Predictive-maintenance alert (RF-15, rule 5). "Operating" samples are those above half of the 90th
 * percentile of the historical power, which separates compressor-on from idle without per-load tuning.
 * @param {{load: {id: number, name: string}, readings: Array, tariffs: Array, now: (number|string|Date),
 *   recentDays?: number, minHistoryDays?: number, thresholdPct?: number, offsetMinutes?: number, trendDays?: number}} input
 * @returns {{fired: boolean, reason: string, alert?: object}} reasons: insufficient_history, insufficient_recent,
 *   no_operating_data, within_normal_range, predictive_maintenance.
 */
function evaluateMaintenanceAlert(input) {
  const { load, readings, tariffs, now } = input;
  const recentDays = input.recentDays ?? DEFAULTS.MAINTENANCE_RECENT_DAYS;
  const minHistoryDays = input.minHistoryDays ?? DEFAULTS.MAINTENANCE_MIN_HISTORY_DAYS;
  const thresholdPct = input.thresholdPct ?? DEFAULTS.MAINTENANCE_THRESHOLD_PCT;
  const offset = input.offsetMinutes ?? DEFAULTS.UTC_OFFSET_MINUTES;
  const trendDays = input.trendDays ?? 14;
  const nowMs = toMs(now);
  const recentStart = nowMs - recentDays * MS_PER_DAY;
  const all = readings.map((r) => ({ ts: toMs(r.ts), powerW: r.powerW })).filter((r) => r.ts <= nowMs);
  const history = all.filter((r) => r.ts < recentStart);
  const recent = all.filter((r) => r.ts >= recentStart);
  const historyDays = new Set(history.map((r) => localDateKey(r.ts, offset))).size;
  if (historyDays < minHistoryDays) return none('insufficient_history', { historyDays });
  if (new Set(recent.map((r) => localDateKey(r.ts, offset))).size < recentDays) return none('insufficient_recent');
  const operatingMinW = 0.5 * percentile(history.map((r) => r.powerW), 90);
  const operating = (r) => r.powerW > 0 && r.powerW >= operatingMinW;
  const historyOp = history.filter(operating).map((r) => r.powerW);
  const recentOp = recent.filter(operating).map((r) => r.powerW);
  if (!historyOp.length || !recentOp.length) return none('no_operating_data');
  const historicalMeanW = mean(historyOp);
  const recentMeanW = mean(recentOp);
  if (!(recentMeanW > historicalMeanW * (1 + thresholdPct / 100) * (1 + EPS))) {
    return none('within_normal_range', { historicalMeanW, recentMeanW });
  }
  const excessPct = (recentMeanW / historicalMeanW - 1) * 100;
  const duty = recentOp.length / recent.length;
  const hourly = costPerHour((recentMeanW - historicalMeanW) * duty, tariffAt(tariffs, localDateKey(nowMs, offset)));
  const monthly = hourly === null ? null : hourly * HOURS_PER_MONTH;
  const byDay = {};
  for (const r of all.filter(operating)) (byDay[localDateKey(r.ts, offset)] = byDay[localDateKey(r.ts, offset)] || []).push(r.powerW);
  const trend = Object.keys(byDay).sort().slice(-trendDays).map((date) => ({ date, meanW: round(mean(byDay[date]), 1) }));
  const costText = monthly === null ? '' : ` Si sigue así, el sobrecosto sería de unos ${formatCop(monthly)} al mes.`;
  return {
    fired: true,
    reason: 'predictive_maintenance',
    alert: {
      type: ALERT_TYPE.MAINTENANCE, loadId: load.id, loadName: load.name, detectedAt: toIso(nowMs),
      excessPct: round(excessPct, 1),
      excessCostPerHourCop: hourly === null ? null : round(hourly, 0),
      projectedMonthlyCostCop: monthly === null ? null : round(monthly, 0),
      message: `${load.name} usa ${formatNumber(excessPct, 0)} % más energía cuando funciona, de forma sostenida en los últimos ${recentDays} días. Conviene revisarlo antes de que falle.${costText}`,
      details: {
        kind: 'predictive_maintenance', trend, historicalMeanW: round(historicalMeanW, 1), recentMeanW: round(recentMeanW, 1),
        thresholdPct, recentDays, historyDays, operatingMinW: round(operatingMinW, 1), monthlyHoursAssumed: HOURS_PER_MONTH,
      },
    },
  };
}

/**
 * Run every rule for a site and return the alerts that fired.
 * @param {{loads: Array<{id: number, name: string, criticality: string}>, modules?: Array, readingsByLoad: Object<string, Array>,
 *   baselines?: Object<string, object>, schedule: Array, tariffs: Array, now: (number|string|Date),
 *   thresholdPct?: number, windowMinutes?: number, offsetMinutes?: number}} input Baselines are computed when missing.
 * @returns {Array<object>} Alerts in the persisted shape, ordered by load then type.
 */
function detectAlerts(input) {
  const { loads, modules = [], readingsByLoad, baselines = {}, schedule, tariffs, now } = input;
  const common = { tariffs, now, offsetMinutes: input.offsetMinutes };
  const alerts = [];
  for (const load of loads) {
    const readings = readingsByLoad[load.id] || [];
    const baseline = baselines[load.id] || computeBaseline(readings, { asOf: now, offsetMinutes: input.offsetMinutes });
    const results = [
      evaluateConsumptionAlert({ ...common, load, baseline, readings, thresholdPct: input.thresholdPct, windowMinutes: input.windowMinutes }),
      evaluateOffHoursAlert({ ...common, load, readings, schedule, windowMinutes: input.windowMinutes }),
      evaluateMaintenanceAlert({ ...common, load, readings }),
    ];
    for (const r of results) if (r.fired) alerts.push(r.alert);
  }
  for (const module_ of modules) {
    const r = evaluateInactiveModuleAlert({ module: module_, now });
    if (r.fired) alerts.push(r.alert);
  }
  return alerts;
}

module.exports = {
  windowSamples, evaluateConsumptionAlert, evaluateOffHoursAlert, evaluateInactiveModuleAlert, evaluateMaintenanceAlert, detectAlerts,
};
