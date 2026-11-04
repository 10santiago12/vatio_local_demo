'use strict';
/**
 * Measurement module registry (RF-08): list with status and heartbeat, register a new module (technician)
 * and plain-language diagnostics. A newly registered module appears active and sends its first reading
 * within its first reporting minute.
 */
const { newLoadDefaults } = require('../domain/control');
const { MS_PER_HOUR } = require('../domain/time');
const { round } = require('../domain/stats');
const { badRequest, conflict, notFound } = require('../http/http-error');
const { communicationOf, statusOf, STATUS_TEXT } = require('./module-state');

const MODULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOAD_CODE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const EXPECTED_READINGS_PER_DAY = 1440;

const slug = (text) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/**
 * @param {{repos: object, clock: {now: function(): number}, access: object, onRegistered?: function(object): void}} deps
 */
function createModules({ repos, clock, access, onRegistered = () => {} }) {
  function present(m, nowMs) {
    const comm = communicationOf(m, nowMs);
    const status = statusOf(m, comm);
    const load = m.load_id ? repos.loads.get(m.load_id) : null;
    const last = load ? repos.readings.latest(load.id) : null;
    return {
      id: m.id, manufacturer: m.manufacturer, status, statusText: STATUS_TEXT[status], loadCode: load ? load.code : null, loadName: load ? load.name : null,
      lastHeartbeat: m.last_heartbeat, silentMinutes: comm.silentMinutes === null ? null : round(comm.silentMinutes, 1), registeredAt: m.registered_at,
      lastReading: last ? { at: last.ts, powerW: last.power_w } : null,
    };
  }

  return {
    list(siteId) {
      const nowMs = clock.now();
      return repos.modules.listBySite(siteId).map((m) => present(m, nowMs));
    },

    /** @param {{id: string, manufacturer: string, loadCode?: string, loadName?: string}} input */
    register(siteId, input, user) {
      if (typeof input.id !== 'string' || !MODULE_ID.test(input.id)) throw badRequest('El identificador del módulo debe tener letras, números, punto, guion o guion bajo (hasta 64 caracteres).', 'invalid_module_id');
      if (typeof input.manufacturer !== 'string' || !input.manufacturer.trim() || input.manufacturer.length > 60) throw badRequest('Indique el fabricante del módulo (hasta 60 caracteres).', 'invalid_manufacturer');
      if (repos.modules.get(input.id)) throw conflict('Ya existe un módulo con ese identificador.', 'module_exists');
      let load;
      if (typeof input.loadCode === 'string' && input.loadCode) {
        load = repos.loads.getByCode(siteId, input.loadCode);
        if (!load) {
          if (typeof input.loadName !== 'string' || !input.loadName.trim()) throw badRequest('Ese equipo no existe: indique también su nombre para crearlo.', 'load_name_required');
          if (!LOAD_CODE.test(input.loadCode)) throw badRequest('El código del equipo debe tener letras minúsculas, números y guiones.', 'invalid_load_code');
        }
      } else if (typeof input.loadName === 'string' && input.loadName.trim()) {
        const code = slug(input.loadName);
        if (!code) throw badRequest('El nombre del equipo no es válido.', 'invalid_load_name');
        load = repos.loads.getByCode(siteId, code);
        input = { ...input, loadCode: code };
      } else {
        throw badRequest('Indique el equipo (loadCode) o su nombre (loadName).', 'load_required');
      }
      const at = new Date(clock.now()).toISOString();
      let created = false;
      if (!load) {
        const defaults = newLoadDefaults();
        load = repos.loads.create({ siteId, code: input.loadCode, name: input.loadName.trim().slice(0, 80), criticality: defaults.criticality, controlMode: defaults.controlMode });
        created = true;
      }
      if (repos.modules.listBySite(siteId).some((m) => m.load_id === load.id)) throw conflict('Ese equipo ya tiene un módulo asignado.', 'load_has_module');
      repos.modules.register({ id: input.id, siteId, loadId: load.id, manufacturer: input.manufacturer.trim(), status: 'active', registeredBy: user.userId, registeredAt: at });
      repos.modules.heartbeat(input.id, at);
      access.audit({ user, event: 'module_registered', siteId, loadId: load.id, result: 'executed', details: { moduleId: input.id, manufacturer: input.manufacturer.trim(), loadCode: load.code, loadCreated: created } });
      const module_ = repos.modules.get(input.id);
      onRegistered({ module: module_, load });
      return { ...present(module_, clock.now()), loadCreated: created, firstReadingExpectedWithinMinutes: 2 };
    },

    diagnostics(siteId, moduleId) {
      const m = repos.modules.get(moduleId);
      if (!m || m.site_id !== siteId) throw notFound('No existe ese módulo.', 'module_not_found');
      const nowMs = clock.now();
      const base = present(m, nowMs);
      const comm = communicationOf(m, nowMs);
      const load = m.load_id ? repos.loads.get(m.load_id) : null;
      const last = load ? repos.readings.latest(load.id) : null;
      const count = load ? repos.readings.range(load.id, new Date(nowMs - 24 * MS_PER_HOUR).toISOString(), new Date(nowMs + 1).toISOString()).length : 0;
      const completeness = round(Math.min(100, (count / EXPECTED_READINGS_PER_DAY) * 100), 1);
      const checks = [
        { name: 'Comunicación', ok: comm.state === 'healthy', text: comm.state === 'healthy' ? 'El módulo reporta con normalidad.' : comm.silentMinutes === null ? 'El módulo todavía no ha reportado.' : `El módulo lleva ${Math.round(comm.silentMinutes)} minutos sin reportar. Revise la alimentación y la red Wi-Fi.` },
        { name: 'Lecturas de las últimas 24 horas', ok: completeness >= 90, text: `Se recibieron ${count} de unas ${EXPECTED_READINGS_PER_DAY} lecturas esperadas (${completeness} %).` },
        { name: 'Estado reportado', ok: m.status !== 'error', text: m.status === 'error' ? 'El módulo informa una falla interna. Reinícielo; si persiste, cámbielo.' : 'El módulo no informa fallas.' },
      ];
      return {
        ...base, checks, healthy: checks.every((c) => c.ok), readingsLast24h: count, completenessPct: completeness,
        lastReadingValues: last ? { at: last.ts, voltageV: last.voltage_v, currentA: last.current_a, powerW: last.power_w, energyKwhCounter: last.energy_kwh } : null,
      };
    },
  };
}

module.exports = { createModules };
