'use strict';
/**
 * Site configuration use cases: settings (investment, emission factor and its source, alert threshold
 * and window, operating hours, sector benchmark), tariff history and per-load configuration.
 * Inputs are validated here; the responses are plain objects with camelCase names.
 */
const { validateLoadConfig } = require('../domain/control');
const { CRITICALITY_LABEL } = require('../domain/constants');
const { parseHm, localDateKey } = require('../domain/time');
const { badRequest, conflict, notFound, unprocessable } = require('../http/http-error');

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function presentSettings(row, schedule) {
  return {
    siteId: row.site_id,
    investmentCop: row.investment_cop,
    emissionFactorKgPerKwh: row.emission_factor_kg_per_kwh,
    emissionFactorSource: row.emission_factor_source,
    alertThresholdPct: row.alert_threshold_pct,
    alertWindowMinutes: row.alert_window_minutes,
    sectorReferenceKwhPerDay: row.sector_reference_kwh_per_day,
    operatingHours: schedule.map((e) => ({ weekday: e.weekday, closed: Boolean(e.closed), opensAt: e.opens_at, closesAt: e.closes_at })),
    updatedAt: row.updated_at,
  };
}

function presentLoad(row) {
  return {
    id: row.id, code: row.code, name: row.name, criticality: row.criticality, criticalityLabel: CRITICALITY_LABEL[row.criticality],
    controlMode: row.control_mode, powerState: row.power_state, typicalPowerW: row.typical_power_w,
  };
}

/**
 * @param {{repos: object, access: object, clock: {now: function(): number}, onChange?: function(): void}} deps
 *   `onChange` runs after a change that affects calculated values (cached baselines, tariffs).
 */
