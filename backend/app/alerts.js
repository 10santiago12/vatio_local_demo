'use strict';
/**
 * Alert use cases (RF-04, RF-08, RF-15): run the domain detectors against the stored readings, persist
 * the alerts that fire without duplicates (one active alert per load and type), list them and mark them
 * as reviewed.
 *
 * `run` is usable on demand and by a periodic job. Loads whose baseline is still `building` get no
 * deviation alerts (consumption, off-hours, maintenance): without a baseline the system does not
 * guess. Module inactivity does not depend on a baseline and is always checked.
 */
const {
  evaluateConsumptionAlert, evaluateOffHoursAlert, evaluateMaintenanceAlert, evaluateInactiveModuleAlert,
} = require('../domain/alerts');
const { MS_PER_HOUR, MS_PER_DAY } = require('../domain/time');
const { badRequest, conflict, notFound } = require('../http/http-error');
const { findLoad } = require('./module-state');

const ALERT_TYPES = ['consumption', 'off_hours', 'maintenance', 'inactive_module'];
/** Predictive maintenance looks at weeks of history: it is re-evaluated at most once per hour per load. */
const MAINTENANCE_CHECK_MS = MS_PER_HOUR;

function present(row, loadsById, users) {
  const load = loadsById.get(row.load_id);
  return {
    id: row.id, type: row.type, status: row.status, loadId: row.load_id, loadCode: load ? load.code : null, loadName: load ? load.name : null,
    message: row.message, detectedAt: row.detected_at, excessPct: row.excess_pct, excessCostPerHourCop: row.excess_cost_per_hour_cop,
    projectedMonthlyCostCop: row.projected_monthly_cost_cop, details: row.details ? JSON.parse(row.details) : null,
    reviewedAt: row.reviewed_at, reviewedBy: row.reviewed_by ? (users.get(row.reviewed_by) ?? null) : null,
  };
}

/** @param {{repos: object, clock: {now: function(): number}, analytics: object, access: object}} deps */
function createAlerts({ repos, clock, analytics, access, track = () => {} }) {
  const maintenanceChecked = new Map();

  function persist(siteId, alert) {
    if (alert.loadId === null || repos.alerts.findActive(alert.loadId, alert.type)) return null;
    const created = repos.alerts.create({
      siteId, loadId: alert.loadId, type: alert.type, detectedAt: alert.detectedAt, excessPct: alert.excessPct, excessCostPerHourCop: alert.excessCostPerHourCop,
      projectedMonthlyCostCop: alert.projectedMonthlyCostCop, message: alert.message, details: alert.details,
    });
    track('alert_created', { properties: { type: alert.type, loadId: alert.loadId } });
    return created;
  }

  return {
    /**
     * Evaluates every rule for every load of a site and stores the new alerts.
     * @returns {{checked: number, created: Array<object>}}
     */
    run(siteId) {
      const nowMs = clock.now();
      const settings = analytics.settingsOf(siteId);
      const tariffs = analytics.tariffsOf(siteId);
      const schedule = analytics.scheduleOf(siteId);
      const thresholdPct = settings.alert_threshold_pct;
      const windowMinutes = settings.alert_window_minutes;
      const loads = repos.loads.listBySite(siteId);
      const created = [];
      const keep = (alert) => { const row = alert && persist(siteId, alert); if (row) created.push(row); };

      for (const load of loads) {
        const baseline = analytics.baselineOf(load, nowMs);
        if (baseline.status !== 'ready') continue;
        const readings = analytics.recent(load.id, windowMinutes + 2, nowMs);
        const lite = { id: load.id, name: load.name, criticality: load.criticality };
        const consumption = evaluateConsumptionAlert({ load: lite, baseline, readings, tariffs, now: nowMs, thresholdPct, windowMinutes });
        if (consumption.fired) keep(consumption.alert);
        const offHours = evaluateOffHoursAlert({ load: lite, readings, schedule, tariffs, now: nowMs, windowMinutes });
        if (offHours.fired) keep(offHours.alert);
        const last = maintenanceChecked.get(load.id);
        if (last === undefined || nowMs - last >= MAINTENANCE_CHECK_MS || nowMs < last) {
          maintenanceChecked.set(load.id, nowMs);
          const maintenance = evaluateMaintenanceAlert({ load: lite, readings: analytics.series(load.id, nowMs - 46 * MS_PER_DAY, nowMs), tariffs, now: nowMs });
          if (maintenance.fired) keep(maintenance.alert);
        }
      }
      const loadsById = new Map(loads.map((l) => [l.id, l]));
      for (const module_ of repos.modules.listBySite(siteId)) {
        if (module_.load_id === null) continue;
        const result = evaluateInactiveModuleAlert({
          module: { id: module_.id, loadId: module_.load_id, loadName: loadsById.get(module_.load_id)?.name, lastSeenAt: module_.last_heartbeat }, now: nowMs,
        });
        if (result.fired) keep(result.alert);
      }
      return { checked: loads.length, created };
    },

    list(siteId, { view, type, load, limit = 200 } = {}) {
      let status;
      if (view !== undefined && view !== 'all') {
        if (!['active', 'history'].includes(view)) throw badRequest('La vista debe ser active, history o all.', 'invalid_filter');
        status = view === 'active' ? 'active' : 'reviewed';
      }
      if (type !== undefined && !ALERT_TYPES.includes(type)) throw badRequest('El tipo de alerta no es válido.', 'invalid_filter');
      let loadId;
      if (load) {
        const row = findLoad(repos, siteId, load);
        if (!row) throw notFound('No existe ese equipo.', 'load_not_found');
        loadId = row.id;
      }
      const loadsById = new Map(repos.loads.listBySite(siteId).map((l) => [l.id, l]));
      const users = new Map(repos.users.list().map((u) => [u.id, u.username]));
      return repos.alerts.list({ siteId, status, type, loadId, limit }).map((r) => present(r, loadsById, users));
    },

    /** "Marcar como revisada": the alert leaves the active list and stays in the history. */
    review(siteId, id, user) {
      const row = repos.alerts.get(Number(id));
      if (!row || row.site_id !== siteId) throw notFound('No existe esa alerta.', 'alert_not_found');
      const at = new Date(clock.now()).toISOString();
      if (!repos.alerts.review(row.id, user.userId, at)) throw conflict('Esta alerta ya fue revisada.', 'already_reviewed');
      access.audit({ user, event: 'alert_reviewed', siteId, loadId: row.load_id, result: 'executed', details: { alertId: row.id, type: row.type } });
      const loadsById = new Map(repos.loads.listBySite(siteId).map((l) => [l.id, l]));
      return present(repos.alerts.get(row.id), loadsById, new Map([[user.userId, user.username]]));
    },
  };
}

module.exports = { createAlerts, ALERT_TYPES };
