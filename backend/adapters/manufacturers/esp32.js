'use strict';
/**
 * The ESP32 demo gateway format (firmware esp32/vatio_esp32_demo.ino), kept unchanged:
 *
 *   {"module_id":"MX-001","load_id":"freezer","load_name":"Congelador vertical","manufacturer":"EnerSense",
 *    "voltage_v":120.1,"current_a":3.43,"power_w":412,"energy_kwh":0.123,"status":"active","timestamp":""}
 *
 * `load_id` is the load CODE. Only module_id, load_id and power_w are required (as in the first MVP);
 * a missing voltage defaults to 120 V and a missing current to P / V. An empty timestamp means "stamp
 * it on reception". The `manufacturer` the board declares is kept for the module registry.
 */

const { ReadingFormatError, finiteNumber, text, instant, statusFrom, isObject } = require('./reading');

const MANUFACTURER = 'ESP32 virtual';
const STATUS = { active: 'active', inactive: 'inactive', error: 'error' };

function detect(raw) {
  return isObject(raw) && typeof raw.module_id === 'string';
}

/** @returns {import('./reading').Reading} */
function normalize(raw) {
  if (!isObject(raw)) throw new ReadingFormatError('La lectura debe ser un objeto.');
  const voltageV = finiteNumber(raw.voltage_v, 'voltage_v', { optional: true });
  const powerW = finiteNumber(raw.power_w, 'power_w');
  return {
    moduleId: text(raw.module_id, 'module_id', { max: 64 }),
    loadCode: text(raw.load_id, 'load_id', { max: 64 }),
    loadName: text(raw.load_name, 'load_name', { optional: true }),
    manufacturer: text(raw.manufacturer, 'manufacturer', { optional: true, max: 80 }) || MANUFACTURER,
    ts: instant(raw.timestamp, 'timestamp'),
    powerW,
    voltageV: voltageV ?? 120,
    currentA: finiteNumber(raw.current_a, 'current_a', { optional: true, fallback: powerW / (voltageV ?? 120) }),
    energyKwh: finiteNumber(raw.energy_kwh, 'energy_kwh', { optional: true, fallback: 0 }),
    status: statusFrom(raw.status ?? 'active', STATUS, 'status'),
  };
}

function encode(reading) {
  return {
    module_id: reading.moduleId, load_id: reading.loadCode, load_name: reading.loadName || undefined, manufacturer: reading.manufacturer,
    voltage_v: reading.voltageV, current_a: reading.currentA, power_w: reading.powerW, energy_kwh: reading.energyKwh,
    status: reading.status, timestamp: reading.ts || '',
  };
}

module.exports = { id: 'esp32', manufacturer: MANUFACTURER, detect, normalize, encode };
