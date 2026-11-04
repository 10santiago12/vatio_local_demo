'use strict';
/**
 * Simulated manufacturer B: "VoltioLab". Nested payload, ISO timestamps, milliamps and watt-hours.
 *
 *   {"meter":{"id":"MX-002","state":"ONLINE"},"sampled_at":"2026-03-11T20:30:00Z","channel":"fridge",
 *    "metrics":{"volts":120.2,"milliamps":3300,"watts":395,"wh_total":12345}}
 *
 * state = ONLINE | OFFLINE | ERROR, wh_total = cumulative watt-hours, channel = optional load code.
 * The adapter converts milliamps to amps and watt-hours to kWh.
 */

const { ReadingFormatError, finiteNumber, text, instant, statusFrom, isObject } = require('./reading');

const MANUFACTURER = 'VoltioLab';
const STATE = { online: 'active', offline: 'inactive', error: 'error' };

function detect(raw) {
  return isObject(raw) && isObject(raw.meter) && isObject(raw.metrics);
}

/** @returns {import('./reading').Reading} */
function normalize(raw) {
  if (!isObject(raw)) throw new ReadingFormatError('La lectura debe ser un objeto.');
  if (!isObject(raw.meter)) throw new ReadingFormatError('Falta el campo meter.', 'meter');
  if (!isObject(raw.metrics)) throw new ReadingFormatError('Falta el campo metrics.', 'metrics');
  const m = raw.metrics;
  const voltageV = finiteNumber(m.volts, 'metrics.volts', { optional: true });
  const powerW = finiteNumber(m.watts, 'metrics.watts');
  const milliamps = finiteNumber(m.milliamps, 'metrics.milliamps', { optional: true });
  const wh = finiteNumber(m.wh_total, 'metrics.wh_total', { optional: true });
  return {
    moduleId: text(raw.meter.id, 'meter.id', { max: 64 }),
    loadCode: text(raw.channel, 'channel', { optional: true, max: 64 }),
    loadName: null,
    manufacturer: MANUFACTURER,
    ts: instant(raw.sampled_at, 'sampled_at'),
    powerW,
    voltageV: voltageV ?? 120,
    currentA: milliamps === undefined ? powerW / (voltageV ?? 120) : milliamps / 1000,
    energyKwh: wh === undefined ? 0 : wh / 1000,
    status: statusFrom(raw.meter.state ?? 'ONLINE', STATE, 'meter.state'),
  };
}

/** Device-side encoder (used by the simulated module fleet and the tests). */
function encode(reading) {
  const wire = {
    meter: { id: reading.moduleId, state: reading.status === 'error' ? 'ERROR' : 'ONLINE' },
    sampled_at: reading.ts,
    metrics: {
      volts: reading.voltageV, milliamps: Math.round(reading.currentA * 1000), watts: reading.powerW,
      wh_total: Math.round(reading.energyKwh * 1000 * 1000) / 1000,
    },
  };
  if (reading.loadCode) wire.channel = reading.loadCode;
  return wire;
}

module.exports = { id: 'voltiolab', manufacturer: MANUFACTURER, detect, normalize, encode };
