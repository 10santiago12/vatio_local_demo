'use strict';
/**
 * Shared read side of the application: the stored data in the shapes the pure domain expects.
 *
 *  - tariffs, schedule and settings of a site (domain shape, camelCase);
 *  - the analytics series of a load (hourly aggregates expanded + raw readings, see series.js), used for
 *    baselines, maintenance and savings because the domain integrates energy with a 10-minute maximum gap;
 *  - raw 1-minute points for the short alert windows;
 *  - energy and cost of a period priced with the tariff of each day (a tariff change only affects days
 *    from its effective date);
 *  - cached baselines (they only depend on days before the reference day, so a per-day key is enough).
 */
const { computeBaseline } = require('../domain/baseline');
const { energySegments, tariffAt } = require('../domain/cost');
const { MS_PER_MINUTE, MS_PER_DAY, localDateKey, localDayStartMs, addDays } = require('../domain/time');
const { analyticsSeries, recentReadings } = require('./series');

const iso = (ms) => new Date(ms).toISOString();
const BASELINE_LOOKBACK_DAYS = 46;

/** @param {{repos: object, clock: {now: function(): number}}} deps */
function createAnalytics({ repos, clock }) {
  const baselines = new Map();
  const nowMs = () => clock.now();

  function tariffsOf(siteId) {
    return repos.tariffs.list(siteId).map((t) => ({ copPerKwh: t.cop_per_kwh, effectiveFrom: t.effective_from }));
  }
  function scheduleOf(siteId) {
    return repos.sites.getSchedule(siteId).map((e) => ({ weekday: e.weekday, closed: Boolean(e.closed), opensAt: e.opens_at, closesAt: e.closes_at }));
  }
  function settingsOf(siteId) {
    return repos.settings.get(siteId);
  }

  /** Domain-shaped load (the controls and recommendations judge this object). */
  function domainLoad(row, moduleId = null) {
    return {
      id: row.id, name: row.name, criticality: row.criticality, controlMode: row.control_mode, powerState: row.power_state,
      typicalPowerW: row.typical_power_w, moduleId,
    };
  }

  /** Analytics series of a load in [fromMs, toMs). */
  function series(loadId, fromMs, toMs) {
    return analyticsSeries(repos, loadId, { from: iso(fromMs), to: iso(toMs) });
  }

  /** Raw 1-minute points of the last `minutes` minutes up to now (inclusive). */
  function recent(loadId, minutes, atMs = nowMs()) {
    return recentReadings(repos, loadId, { from: iso(atMs - minutes * MS_PER_MINUTE), to: iso(atMs + 1) });
  }

  /**
   * Baseline of a load as of an instant (complete days before that local day). Cached per load and day.
   * @returns {object} Result of the domain `computeBaseline` (status `building` or `ready`).
   */
  function baselineOf(load, asOfMs = nowMs()) {
    const key = `${load.id}|${localDateKey(asOfMs)}`;
    let cached = baselines.get(key);
    if (!cached) {
      const readings = series(load.id, asOfMs - BASELINE_LOOKBACK_DAYS * MS_PER_DAY, asOfMs);
      cached = computeBaseline(readings, { asOf: asOfMs });
      baselines.set(key, cached);
    }
    return cached;
  }

  /** Forget cached baselines (history rewritten, configuration changed). */
  function invalidate() {
    baselines.clear();
  }

  /**
   * Energy and cost of a load in [fromMs, toMs): hourly aggregates (older history) plus the raw readings,
   * each priced with the tariff valid on its local date (days before the first tariff cost 0).
   * @returns {{kwh: number, cop: number, byDate: Object<string, {kwh: number, cop: number}>}}
   */
  function energy(loadId, fromMs, toMs, tariffs) {
    const byDate = {};
    let kwh = 0;
    let cop = 0;
    const add = (date, value) => {
      const t = tariffAt(tariffs, date);
      const day = byDate[date] || (byDate[date] = { kwh: 0, cop: 0 });
      const priced = t ? value * t.copPerKwh : 0;
      day.kwh += value; day.cop += priced; kwh += value; cop += priced;
    };
    for (const h of repos.readings.hourlyRange(loadId, iso(fromMs), iso(toMs))) add(localDateKey(Date.parse(h.hour_start)), h.energy_kwh);
    const raw = recentReadings(repos, loadId, { from: iso(fromMs), to: iso(toMs) });
    for (const s of energySegments(raw)) add(localDateKey(s.startMs), s.kwh);
    return { kwh, cop, byDate };
  }

  /** Start of the local day of an instant. */
  const dayStart = (ms) => localDayStartMs(localDateKey(ms), -300);

  return {
    tariffsOf, scheduleOf, settingsOf, domainLoad, series, recent, baselineOf, invalidate, energy, dayStart, addDays,
  };
}

module.exports = { createAnalytics };
