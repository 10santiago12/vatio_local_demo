'use strict';
/**
 * Value read models (RF-09..RF-11, RF-14, RF-16): savings and return on investment, attributable
 * savings per accepted recommendation, the monthly report, the ODS 7 impact report and the multisite
 * comparison. Every number comes from the pure domain functions (`compareDailyToBaseline`,
 * `cumulativeSavings`, `estimatePayback`, `attributableSavings`, `avoidedEmissions`, `compareSites`);
 * this module only gathers the stored data in the shape they expect.
 *
 * Reference baseline: savings are measured against the baseline of the days BEFORE the period under
 * analysis (as of the first day of the period), so the effect being measured never feeds its own
 * baseline. Only complete local days count; today is never included.
 */
const { compareDailyToBaseline, cumulativeSavings, estimatePayback, attributableSavings, HONEST_NOTE } = require('../domain/savings');
const { avoidedEmissions } = require('../domain/emissions');
const { compareSites } = require('../domain/multisite');
const { costOfKwh } = require('../domain/cost');
const { round } = require('../domain/stats');
const { formatNumber } = require('../domain/text');
const { MS_PER_DAY, localDateKey, localDayStartMs, addDays, dateRange, countOperatingDays } = require('../domain/time');
const { badRequest, notFound } = require('../http/http-error');

const WINDOW_DAYS = 30;
const BASELINE_LOOKBACK_DAYS = 46;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

const r2 = (value) => round(value, 2);

const ATTRIBUTION_LABEL = Object.freeze({ conclusive: 'Conclusivo', inconclusive: 'No concluyente' });

