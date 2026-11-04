'use strict';
/**
 * Reading ingestion use case (RF-01, RF-08, RNF-03, RNF-08).
 *
 * One path for every source: the real ESP32 gateway, the two simulated manufacturers and the demo
 * simulator all arrive here as raw readings in some manufacturer format and leave as rows of
 * `readings`. The use case
 *  - normalizes each raw reading with the manufacturer adapters (common Reading model);
 *  - validates strictly: types (adapters), business ranges and a time window, per reading;
 *  - resolves the module registry (module -> load) and can auto-register unknown modules in the
 *    local profile, which is how the first MVP's ESP32 keeps working without a registration step;
 *  - is idempotent: a reading is identified by (module's load, timestamp), so re-sent batches and
 *    offline-buffer syncs never duplicate data;
 *  - updates the heartbeat and status of the modules it heard from (active, inactive, error);
 *  - reports counts. For an offline-buffer sync it reports "Se sincronizaron N lecturas, 0 perdidas".
 *
 * Time always comes from the injected clock (`clock.now()`), never from the real time.
 */

const { normalizeReading, ReadingFormatError } = require('../adapters/manufacturers');
const { MODULE_COMM, MODULE_STATUS, CRITICALITY, CONTROL_MODE } = require('../domain/constants');
const { moduleCommunicationState } = require('../domain/control');
const { MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } = require('../domain/time');

/** Business ranges of one reading. */
const LIMITS = Object.freeze({
  powerW: [0, 100000],
  voltageV: [0, 1000],
  currentA: [0, 1000],
  energyKwh: [0, 1e7],
});
const SITE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_BATCH = 100;
const MAX_BUFFERED_BATCH = 1000;
const MAX_AGE_DAYS = 60;
const MAX_FUTURE_MINUTES = 5;
/** Raw 1-minute readings are kept this long; older minutes live only as hourly aggregates. */
const RAW_RETENTION_DAYS = 2;
const SOURCES = Object.freeze(['esp32', 'simulator', 'import']);

class IngestionError extends Error {
  /** @param {string} message Plain Spanish. @param {string} code Machine code. */
  constructor(message, code) {
    super(message);
    this.name = 'IngestionError';
    this.code = code;
  }
}

/**
 * Turns the JSON body of POST /api/telemetry into an ingestion envelope. Accepts the ESP32 gateway
 * format (gateway_id, site_id, readings[]) and the same envelope carrying manufacturer-format
 * readings (`format`) or an offline-buffer sync (`buffered`, `expected`).
 * @param {*} body
 */
function envelopeFromPayload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new IngestionError('El payload debe ser un objeto JSON.', 'invalid_payload');
  if (typeof body.site_id !== 'string' || !SITE_PATTERN.test(body.site_id)) throw new IngestionError('site_id es obligatorio y debe ser un texto válido.', 'invalid_payload');
  if (body.gateway_id !== undefined && (typeof body.gateway_id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(body.gateway_id))) throw new IngestionError('gateway_id no es válido.', 'invalid_payload');
  if (body.format !== undefined && typeof body.format !== 'string') throw new IngestionError('format debe ser un texto.', 'invalid_payload');
  if (body.expected !== undefined && !(Number.isInteger(body.expected) && body.expected >= 0 && body.expected <= 1e6)) throw new IngestionError('expected debe ser un entero positivo.', 'invalid_payload');
  return {
    siteId: body.site_id, gatewayId: body.gateway_id || null, format: body.format, buffered: body.buffered === true,
    expected: body.expected, readings: body.readings, source: 'esp32',
  };
}

/**
 * @param {{repos: object, clock: {now: function(): number}, options?: {autoRegister?: boolean, maxBatch?: number,
 *   maxBufferedBatch?: number, maxAgeDays?: number}}} deps
 */
