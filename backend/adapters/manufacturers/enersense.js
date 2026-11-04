'use strict';
/**
 * Simulated manufacturer A: "EnerSense". Compact flat payload, epoch seconds, short keys.
 *
 *   {"dev":"MX-001","t":1773261000,"v":120.4,"i":2.9,"p":350.1,"e":12.345,"st":"OK","load":"freezer"}
 *
 * dev = module id, t = epoch seconds (UTC), v = volts, i = amps, p = watts, e = cumulative kWh,
 * st = OK | IDLE | FAULT, load = optional load code.
 */

const { ReadingFormatError, finiteNumber, text, instant, statusFrom, isObject } = require('./reading');

const MANUFACTURER = 'EnerSense';
const STATUS = { ok: 'active', idle: 'active', fault: 'error' };

function detect(raw) {
  return isObject(raw) && typeof raw.dev === 'string' && 'p' in raw;
}

/** @returns {import('./reading').Reading} */
function normalize(raw) {
  if (!isObject(raw)) throw new ReadingFormatError('La lectura debe ser un objeto.');
  const voltageV = finiteNumber(raw.v, 'v', { optional: true });
  const powerW = finiteNumber(raw.p, 'p');
  return {
    moduleId: text(raw.dev, 'dev', { max: 64 }),
    loadCode: text(raw.load, 'load', { optional: true, max: 64 }),
    loadName: null,
    manufacturer: MANUFACTURER,
    ts: instant(raw.t, 't', { epochSeconds: true }),
    powerW,
    voltageV: voltageV ?? 120,
    currentA: finiteNumber(raw.i, 'i', { optional: true, fallback: powerW / (voltageV ?? 120) }),
    energyKwh: finiteNumber(raw.e, 'e', { optional: true, fallback: 0 }),
    status: statusFrom(raw.st ?? 'OK', STATUS, 'st'),
  };
}

/** Device-side encoder (used by the simulated module fleet and the tests). */
function encode(reading) {
  const wire = {
    dev: reading.moduleId, t: Math.floor(Date.parse(reading.ts) / 1000), v: reading.voltageV, i: reading.currentA,
    p: reading.powerW, e: reading.energyKwh, st: reading.status === 'error' ? 'FAULT' : 'OK',
  };
  if (reading.loadCode) wire.load = reading.loadCode;
  return wire;
}

module.exports = { id: 'enersense', manufacturer: MANUFACTURER, detect, normalize, encode };