function createSettingsService({ repos, access, clock, onChange = () => {} }) {
  function requireSite(siteId) {
    if (!repos.sites.get(siteId)) throw notFound('No existe esa sede.', 'site_not_found');
  }

  function validateSchedule(list) {
    if (!Array.isArray(list) || list.length > 7) throw badRequest('El horario debe ser una lista de hasta 7 días.', 'invalid_schedule');
    const seen = new Set();
    return list.map((e) => {
      if (!e || !Number.isInteger(e.weekday) || e.weekday < 0 || e.weekday > 6 || seen.has(e.weekday)) throw badRequest('Cada día del horario debe indicarse una sola vez (0 domingo a 6 sábado).', 'invalid_schedule');
      seen.add(e.weekday);
      if (e.closed === true) return { weekday: e.weekday, closed: true };
      try {
        if (parseHm(e.opensAt) >= parseHm(e.closesAt)) throw new Error('order');
      } catch {
        throw badRequest('Cada día abierto necesita hora de apertura y de cierre en formato HH:MM, con la apertura antes del cierre.', 'invalid_schedule');
      }
      return { weekday: e.weekday, closed: false, opensAt: e.opensAt, closesAt: e.closesAt };
    });
  }

  function validatePatch(input) {
    const patch = {};
    const bad = (message) => { throw badRequest(message, 'invalid_setting'); };
    if (input.investmentCop !== undefined) {
      if (!isNumber(input.investmentCop) || input.investmentCop < 0 || input.investmentCop > 1e12) bad('La inversión debe ser un valor en pesos mayor o igual a 0.');
      patch.investment_cop = input.investmentCop;
    }
    if (input.emissionFactorKgPerKwh !== undefined) {
      if (!isNumber(input.emissionFactorKgPerKwh) || input.emissionFactorKgPerKwh < 0 || input.emissionFactorKgPerKwh > 10) bad('El factor de emisión debe estar entre 0 y 10 kgCO2e por kWh.');
      patch.emission_factor_kg_per_kwh = input.emissionFactorKgPerKwh;
    }
    if (input.emissionFactorSource !== undefined) {
      if (typeof input.emissionFactorSource !== 'string' || !input.emissionFactorSource.trim() || input.emissionFactorSource.length > 300) bad('Indique la fuente del factor de emisión (hasta 300 caracteres).');
      patch.emission_factor_source = input.emissionFactorSource.trim();
    }
    if (input.alertThresholdPct !== undefined) {
      if (!isNumber(input.alertThresholdPct) || input.alertThresholdPct < 1 || input.alertThresholdPct > 500) bad('El umbral de alerta debe estar entre 1 % y 500 %.');
      patch.alert_threshold_pct = input.alertThresholdPct;
    }
    if (input.alertWindowMinutes !== undefined) {
      if (!Number.isInteger(input.alertWindowMinutes) || input.alertWindowMinutes < 1 || input.alertWindowMinutes > 120) bad('La ventana de alerta debe ser de 1 a 120 minutos.');
      patch.alert_window_minutes = input.alertWindowMinutes;
    }
    if (input.sectorReferenceKwhPerDay !== undefined && input.sectorReferenceKwhPerDay !== null) {
      if (!isNumber(input.sectorReferenceKwhPerDay) || input.sectorReferenceKwhPerDay <= 0 || input.sectorReferenceKwhPerDay > 1e6) bad('La referencia del sector debe ser un valor positivo en kWh por día de operación.');
      patch.sector_reference_kwh_per_day = input.sectorReferenceKwhPerDay;
    }
    return patch;
  }

  return {
    getSettings(siteId) {
      requireSite(siteId);
      return presentSettings(repos.settings.get(siteId), repos.sites.getSchedule(siteId));
    },

    updateSettings(siteId, input, user) {
      requireSite(siteId);
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Solicitud inválida.');
      const patch = validatePatch(input);
      const schedule = input.operatingHours === undefined ? null : validateSchedule(input.operatingHours);
      if (!Object.keys(patch).length && !schedule) throw badRequest('No hay cambios que guardar.', 'empty_update');
      const before = presentSettings(repos.settings.get(siteId), repos.sites.getSchedule(siteId));
      const at = new Date(clock.now()).toISOString();
      if (Object.keys(patch).length) repos.settings.update(siteId, patch, { updatedBy: user.userId, at });
      if (schedule) for (const e of schedule) repos.sites.setSchedule(siteId, e.weekday, { closed: e.closed, opensAt: e.opensAt, closesAt: e.closesAt });
      const after = presentSettings(repos.settings.get(siteId), repos.sites.getSchedule(siteId));
      access.audit({ user, event: 'settings_updated', siteId, result: 'executed', details: { before, after } });
      onChange();
      return after;
    },

    listTariffs(siteId) {
      requireSite(siteId);
      const todayKey = localDateKey(clock.now());
      const rows = repos.tariffs.list(siteId);
      const current = rows.filter((t) => t.effective_from <= todayKey).pop();
      return rows.map((t) => ({ id: t.id, copPerKwh: t.cop_per_kwh, effectiveFrom: t.effective_from, note: t.note, createdAt: t.created_at, inForce: Boolean(current) && current.id === t.id }));
    },

    createTariff(siteId, input, user) {
      requireSite(siteId);
      if (!isNumber(input.copPerKwh) || input.copPerKwh <= 0 || input.copPerKwh > 100000) throw badRequest('La tarifa debe ser un valor positivo en pesos por kWh.', 'invalid_tariff');
      if (typeof input.effectiveFrom !== 'string' || !DATE_KEY.test(input.effectiveFrom) || Number.isNaN(Date.parse(input.effectiveFrom))) throw badRequest('La fecha de inicio debe tener el formato AAAA-MM-DD.', 'invalid_tariff');
      const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 200) : null;
      if (repos.tariffs.list(siteId).some((t) => t.effective_from === input.effectiveFrom)) throw conflict('Ya hay una tarifa que empieza ese día.', 'tariff_exists');
      const id = repos.tariffs.create({ siteId, copPerKwh: input.copPerKwh, effectiveFrom: input.effectiveFrom, createdBy: user.userId, note });
      access.audit({ user, event: 'tariff_created', siteId, result: 'executed', details: { id, copPerKwh: input.copPerKwh, effectiveFrom: input.effectiveFrom } });
      onChange();
      return { id, copPerKwh: input.copPerKwh, effectiveFrom: input.effectiveFrom, note };
    },

    listLoadConfigs(siteId) {
      requireSite(siteId);
      return repos.loads.listBySite(siteId).map(presentLoad);
    },

    updateLoadConfig(siteId, loadKey, input, user) {
      const load = /^\d+$/.test(String(loadKey)) ? repos.loads.get(Number(loadKey)) : repos.loads.getByCode(siteId, loadKey);
      if (!load || load.site_id !== siteId) throw notFound('No existe ese equipo.', 'load_not_found');
      const next = {
        criticality: input.criticality ?? load.criticality,
        controlMode: input.controlMode ?? load.control_mode,
      };
      const verdict = validateLoadConfig(next);
      if (!verdict.valid) {
        access.audit({ user, event: 'load_config_rejected', siteId, loadId: load.id, result: 'rejected', reason: verdict.message, details: { requested: next } });
        throw unprocessable(verdict.message, verdict.reason);
      }
      let name = load.name;
      if (input.name !== undefined) {
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw badRequest('El nombre del equipo debe tener entre 1 y 80 caracteres.', 'invalid_name');
        name = input.name.trim();
      }
      const updated = repos.loads.updateConfig(load.id, { name, criticality: next.criticality, controlMode: next.controlMode });
      access.audit({ user, event: 'load_config_updated', siteId, loadId: load.id, result: 'executed', details: { from: { criticality: load.criticality, controlMode: load.control_mode, name: load.name }, to: { criticality: next.criticality, controlMode: next.controlMode, name } } });
      onChange();
      return presentLoad(updated);
    },
  };
}

module.exports = { createSettingsService };