function createIngestion({ repos, clock, options = {} }) {
  const autoRegister = options.autoRegister ?? false;
  const maxBatch = options.maxBatch ?? MAX_BATCH;
  const maxBufferedBatch = options.maxBufferedBatch ?? MAX_BUFFERED_BATCH;
  const maxAgeMs = (options.maxAgeDays ?? MAX_AGE_DAYS) * MS_PER_DAY;

  function rangeProblem(reading) {
    for (const [field, [min, max]] of Object.entries(LIMITS)) {
      const value = reading[field];
      if (!Number.isFinite(value) || value < min || value > max) return `${field} fuera de rango (${min} a ${max}).`;
    }
    return null;
  }

  /** Module registry lookup; returns {module, load} or {problem: {code, message}}. */
  function resolve(siteId, reading, cache) {
    const cached = cache.get(reading.moduleId);
    if (cached) return cached;
    let found;
    const module_ = repos.modules.get(reading.moduleId);
    if (module_) {
      if (module_.site_id !== siteId) found = { problem: { code: 'module_not_in_site', message: `El módulo ${reading.moduleId} pertenece a otra sede.` } };
      else if (module_.load_id === null) found = { problem: { code: 'module_without_load', message: `El módulo ${reading.moduleId} no tiene una carga asignada.` } };
      else found = { module: module_, load: repos.loads.get(module_.load_id) };
    } else if (!autoRegister) {
      found = { problem: { code: 'module_not_registered', message: `El módulo ${reading.moduleId} no está registrado.` } };
    } else if (!reading.loadCode || !ID_PATTERN.test(reading.loadCode)) {
      found = { problem: { code: 'module_not_registered', message: `El módulo ${reading.moduleId} no está registrado y la lectura no indica una carga.` } };
    } else {
      let load = repos.loads.getByCode(siteId, reading.loadCode);
      if (!load) {
        load = repos.loads.create({ siteId, code: reading.loadCode, name: reading.loadName || reading.loadCode, criticality: CRITICALITY.ESSENTIAL, controlMode: CONTROL_MODE.MONITOR_ONLY });
      }
      if (repos.modules.listBySite(siteId).some((m) => m.load_id === load.id)) {
        found = { problem: { code: 'load_has_another_module', message: `La carga ${reading.loadCode} ya tiene otro módulo asignado.` } };
      } else {
        const registered = repos.modules.register({ id: reading.moduleId, siteId, loadId: load.id, manufacturer: reading.manufacturer, registeredAt: new Date(clock.now()).toISOString() });
        found = { module: registered, load };
      }
    }
    cache.set(reading.moduleId, found);
    return found;
  }

  /**
   * Ingest one batch.
   * @param {{siteId: string, gatewayId?: string, format?: string, buffered?: boolean, expected?: number,
   *   readings: Array, source?: string}} envelope
   * @returns {{receivedAt: string, received: number, accepted: number, duplicates: number,
   *   rejected: Array<{index: number, code: string, message: string}>, moduleIds: string[],
   *   sync: (null|{received: number, stored: number, duplicates: number, lost: number, message: string})}}
   * @throws {IngestionError} when the envelope itself is invalid (unknown site, empty or oversized batch).
   */
  function ingest(envelope) {
    const source = envelope.source || 'esp32';
    if (!SOURCES.includes(source)) throw new IngestionError('Origen de datos no válido.', 'invalid_payload');
    if (!Array.isArray(envelope.readings) || envelope.readings.length === 0) throw new IngestionError('El payload debe contener readings[] con al menos una lectura.', 'empty_batch');
    const limit = envelope.buffered ? maxBufferedBatch : maxBatch;
    if (envelope.readings.length > limit) throw new IngestionError(`Máximo ${limit} lecturas por lote.`, 'batch_too_large');
    if (!repos.sites.get(envelope.siteId)) throw new IngestionError('Sede no autorizada.', 'unknown_site');

    const nowMs = clock.now();
    const receivedAt = new Date(nowMs).toISOString();
    const cache = new Map();
    const rejected = [];
    const rows = [];
    const lastByModule = new Map();

    envelope.readings.forEach((raw, index) => {
      const reject = (code, message) => rejected.push({ index, code, message });
      let reading;
      try {
        reading = normalizeReading(raw, envelope.format);
      } catch (error) {
        if (error instanceof ReadingFormatError) return reject('invalid_format', error.message);
        throw error;
      }
      const problem = rangeProblem(reading);
      if (problem) return reject('out_of_range', problem);
      const tsMs = reading.ts === null ? nowMs : Date.parse(reading.ts);
      if (tsMs > nowMs + MAX_FUTURE_MINUTES * MS_PER_MINUTE) return reject('timestamp_in_future', 'La marca de tiempo está en el futuro.');
      if (tsMs < nowMs - maxAgeMs) return reject('timestamp_too_old', 'La marca de tiempo es demasiado antigua.');
      const resolved = resolve(envelope.siteId, reading, cache);
      if (resolved.problem) return reject(resolved.problem.code, resolved.problem.message);
      const ts = new Date(tsMs).toISOString();
      rows.push({
        loadId: resolved.load.id, moduleId: reading.moduleId, ts, powerW: reading.powerW, voltageV: reading.voltageV,
        currentA: reading.currentA, energyKwh: reading.energyKwh, source,
      });
      const last = lastByModule.get(reading.moduleId);
      if (!last || tsMs >= last.tsMs) lastByModule.set(reading.moduleId, { tsMs, status: reading.status });
      return undefined;
    });

    const inserted = rows.length ? repos.readings.insertMany(rows) : 0;
    const duplicates = rows.length - inserted;
    for (const [moduleId, last] of lastByModule) {
      repos.modules.heartbeat(moduleId, receivedAt);
      repos.modules.setStatus(moduleId, last.status === 'error' ? MODULE_STATUS.ERROR : last.status === 'inactive' ? MODULE_STATUS.INACTIVE : MODULE_STATUS.ACTIVE);
    }

    let sync = null;
    if (envelope.buffered) {
      const expected = envelope.expected ?? envelope.readings.length;
      const lost = Math.max(0, expected - inserted - duplicates);
      const extra = duplicates ? ` (${duplicates} ya estaban registradas)` : '';
      sync = {
        received: envelope.readings.length, stored: inserted, duplicates, lost,
        message: `Se sincronizaron ${inserted} lecturas, ${lost} perdidas${extra}`,
      };
      repos.events.track({ at: receivedAt, name: 'buffer_synced', siteId: envelope.siteId, properties: { moduleIds: [...lastByModule.keys()], stored: inserted, duplicates, lost } });
    }
    return { receivedAt, received: envelope.readings.length, accepted: inserted, duplicates, rejected, moduleIds: [...lastByModule.keys()], sync };
  }

  /**
   * Marks as inactive the active modules that stopped reporting for more than the inactivity limit
   * (2 minutes, domain rule). A module that reports again becomes active in `ingest`.
   * @returns {Array<{moduleId: string, siteId: string, silentMinutes: (number|null)}>} Modules that changed.
   */
  function refreshModuleStatuses() {
    const changed = [];
    for (const module_ of repos.modules.list()) {
      if (module_.status !== MODULE_STATUS.ACTIVE || module_.last_heartbeat === null) continue;
      const comm = moduleCommunicationState({ lastSeenAt: module_.last_heartbeat, now: clock.now() });
      if (comm.state === MODULE_COMM.HEALTHY) continue;
      repos.modules.setStatus(module_.id, MODULE_STATUS.INACTIVE);
      changed.push({ moduleId: module_.id, siteId: module_.site_id, silentMinutes: comm.silentMinutes });
    }
    return changed;
  }

  /**
   * Retention: folds raw readings older than `rawDays` into hourly aggregates and removes them.
   * Limitation: a reading that arrives later for an hour that was already compacted would replace that
   * hour's aggregate with one built from the late rows only; offline buffers are minutes to hours long,
   * far below the 2-day raw window, so this does not happen in normal operation.
   * @returns {{hoursWritten: number, rawRemoved: number}}
   */
  function compact({ rawDays = RAW_RETENTION_DAYS } = {}) {
    const cutoffMs = Math.floor((clock.now() - rawDays * MS_PER_DAY) / MS_PER_HOUR) * MS_PER_HOUR;
    const cutoff = new Date(cutoffMs).toISOString();
    let hoursWritten = 0;
    for (const site of repos.sites.list()) {
      for (const load of repos.loads.listBySite(site.id)) hoursWritten += repos.readings.aggregateHourly(load.id, '0000', cutoff);
    }
    return { hoursWritten, rawRemoved: repos.readings.pruneRawBefore(cutoff) };
  }

  return { ingest, refreshModuleStatuses, compact };
}

module.exports = { createIngestion, envelopeFromPayload, IngestionError, LIMITS, MAX_BATCH, MAX_BUFFERED_BATCH, RAW_RETENTION_DAYS };
