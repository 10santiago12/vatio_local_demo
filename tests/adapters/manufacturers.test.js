const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReading, detectAdapter, formatIds, ADAPTERS, ReadingFormatError } = require('../../backend/adapters/manufacturers');
const enersense = require('../../backend/adapters/manufacturers/enersense');
const voltiolab = require('../../backend/adapters/manufacturers/voltiolab');
const esp32 = require('../../backend/adapters/manufacturers/esp32');

const COMMON = {
  moduleId: 'MX-001', loadCode: 'freezer', loadName: null, manufacturer: 'X', ts: '2026-03-11T20:30:00.000Z',
  powerW: 350.1, voltageV: 120.4, currentA: 2.908, energyKwh: 12.345, status: 'active',
};

test('each manufacturer speaks a different wire format', () => {
  const a = enersense.encode(COMMON);
  const b = voltiolab.encode(COMMON);
  const c = esp32.encode({ ...COMMON, loadName: 'Congelador vertical' });
  assert.deepEqual(Object.keys(a).sort(), ['dev', 'e', 'i', 'load', 'p', 'st', 't', 'v']);
  assert.deepEqual(Object.keys(b).sort(), ['channel', 'meter', 'metrics', 'sampled_at']);
  assert.ok('module_id' in c && 'power_w' in c);
  assert.equal(typeof a.t, 'number'); // epoch seconds
  assert.equal(typeof b.sampled_at, 'string'); // ISO
  assert.equal(b.metrics.wh_total, 12345); // watt-hours
  assert.equal(b.metrics.milliamps, 2908);
});

test('both manufacturers normalize to the same common Reading model (RNF-03)', () => {
  const fromA = normalizeReading(enersense.encode(COMMON));
  const fromB = normalizeReading(voltiolab.encode(COMMON));
  const fromEsp = normalizeReading(esp32.encode(COMMON));
  const strip = ({ manufacturer, ...rest }) => rest;
  assert.deepEqual(strip(fromA), strip(fromB));
  assert.deepEqual(strip(fromA), strip(fromEsp));
  assert.deepEqual(strip(fromA), strip(COMMON));
  assert.deepEqual(Object.keys(fromA).sort(), Object.keys(fromB).sort());
  assert.equal(fromA.manufacturer, 'EnerSense');
  assert.equal(fromB.manufacturer, 'VoltioLab');
});

test('units are converted: epoch seconds to ISO, milliamps to amps, watt-hours to kWh', () => {
  const a = normalizeReading({ dev: 'MX-001', t: 1773261000, v: 120, i: 3, p: 360, e: 1.5, st: 'OK' });
  assert.equal(a.ts, '2026-03-11T20:30:00.000Z');
  const b = normalizeReading({ meter: { id: 'MX-002', state: 'ONLINE' }, sampled_at: '2026-03-11T20:30:00Z', metrics: { volts: 120, milliamps: 3333, watts: 400, wh_total: 2500 } });
  assert.equal(b.currentA, 3.333);
  assert.equal(b.energyKwh, 2.5);
  assert.equal(b.ts, '2026-03-11T20:30:00.000Z');
});

test('status vocabularies map to the schema statuses', () => {
  assert.equal(normalizeReading({ dev: 'M', t: 1773261000, p: 1, st: 'FAULT' }).status, 'error');
  assert.equal(normalizeReading({ dev: 'M', t: 1773261000, p: 1, st: 'IDLE' }).status, 'active');
  const state = (s) => normalizeReading({ meter: { id: 'M', state: s }, sampled_at: '2026-03-11T20:30:00Z', metrics: { watts: 1 } }).status;
  assert.deepEqual(['ONLINE', 'OFFLINE', 'ERROR'].map(state), ['active', 'inactive', 'error']);
});

test('the existing ESP32 payload format keeps working unchanged', () => {
  const legacy = {
    module_id: 'MX-001', load_id: 'freezer', load_name: 'Congelador vertical', manufacturer: 'EnerSense',
    voltage_v: 120.1, current_a: 3.43, power_w: 412, energy_kwh: 0.123, status: 'active', timestamp: '',
  };
  const r = normalizeReading(legacy);
  assert.equal(detectAdapter(legacy).id, 'esp32');
  assert.deepEqual({ ...r }, {
    moduleId: 'MX-001', loadCode: 'freezer', loadName: 'Congelador vertical', manufacturer: 'EnerSense', ts: null,
    powerW: 412, voltageV: 120.1, currentA: 3.43, energyKwh: 0.123, status: 'active',
  });
  // The first MVP only required module_id, load_id and power_w.
  const minimal = normalizeReading({ module_id: 'MX-001', load_id: 'freezer', power_w: 412 });
  assert.equal(minimal.voltageV, 120);
  assert.ok(Math.abs(minimal.currentA - 412 / 120) < 1e-9);
  assert.equal(minimal.status, 'active');
  assert.equal(minimal.manufacturer, 'ESP32 virtual');
});

test('format detection and explicit selection', () => {
  assert.deepEqual(formatIds().sort(), ['enersense', 'esp32', 'voltiolab']);
  assert.equal(ADAPTERS.length, 3);
  assert.equal(detectAdapter({ dev: 'M', p: 1 }).id, 'enersense');
  assert.equal(detectAdapter({ meter: {}, metrics: {} }).id, 'voltiolab');
  assert.throws(() => detectAdapter({ nothing: true }), ReadingFormatError);
  assert.throws(() => normalizeReading({ dev: 'M', t: 1, p: 1 }, 'acme'), /no está soportado/);
  // An explicit format wins over detection: this is not an ESP32 reading.
  assert.throws(() => normalizeReading({ dev: 'M', t: 1773261000, p: 1 }, 'esp32'), ReadingFormatError);
});

test('strict validation: no coercion of strings, no NaN, no missing required fields', () => {
  const bad = [
    [{ dev: 'M', t: 1773261000, p: '350' }, 'p'],
    [{ dev: 'M', t: 1773261000, p: Number.NaN }, 'p'],
    [{ dev: 'M', t: 1773261000, p: Infinity }, 'p'],
    [{ dev: 'M', t: 1773261000 }, 'p'],
    [{ dev: 'M', t: 'yesterday', p: 1 }, 't'],
    [{ dev: 'M', t: 1773261000, p: 1, st: 'EXPLODED' }, 'st'],
    [{ dev: 'x'.repeat(65), t: 1773261000, p: 1 }, 'dev'],
  ];
  for (const [raw, field] of bad) {
    assert.throws(() => normalizeReading(raw, 'enersense'), (e) => e instanceof ReadingFormatError && e.field === field, JSON.stringify(raw));
  }
  assert.throws(() => normalizeReading({ module_id: 'MX', load_id: 'freezer', power_w: 1, status: 'fine' }), /no es válido/);
  assert.throws(() => normalizeReading({ module_id: 'MX', power_w: 1 }), /load_id/);
  assert.throws(() => normalizeReading({ meter: { id: 'M' }, sampled_at: 'nope', metrics: { watts: 1 } }, 'voltiolab'), /fecha/);
  assert.throws(() => normalizeReading({ meter: { id: 'M' }, metrics: 'x' }, 'voltiolab'), ReadingFormatError);
  assert.throws(() => normalizeReading(null, 'esp32'), ReadingFormatError);
  assert.throws(() => normalizeReading([1], 'enersense'), ReadingFormatError);
});