/** @param {{repos: object, clock: {now: function(): number}, analytics: object}} deps */
function createValue({ repos, clock, analytics }) {
  const lastCompleteKey = (nowMs) => addDays(localDateKey(nowMs), -1);

  function requireSite(siteId) {
    const site = repos.sites.get(siteId);
    if (!site) throw notFound('No existe esa sede.', 'site_not_found');
    return site;
  }

  function parseDay(value, field) {
    if (!DATE_KEY.test(value) || Number.isNaN(Date.parse(value))) throw badRequest(`El filtro "${field}" debe tener el formato AAAA-MM-DD.`, 'invalid_filter');
    return value;
  }

  /**
   * Daily comparison of one load with the baseline computed as of the start of `fromKey`.
   * @returns {Array|null} Days, or null while the load is still building its baseline.
   */
  function compareLoad(load, fromKey, toKey) {
    const refMs = localDayStartMs(fromKey);
    const baseline = analytics.baselineOf(load, refMs);
    if (baseline.status !== 'ready') return null;
    const readings = analytics.series(load.id, refMs - BASELINE_LOOKBACK_DAYS * MS_PER_DAY, localDayStartMs(addDays(toKey, 1)));
    return compareDailyToBaseline({ readings, baseline, fromKey, toKey });
  }

  /**
   * Actual vs baseline of every load of a site over complete days [fromKey, toKey], priced per day.
   * Days before the first tariff are left out (no price exists for them).
   */
  function comparePeriod(siteId, fromKey, toKey) {
    const tariffs = analytics.tariffsOf(siteId);
    const empty = {
      fromKey, toKey, perLoad: [], days: [], tariffs, loadsWithBaseline: 0, loadsBuilding: 0,
      totals: cumulativeSavings({ days: [], tariffs }), consumptionCop: 0,
    };
    if (!tariffs.length || toKey < fromKey) return empty;
    const firstTariffKey = tariffs[0].effectiveFrom;
    const merged = new Map();
    const perLoad = [];
    let building = 0;
    for (const load of repos.loads.listBySite(siteId)) {
      const all = compareLoad(load, fromKey, toKey);
      if (all === null) { building += 1; continue; }
      const days = all.filter((d) => d.date >= firstTariffKey);
      if (!days.length) continue;
      const totals = cumulativeSavings({ days, tariffs });
      perLoad.push({
        load, totals, consumptionCop: days.reduce((s, d) => s + costOfKwh(d.actualKwh, tariffs, d.date), 0),
      });
      for (const d of days) {
        const slot = merged.get(d.date) || { date: d.date, baselineKwh: 0, actualKwh: 0, bandHalfKwh: 0 };
        slot.baselineKwh += d.baselineKwh; slot.actualKwh += d.actualKwh; slot.bandHalfKwh += d.bandHalfKwh;
        merged.set(d.date, slot);
      }
    }
    const days = [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    return {
      fromKey, toKey, perLoad, days, tariffs, loadsWithBaseline: perLoad.length, loadsBuilding: building,
      totals: cumulativeSavings({ days, tariffs }), consumptionCop: perLoad.reduce((s, l) => s + l.consumptionCop, 0),
    };
  }

  /** Accepted recommendations of the site that carry an acceptance instant. */
  const acceptedRecommendations = (siteId) => repos.recommendations.list({ siteId, status: 'accepted' }).filter((r) => r.accepted_at);

  /** First day measured by the savings view: the day after the first accepted recommendation (or 30 days back). */
  function savingsPeriod(siteId, nowMs) {
    const accepted = acceptedRecommendations(siteId).map((r) => Date.parse(r.accepted_at));
    const refKey = accepted.length ? localDateKey(Math.min(...accepted)) : addDays(localDateKey(nowMs), -WINDOW_DAYS);
    return { fromKey: addDays(refKey, 1), toKey: lastCompleteKey(nowMs), basedOn: accepted.length ? 'first_accepted_recommendation' : 'last_30_days' };
  }

  function paybackView(payback) {
    if (payback.status === 'not_estimable') {
      return { status: 'not_estimable', label: 'Retorno no estimable', investmentCop: Math.round(payback.investmentCop), message: payback.message };
    }
    return {
      status: 'estimated', label: `${formatNumber(payback.months, 1)} meses`, investmentCop: Math.round(payback.investmentCop),
      months: round(payback.months, 1), minMonths: round(payback.minMonths, 1), maxMonths: payback.maxMonths === null ? null : round(payback.maxMonths, 1),
      avgMonthlySavingsCop: Math.round(payback.avgMonthlySavingsCop), message: payback.message,
    };
  }

  /** Weekly (7-day buckets from the first day) actual vs baseline. */
  function weeklySeries(days) {
    const weeks = [];
    for (let i = 0; i < days.length; i += 7) {
      const chunk = days.slice(i, i + 7);
      weeks.push({
        weekStart: chunk[0].date, weekEnd: chunk[chunk.length - 1].date, days: chunk.length,
        baselineKwh: r2(chunk.reduce((s, d) => s + d.baselineKwh, 0)), actualKwh: r2(chunk.reduce((s, d) => s + d.actualKwh, 0)),
      });
    }
    return weeks;
  }

  function savings(siteId) {
    requireSite(siteId);
    const nowMs = clock.now();
    const period = savingsPeriod(siteId, nowMs);
    const cmp = comparePeriod(siteId, period.fromKey, period.toKey);
    const investmentCop = repos.settings.get(siteId).investment_cop;
    const payback = estimatePayback({ investmentCop, savings: cmp.totals });
    let running = 0;
    const cumulative = cmp.totals.perDay.map((d) => {
      running += d.savingsCop;
      return { date: d.date, savingsCop: Math.round(running), investmentCop: Math.round(investmentCop) };
    });
    return {
      siteId,
      period: { from: period.fromKey, to: period.toKey, days: cmp.totals.days, basedOn: period.basedOn },
      loadsWithBaseline: cmp.loadsWithBaseline, loadsBuilding: cmp.loadsBuilding,
      baselineKwh: r2(cmp.totals.baselineKwh), actualKwh: r2(cmp.totals.actualKwh),
      cumulativeSavingsKwh: r2(cmp.totals.savingsKwh), cumulativeSavingsCop: Math.round(cmp.totals.savingsCop),
      rangeCop: { low: Math.round(cmp.totals.lowCop), high: Math.round(cmp.totals.highCop) },
      investmentCop: Math.round(investmentCop),
      payback: paybackView(payback),
      weekly: weeklySeries(cmp.days), cumulative,
      note: HONEST_NOTE,
    };
  }

  function attributable(siteId) {
    requireSite(siteId);
    const nowMs = clock.now();
    const tariffs = analytics.tariffsOf(siteId);
    const items = acceptedRecommendations(siteId).map((rec) => {
      const load = repos.loads.get(rec.load_id);
      const acceptedMs = Date.parse(rec.accepted_at);
      const baseline = analytics.baselineOf(load, acceptedMs);
      const readings = analytics.series(load.id, acceptedMs - BASELINE_LOOKBACK_DAYS * MS_PER_DAY, nowMs);
      const result = tariffs.length
        ? attributableSavings({ recommendation: { acceptedAt: rec.accepted_at }, readings, baseline, tariffs, now: nowMs })
        : { status: 'inconclusive', reason: 'no_tariff', daysMeasured: 0, message: 'No concluyente: todavía no hay una tarifa registrada para valorar el ahorro.' };
      const item = {
        recommendationId: rec.id, title: rec.title, loadCode: load.code, loadName: load.name, acceptedAt: rec.accepted_at,
        status: result.status, label: result.status === 'measuring' ? result.message : ATTRIBUTION_LABEL[result.status], message: result.message,
        disclaimer: HONEST_NOTE,
      };
      if (result.status === 'measuring') { item.dayN = result.dayN; item.requiredDays = result.requiredDays; }
      if (result.status !== 'measuring') item.daysMeasured = result.daysMeasured;
      if (result.status === 'conclusive') {
        item.direction = result.direction; item.savingsKwh = r2(result.savingsKwh); item.savingsCop = Math.round(result.savingsCop);
      }
      if (result.status === 'inconclusive' && result.differenceKwh !== undefined) { item.differenceKwh = r2(result.differenceKwh); item.bandKwh = r2(result.bandKwh); }
      return item;
    });
    return { siteId, items, disclaimer: HONEST_NOTE };
  }

  /** Complete days of a month up to yesterday. */
  function monthRange(month, nowMs) {
    const match = MONTH_KEY.exec(month);
    if (!match) throw badRequest('El mes debe tener el formato AAAA-MM.', 'invalid_month');
    const [, year, mm] = match;
    const next = Number(mm) === 12 ? `${Number(year) + 1}-01` : `${year}-${String(Number(mm) + 1).padStart(2, '0')}`;
    const fromKey = `${month}-01`;
    const monthEnd = addDays(`${next}-01`, -1);
    const yesterday = lastCompleteKey(nowMs);
    return { fromKey, toKey: monthEnd < yesterday ? monthEnd : yesterday, monthEnd, partial: monthEnd > yesterday };
  }

  function currentMonth(nowMs) {
    return localDateKey(nowMs).slice(0, 7);
  }

  /** Monthly report (RF-10): the single source for the JSON, CSV and PDF versions. */
  function monthlyReport(siteId, month) {
    const site = requireSite(siteId);
    const nowMs = clock.now();
    const key = month === undefined || month === '' ? currentMonth(nowMs) : month;
    const range = monthRange(key, nowMs);
    const cmp = comparePeriod(siteId, range.fromKey, range.toKey);
    const settings = repos.settings.get(siteId);
    const payback = savings(siteId).payback;
    const tariff = analytics.tariffsOf(siteId).filter((t) => t.effectiveFrom <= range.toKey).pop() || null;
    return {
      siteId, siteName: site.name, month: key,
      period: { from: range.fromKey, to: range.toKey, days: cmp.totals.days, partial: range.partial },
      generatedAt: new Date(nowMs).toISOString(),
      summary: {
        consumptionKwh: r2(cmp.totals.actualKwh), consumptionCostCop: Math.round(cmp.consumptionCop),
        baselineKwh: r2(cmp.totals.baselineKwh), savingsKwh: r2(cmp.totals.savingsKwh), savingsCop: Math.round(cmp.totals.savingsCop),
        investmentCop: Math.round(settings.investment_cop), paybackStatus: payback.status, paybackMonths: payback.status === 'estimated' ? payback.months : null,
        tariffCopPerKwh: tariff ? tariff.copPerKwh : null, loadsWithBaseline: cmp.loadsWithBaseline, loadsBuilding: cmp.loadsBuilding,
      },
      loads: cmp.perLoad.map((l) => ({
        code: l.load.code, name: l.load.name, consumptionKwh: r2(l.totals.actualKwh), consumptionCostCop: Math.round(l.consumptionCop),
        baselineKwh: r2(l.totals.baselineKwh), savingsKwh: r2(l.totals.savingsKwh), savingsCop: Math.round(l.totals.savingsCop),
      })).sort((a, b) => b.consumptionCostCop - a.consumptionCostCop),
      recommendations: attributable(siteId).items.map((i) => ({
        title: i.title, loadName: i.loadName, acceptedAt: i.acceptedAt, label: i.label, savingsKwh: i.savingsKwh ?? null, savingsCop: i.savingsCop ?? null,
      })),
      note: `${HONEST_NOTE} Solo se cuentan días completos del mes.`,
    };
  }

  /** ODS 7 impact report (RF-16): kWh avoided, reduction against the baseline and avoided kgCO2e. */
  function impactReport(siteId, { from, to } = {}) {
    const site = requireSite(siteId);
    const nowMs = clock.now();
    const toKey = to ? parseDay(to, 'to') : lastCompleteKey(nowMs);
    const fromKey = from ? parseDay(from, 'from') : addDays(toKey, -(WINDOW_DAYS - 1));
    if (fromKey > toKey) throw badRequest('La fecha inicial debe ser anterior a la final.', 'invalid_period');
    if (toKey > lastCompleteKey(nowMs)) throw badRequest('El reporte solo incluye días completos: la fecha final debe ser anterior a hoy.', 'invalid_period');
    const cmp = comparePeriod(siteId, fromKey, toKey);
    const settings = repos.settings.get(siteId);
    const avoidedKwh = r2(cmp.totals.savingsKwh);
    const baselineKwh = r2(cmp.totals.baselineKwh);
    const result = avoidedEmissions({
      avoidedKwh, baselineKwh, factorKgPerKwh: settings.emission_factor_kg_per_kwh, factorSource: settings.emission_factor_source,
      periodStart: localDayStartMs(fromKey), periodEnd: localDayStartMs(addDays(toKey, 1)),
    });
    return {
      siteId, siteName: site.name, generatedAt: new Date(nowMs).toISOString(),
      period: { from: fromKey, to: toKey, days: cmp.totals.days },
      avoidedKwh, baselineKwh, actualKwh: r2(cmp.totals.actualKwh), reductionPct: result.reductionPct, avoidedKgCo2e: r2(result.avoidedKgCo2e),
      emissionFactorKgPerKwh: result.factorKgPerKwh, emissionFactorSource: result.factorSource, methodology: result.methodology,
      loadsWithBaseline: cmp.loadsWithBaseline,
    };
  }

  /** Multisite comparison (RF-09), normalized per operating day. */
  function multisite(siteId, { days = WINDOW_DAYS } = {}) {
    const count = Number(days);
    if (!Number.isInteger(count) || count < 7 || count > 45) throw badRequest('El periodo debe ser de 7 a 45 días.', 'invalid_period');
    const nowMs = clock.now();
    const toKey = lastCompleteKey(nowMs);
    const fromKey = addDays(toKey, -(count - 1));
    const sites = repos.sites.list().map((site) => {
      const cmp = comparePeriod(site.id, fromKey, toKey);
      return {
        siteId: site.id, name: site.name, consumptionKwh: cmp.totals.actualKwh, costCop: cmp.consumptionCop, savingsCop: cmp.totals.savingsCop,
        baselineKwh: cmp.totals.baselineKwh, operatingDays: countOperatingDays(analytics.scheduleOf(site.id), fromKey, toKey), savingsKwh: cmp.totals.savingsKwh,
      };
    });
    const reference = repos.settings.get(siteId).sector_reference_kwh_per_day;
    const result = compareSites({ sites, sectorReferenceKwhPerDay: reference ?? undefined });
    const extras = new Map(sites.map((s) => [s.siteId, s]));
    return {
      period: { from: fromKey, to: toKey, days: dateRange(fromKey, toKey).length },
      sectorReferenceKwhPerDay: reference,
      highlightedSiteId: result.highlightedSiteId,
      rows: result.rows.map((row) => {
        const s = extras.get(row.siteId);
        const rr = (v) => (v === null ? null : r2(v));
        return {
          siteId: row.siteId, name: row.name, operatingDays: row.operatingDays, consumptionKwh: r2(s.consumptionKwh), baselineKwh: r2(s.baselineKwh),
          kwhPerOperatingDay: rr(row.kwhPerOperatingDay), copPerOperatingDay: row.copPerOperatingDay === null ? null : Math.round(row.copPerOperatingDay),
          savingsCopPerOperatingDay: row.savingsCopPerOperatingDay === null ? null : Math.round(row.savingsCopPerOperatingDay),
          reductionPct: row.reductionPct, vsSectorPct: row.vsSectorPct, highlighted: row.highlighted,
        };
      }),
    };
  }

  return { savings, attributable, monthlyReport, impactReport, multisite };
}

module.exports = { createValue };
