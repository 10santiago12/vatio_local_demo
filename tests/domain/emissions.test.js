const { test } = require('node:test');
const assert = require('node:assert/strict');
const { avoidedEmissions } = require('../../backend/domain/emissions');

const base = { avoidedKwh: 200, baselineKwh: 1000, factorKgPerKwh: 0.126, factorSource: 'XM 2024 (ilustrativo)', periodStart: '2026-03-01T05:00:00Z', periodEnd: '2026-03-31T05:00:00Z' };

test('avoided CO2e = kWh avoided x factor, reduction % against the baseline', () => {
  const r = avoidedEmissions(base);
  assert.ok(Math.abs(r.avoidedKgCo2e - 25.2) < 1e-9);
  assert.equal(r.reductionPct, 20);
  assert.equal(r.avoidedKwh, 200);
  assert.equal(r.factorKgPerKwh, 0.126);
});

test('the report carries period, factor source and methodology', () => {
  const r = avoidedEmissions(base);
  assert.deepEqual(r.period, { start: '2026-03-01T05:00:00.000Z', end: '2026-03-31T05:00:00.000Z' });
  assert.equal(r.factorSource, 'XM 2024 (ilustrativo)');
  assert.match(r.methodology, /kWh evitados × factor de emisión \(0,126 kgCO2e por kWh; fuente: XM 2024 \(ilustrativo\)\)/);
  assert.match(r.methodology, /línea base/);
});

test('missing factor source is stated explicitly', () => {
  assert.equal(avoidedEmissions({ ...base, factorSource: '  ' }).factorSource, 'Sin fuente indicada');
  assert.equal(avoidedEmissions({ ...base, factorSource: undefined }).factorSource, 'Sin fuente indicada');
});

test('edge cases: zero baseline, zero avoided, negative avoided, zero factor', () => {
  assert.equal(avoidedEmissions({ ...base, baselineKwh: 0 }).reductionPct, 0);
  assert.equal(avoidedEmissions({ ...base, avoidedKwh: 0 }).avoidedKgCo2e, 0);
  const worse = avoidedEmissions({ ...base, avoidedKwh: -50 });
  assert.ok(worse.avoidedKgCo2e < 0);
  assert.equal(worse.reductionPct, -5);
  assert.equal(avoidedEmissions({ ...base, factorKgPerKwh: 0 }).avoidedKgCo2e, 0);
});

test('an invalid factor is rejected', () => {
  for (const factorKgPerKwh of [-0.1, NaN, Infinity, undefined]) assert.throws(() => avoidedEmissions({ ...base, factorKgPerKwh }), RangeError);
});
