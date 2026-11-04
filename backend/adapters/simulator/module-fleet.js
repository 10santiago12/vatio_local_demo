'use strict';
/**
 * Simulated measurement modules (the "hardware" side of the simulator).
 *
 * Each module measures its load every minute with the engine, keeps a cumulative kWh counter and
 * speaks its manufacturer's wire format. `tick()` returns the batches that reached the server since
 * the last call. A disconnected module keeps measuring and stores the readings locally (offline
 * buffer, RNF-08); `reconnect()` drains that buffer as sync batches flagged `buffered` with the
 * number of readings the module expects the server to confirm.
 *
 * The fleet never talks to the database: the caller hands the batches to the ingestion use case.
 */

const { MS_PER_MINUTE } = require('../../domain/time');
const { adapterFor } = require('../manufacturers');

/** Device batch sizes: live batches mirror the ESP32 limit, sync batches the buffered limit. */
const LIVE_BATCH = 100;
const SYNC_BATCH = 1000;
/** Local storage of a module: about one week of 1-minute readings. */
const DEFAULT_BUFFER_CAPACITY = 7 * 24 * 60;

const FORMAT_BY_MANUFACTURER = Object.freeze({ EnerSense: 'enersense', VoltioLab: 'voltiolab' });

/**
 * @param {{engine: object, clock: {now: function(): number}, siteId: string,
 *   modules: Array<{moduleId: string, loadCode: string, manufacturer: string, format?: string}>,
 *   initialEnergyKwh?: Object<string, number>, bufferCapacity?: number}} input
 */
function createModuleFleet(input) {
  const { engine, clock, siteId } = input;
  const capacity = input.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
  const startMinute = Math.floor(clock.now() / MS_PER_MINUTE) * MS_PER_MINUTE;
  const state = new Map();
  for (const m of input.modules) {
    state.set(m.moduleId, {
      ...m,
      format: m.format || FORMAT_BY_MANUFACTURER[m.manufacturer] || 'esp32',
      connected: true,
      lastMinute: startMinute - MS_PER_MINUTE,
      energyKwh: input.initialEnergyKwh?.[m.loadCode] ?? 0,
      buffer: [],
      overflowed: 0,
    });
  }

  const module_ = (moduleId) => {
    const m = state.get(moduleId);
    if (!m) throw new RangeError(`Unknown simulated module: ${moduleId}`);
    return m;
  };

  function measure(m, ts) {
    const s = engine.sample(m.loadCode, ts);
    m.energyKwh += s.powerW / 60 / 1000;
    return {
      moduleId: m.moduleId, loadCode: m.loadCode, loadName: null, manufacturer: m.manufacturer, ts: new Date(ts).toISOString(),
      powerW: s.powerW, voltageV: s.voltageV, currentA: s.currentA, energyKwh: Math.round(m.energyKwh * 1e6) / 1e6, status: 'active',
    };
  }

  const encode = (m, readings) => readings.map((r) => adapterFor(m.format).encode(r));
  const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

  return {
    siteId,
    moduleIds: () => [...state.keys()],
    isConnected: (moduleId) => module_(moduleId).connected,
    bufferedCount: (moduleId) => module_(moduleId).buffer.length,
    /** Readings the module had to drop because its local storage was full. */
    overflowed: (moduleId) => module_(moduleId).overflowed,

    /**
     * Measures every minute that elapsed since the last tick.
     * @returns {Array<{siteId: string, format: string, source: 'simulator', buffered: false, readings: Array}>} Live batches received by the server.
     */
    tick() {
      const nowMinute = Math.floor(clock.now() / MS_PER_MINUTE) * MS_PER_MINUTE;
      const batches = [];
      for (const m of state.values()) {
        const live = [];
        for (let ts = m.lastMinute + MS_PER_MINUTE; ts <= nowMinute; ts += MS_PER_MINUTE) {
          const reading = measure(m, ts);
          if (m.connected) live.push(reading);
          else {
            m.buffer.push(reading);
            if (m.buffer.length > capacity) { m.buffer.shift(); m.overflowed += 1; }
          }
        }
        m.lastMinute = Math.max(m.lastMinute, nowMinute);
        for (const part of chunks(live, LIVE_BATCH)) batches.push({ siteId, format: m.format, source: 'simulator', buffered: false, readings: encode(m, part) });
      }
      return batches;
    },

    /** The module loses its connection: it keeps measuring and stores readings locally. */
    disconnect(moduleId) { module_(moduleId).connected = false; },

    /**
     * The module is back: measures the minutes up to now and hands over its buffer.
     * @returns {{readingsBuffered: number, dropped: number, batches: Array<{siteId: string, format: string, source: 'simulator', buffered: true, expected: number, readings: Array}>}}
     */
    reconnect(moduleId) {
      const m = module_(moduleId);
      const nowMinute = Math.floor(clock.now() / MS_PER_MINUTE) * MS_PER_MINUTE;
      for (let ts = m.lastMinute + MS_PER_MINUTE; ts <= nowMinute; ts += MS_PER_MINUTE) m.buffer.push(measure(m, ts));
      m.lastMinute = Math.max(m.lastMinute, nowMinute);
      m.connected = true;
      const pending = m.buffer.splice(0, m.buffer.length);
      // Readings dropped because local storage was full are known to the module: they count as expected, so the sync reports them as lost.
      const dropped = m.overflowed;
      m.overflowed = 0;
      const batches = chunks(pending, SYNC_BATCH).map((part, i) => ({
        siteId, format: m.format, source: 'simulator', buffered: true, expected: part.length + (i === 0 ? dropped : 0), readings: encode(m, part),
      }));
      return { readingsBuffered: pending.length, dropped, batches };
    },
  };
}

module.exports = { createModuleFleet, FORMAT_BY_MANUFACTURER, DEFAULT_BUFFER_CAPACITY };
