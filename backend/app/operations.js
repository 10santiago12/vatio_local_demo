'use strict';
/**
 * Operations read models (RF-01..RF-03, HU-01..HU-03): the load list, the detail of one load and the
 * simple view for non-technical people.
 *
 * The simple view never carries voltage, current, power factor or error codes; the technical block of
 * the detail is only added for roles that may see diagnostics.
 */
const { CRITICALITY_LABEL } = require('../domain/constants');
const { can } = require('../domain/permissions');
const { MS_PER_DAY, localDateKey, localDayStartMs, localParts, dayTypeOfKey, addDays } = require('../domain/time');
const { formatCop, formatNumber } = require('../domain/text');
const { round } = require('../domain/stats');
const { badRequest, notFound } = require('../http/http-error');
const { modulesByLoad, communicationOf, statusOf, STATUS_TEXT } = require('./module-state');

const STALE_SECONDS = 60;
const PERIODS = Object.freeze({ today: 'today', '7d': 7, '30d': 30 });
const iso = (ms) => new Date(ms).toISOString();

/** @param {{repos: object, clock: {now: function(): number}, analytics: object, recommendations: object}} deps */
function createOperations({ repos, clock, analytics, recommendations }) {
  function periodRange(period, nowMs) {
    if (!Object.prototype.hasOwnProperty.call(PERIODS, period)) throw badRequest('El periodo debe ser today, 7d o 30d.', 'invalid_period');
    const todayStart = analytics.dayStart(nowMs);
    return { from: PERIODS[period] === 'today' ? todayStart : todayStart - (PERIODS[period] - 1) * MS_PER_DAY, to: nowMs + 1 };
  }

  function currentReading(loadId, nowMs) {
    const r = repos.readings.latest(loadId);
    if (!r) return { powerW: null, at: null, ageSeconds: null, stale: true, row: null };
    const ageSeconds = Math.max(0, Math.round((nowMs - Date.parse(r.ts)) / 1000));
    return { powerW: r.power_w, at: r.ts, ageSeconds, stale: ageSeconds > STALE_SECONDS, row: r };
  }

  function activeAlertsByLoad(siteId) {
    const map = new Map();
    for (const a of repos.alerts.list({ siteId, status: 'active', limit: 1000 })) map.set(a.load_id, (map.get(a.load_id) || 0) + 1);
    return map;
  }

  function listLoads(siteId, { sort = 'consumption', criticality, status, period = 'today' } = {}) {
    const nowMs = clock.now();
    const range = periodRange(period, nowMs);
    const tariffs = analytics.tariffsOf(siteId);
    const todayStart = analytics.dayStart(nowMs);
    const modules = modulesByLoad(repos, siteId);
    const alertCounts = activeAlertsByLoad(siteId);
    let rows = repos.loads.listBySite(siteId).map((load) => {
      const module_ = modules.get(load.id) || null;
      const comm = communicationOf(module_, nowMs);
      const moduleStatus = statusOf(module_, comm);
      const reading = currentReading(load.id, nowMs);
      const today = analytics.energy(load.id, todayStart, nowMs + 1, tariffs);
      const inPeriod = period === 'today' ? today : analytics.energy(load.id, range.from, range.to, tariffs);
      const baseline = analytics.baselineOf(load);
      return {
        id: load.id, code: load.code, name: load.name, icon: load.icon, criticality: load.criticality, criticalityLabel: CRITICALITY_LABEL[load.criticality],
        controlMode: load.control_mode, powerState: load.power_state,
        currentPowerW: reading.powerW, dataAgeSeconds: reading.ageSeconds, stale: reading.stale,
        todayKwh: round(today.kwh, 3), todayCostCop: Math.round(today.cop),
        periodKwh: round(inPeriod.kwh, 3), periodCostCop: Math.round(inPeriod.cop),
        moduleId: module_ ? module_.id : null, moduleStatus, moduleStatusText: STATUS_TEXT[moduleStatus],
        activeAlerts: alertCounts.get(load.id) || 0,
        baseline: baseline.status === 'ready' ? { status: 'ready' } : { status: 'building', dayN: baseline.dayN, requiredDays: baseline.requiredDays },
      };
    });
    if (criticality) {
      if (!Object.prototype.hasOwnProperty.call(CRITICALITY_LABEL, criticality)) throw badRequest('La criticidad debe ser critical, essential o non_essential.', 'invalid_filter');
      rows = rows.filter((r) => r.criticality === criticality);
    }
    if (status) rows = rows.filter((r) => r.moduleStatus === status);
    const sorters = {
      consumption: (a, b) => b.periodKwh - a.periodKwh,
      cost: (a, b) => b.periodCostCop - a.periodCostCop,
      name: (a, b) => a.name.localeCompare(b.name, 'es'),
    };
    if (!sorters[sort]) throw badRequest('El orden debe ser consumption, cost o name.', 'invalid_sort');
    rows.sort(sorters[sort]);
    return { period, generatedAt: iso(nowMs), loads: rows };
  }

  function loadDetail(siteId, loadKey, role) {
    const load = /^\d+$/.test(String(loadKey)) ? repos.loads.get(Number(loadKey)) : repos.loads.getByCode(siteId, loadKey);
    if (!load || load.site_id !== siteId) throw notFound('No existe ese equipo.', 'load_not_found');
    const nowMs = clock.now();
    const tariffs = analytics.tariffsOf(siteId);
    const todayStart = analytics.dayStart(nowMs);
    const parts = localParts(nowMs);
    const monthStart = localDayStartMs(`${parts.date.slice(0, 7)}-01`);
    const module_ = modulesByLoad(repos, siteId).get(load.id) || null;
    const comm = communicationOf(module_, nowMs);
    const moduleStatus = statusOf(module_, comm);
    const reading = currentReading(load.id, nowMs);
    const baseline = analytics.baselineOf(load);

    const today = analytics.energy(load.id, todayStart, nowMs + 1, tariffs);
    const month = analytics.energy(load.id, monthStart, nowMs + 1, tariffs);
    const last30 = analytics.energy(load.id, todayStart - 29 * MS_PER_DAY, nowMs + 1, tariffs);
    const todayKey = localDateKey(nowMs);
    const daily = [];
    for (let i = 29; i >= 0; i -= 1) {
      const date = addDays(todayKey, -i);
      const d = last30.byDate[date];
      if (d) daily.push({ date, kwh: round(d.kwh, 3), costCop: Math.round(d.cop), partial: date === todayKey });
    }

    let baselineOut;
    let recs = [];
    if (baseline.status === 'ready') {
      const dayType = dayTypeOfKey(todayKey);
      baselineOut = {
        status: 'ready', dayType, windowStart: baseline.windowStart, windowEnd: baseline.windowEnd, sampleDays: baseline.sampleDays,
        typicalDailyKwh: baseline.typicalDailyKwh,
        hourly: baseline.hourly[dayType].map((h) => ({ hour: h.hour, meanW: round(h.meanW, 1), bandLowW: round(h.bandLowW, 1), bandHighW: round(h.bandHighW, 1), sampleDays: h.sampleDays })),
      };
      recs = repos.recommendations.list({ siteId, loadId: load.id, status: 'pending' }).map(recommendations.present);
    } else {
      baselineOut = { status: 'building', dayN: baseline.dayN, requiredDays: baseline.requiredDays, message: baseline.message };
    }
    // Deviation alerts (consumption, maintenance, off-hours) never exist for a load still building its baseline.
    const alerts = repos.alerts.list({ siteId, loadId: load.id, status: 'active' }).map((a) => ({
      id: a.id, type: a.type, message: a.message, detectedAt: a.detected_at, excessPct: a.excess_pct,
    }));

    const detail = {
      id: load.id, code: load.code, name: load.name, criticality: load.criticality, criticalityLabel: CRITICALITY_LABEL[load.criticality],
      controlMode: load.control_mode, powerState: load.power_state,
      current: { powerW: reading.powerW, at: reading.at, dataAgeSeconds: reading.ageSeconds, stale: reading.stale },
      moduleStatus, moduleStatusText: STATUS_TEXT[moduleStatus],
      liveSeries: analytics.recent(load.id, 120, nowMs).map((p) => ({ ts: iso(p.ts), powerW: p.powerW })),
      dailyConsumption: daily,
      baseline: baselineOut,
      cost: { todayCop: Math.round(today.cop), monthCop: Math.round(month.cop), todayKwh: round(today.kwh, 3), monthKwh: round(month.kwh, 3) },
      alerts,
      recommendations: recs,
    };
    if (can(role, 'view_technical_data') || can(role, 'view_diagnostics')) {
      const row = reading.row;
      detail.technical = {
        voltageV: row ? row.voltage_v : null, currentA: row ? row.current_a : null, powerW: row ? row.power_w : null, energyKwhCounter: row ? row.energy_kwh : null,
        manufacturer: module_ ? module_.manufacturer : null, moduleId: module_ ? module_.id : null, lastReadingAt: row ? row.ts : null,
        communication: { state: comm.state, silentMinutes: comm.silentMinutes === null ? null : round(comm.silentMinutes, 1) },
      };
    }
    return detail;
  }

  /** Expected consumption (kWh) of a load from the start of today until now, according to its baseline. */
  function expectedSoFarKwh(baseline, nowMs) {
    if (baseline.status !== 'ready') return null;
    const p = localParts(nowMs);
    const hourly = baseline.hourly[dayTypeOfKey(p.date)];
    let wh = 0;
    for (let h = 0; h < p.hour; h += 1) wh += hourly[h].meanW;
    wh += hourly[p.hour].meanW * (p.minute / 60);
    return wh / 1000;
  }

  function simpleView(siteId) {
    const nowMs = clock.now();
    const tariffs = analytics.tariffsOf(siteId);
    const todayStart = analytics.dayStart(nowMs);
    const loads = repos.loads.listBySite(siteId);
    let spend = 0;
    let readyToday = 0;
    let readyExpected = 0;
    const ranking = [];
    for (const load of loads) {
      const e = analytics.energy(load.id, todayStart, nowMs + 1, tariffs);
      spend += e.cop;
      ranking.push({ loadCode: load.code, name: load.name, costCop: Math.round(e.cop), kwh: round(e.kwh, 2) });
      const expected = expectedSoFarKwh(analytics.baselineOf(load), nowMs);
      if (expected !== null) { readyToday += e.kwh; readyExpected += expected; }
    }
    ranking.sort((a, b) => b.costCop - a.costCop);
    const total = ranking.reduce((s, r) => s + r.costCop, 0) || 1;
    for (const r of ranking) r.sharePct = round((r.costCop / total) * 100, 1);

    let comparison;
    if (readyExpected > 0) {
      const pct = round((readyToday / readyExpected - 1) * 100, 1);
      const direction = pct > 5 ? 'above' : pct < -5 ? 'below' : 'similar';
      const text = direction === 'above' ? `Hoy vas ${formatNumber(Math.abs(pct), 0)} % por encima de un día normal a esta hora.`
        : direction === 'below' ? `Hoy vas ${formatNumber(Math.abs(pct), 0)} % por debajo de un día normal a esta hora.`
          : 'Hoy vas parecido a un día normal a esta hora.';
      comparison = { available: true, pct, direction, text };
    } else {
      comparison = { available: false, pct: null, direction: null, text: 'Todavía estamos aprendiendo cuánto consumes en un día normal.' };
    }

    const alerts = repos.alerts.list({ siteId, status: 'active', limit: 20 }).map((a) => ({
      id: a.id, loadCode: loads.find((l) => l.id === a.load_id)?.code ?? null, message: a.message, detectedAt: a.detected_at,
    }));
    const topRecommendations = repos.recommendations.list({ siteId, status: 'pending', limit: 3 }).map((r) => ({
      id: r.id, title: r.title, loadName: loads.find((l) => l.id === r.load_id)?.name ?? null,
      monthlySavingsCop: Math.round(r.monthly_savings_cop), text: `${r.title}. Podrías ahorrar unos ${formatCop(r.monthly_savings_cop)} al mes.`,
    }));
    return {
      generatedAt: iso(nowMs),
      todaySpendCop: Math.round(spend), todaySpendText: `Hoy llevas gastados ${formatCop(spend)} en energía.`,
      comparison, ranking, alerts, recommendations: topRecommendations,
    };
  }

  return { listLoads, loadDetail, simpleView, expectedSoFarKwh };
}

module.exports = { createOperations, STALE_SECONDS };
