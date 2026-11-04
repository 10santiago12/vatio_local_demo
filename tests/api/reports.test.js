const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startApp } = require('../helpers/api');
const { ROLES } = require('../../backend/domain/constants');
const { buildPdf } = require('../../backend/app/pdf');

let env;
let owner;
before(async () => { env = await startApp(); owner = await env.as('owner'); });
after(() => env.close());

const pdftotext = spawnSync('pdftotext', ['-v']);
const hasPdftotext = !pdftotext.error;

/** Text of a PDF buffer with whitespace flattened (so wrapped lines read as one). */
function pdfText(buffer) {
  const file = path.join(env.dir, `${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(file, buffer);
  const result = spawnSync('pdftotext', ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.replace(/\s+/g, ' ');
}
/** Number after a label in the flattened PDF text, in Colombian format ("1.234,5" or "$ 1.234"). */
function after_(text, label) {
  const m = new RegExp(`${label.replace(/[()]/g, '\\$&')}:? \\$? ?(-?[\\d.,]+)`).exec(text);
  assert.ok(m, `"${label}" found in the PDF`);
  return Number(m[1].replace(/\./g, '').replace(',', '.'));
}
async function expectDenied(role, url) {
  const client = await env.as(role);
  const before = env.repos.audit.list({ role, event: 'permission_denied', limit: 1000 }).length;
  const res = await client.get(url);
  assert.equal(res.status, 403, `${role} ${url}`);
  const rows = env.repos.audit.list({ role, event: 'permission_denied', limit: 1000 });
  assert.equal(rows.length, before + 1, `${role} ${url} audited`);
  assert.equal(rows[0].result, 'rejected');
}

test('the PDF writer produces a valid multi-page document with accents', { skip: !hasPdftotext && 'pdftotext not installed' }, () => {
  const lines = Array.from({ length: 120 }, (_, i) => `Línea ${i + 1}: ahorro de energía en años, ¿cuánto? ×2 (50 %)`);
  const buffer = buildPdf({ title: 'Prueba', lines });
  assert.equal(buffer.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.ok(buffer.toString('latin1').includes('/Count 3') || buffer.toString('latin1').includes('/Count 2'));
  const text = pdfText(buffer);
  assert.match(text, /Línea 1: ahorro de energía en años, ¿cuánto\? ×2 \(50 %\)/);
  assert.match(text, /Línea 120:/);
});

test('monthly report JSON, CSV and PDF carry identical values', { skip: !hasPdftotext && 'pdftotext not installed' }, async () => {
  const finance = await env.as('finance');
  const api = (await finance.get('/api/reports/monthly?month=2026-03')).body;
  assert.equal(api.month, '2026-03');
  assert.equal(api.period.partial, true);
  assert.ok(api.summary.consumptionKwh > 0 && api.loads.length >= 10);

  const csv = await finance.get('/api/reports/monthly/download?month=2026-03&format=csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /vatio-reporte-2026-03\.csv/);
  const rows = csv.text.trim().split('\r\n').map((l) => l.split(','));
  assert.deepEqual(rows[0], ['section', 'code', 'name', 'consumption_kwh', 'consumption_cost_cop', 'baseline_kwh', 'savings_kwh', 'savings_cop']);
  const total = rows[1];
  assert.equal(Number(total[3]), api.summary.consumptionKwh);
  assert.equal(Number(total[4]), api.summary.consumptionCostCop);
  assert.equal(Number(total[5]), api.summary.baselineKwh);
  assert.equal(Number(total[6]), api.summary.savingsKwh);
  assert.equal(Number(total[7]), api.summary.savingsCop);
  assert.equal(rows.length - 2, api.loads.length);
  api.loads.forEach((l, i) => {
    const row = rows[i + 2];
    assert.equal(row[1], l.code);
    assert.equal(Number(row[3]), l.consumptionKwh);
    assert.equal(Number(row[7]), l.savingsCop);
  });

  const pdf = await finance.get('/api/reports/monthly/download?month=2026-03&format=pdf');
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /application\/pdf/);
  const text = pdfText(pdf.buffer);
  assert.equal(after_(text, 'Consumo'), api.summary.consumptionKwh);
  assert.equal(after_(text, 'Costo del consumo'), api.summary.consumptionCostCop);
  assert.equal(after_(text, 'Consumo esperado según la línea base'), api.summary.baselineKwh);
  assert.equal(after_(text, 'Ahorro del periodo'), api.summary.savingsKwh);
  assert.equal(after_(text, 'Ahorro en pesos'), api.summary.savingsCop);
  assert.equal(after_(text, 'Inversión'), api.summary.investmentCop);
  assert.ok(text.includes(api.siteName.replace('–', '-')));
  assert.ok(env.repos.audit.list({ role: 'finance', event: 'report_downloaded' }).length >= 2);

  assert.equal((await finance.get('/api/reports/monthly/download?format=docx')).status, 400);
  assert.equal((await finance.get('/api/reports/monthly?month=2026-13')).status, 400);
});

test('only finance and the owner see and download the monthly report; every other role is rejected and audited', async () => {
  for (const role of Object.keys(ROLES).filter((r) => !['owner', 'finance'].includes(r))) {
    await expectDenied(role, '/api/reports/monthly');
    await expectDenied(role, '/api/reports/monthly/download?format=csv');
  }
});

test('ODS 7 report: kWh avoided, reduction, kgCO2e = kWh x factor, period, methodology and factor source; JSON and PDF agree', { skip: !hasPdftotext && 'pdftotext not installed' }, async () => {
  await owner.put('/api/settings', { emissionFactorKgPerKwh: 0.126, emissionFactorSource: 'UPME 2024 (prueba)' });
  const sustainability = await env.as('sustainability');
  const api = (await sustainability.get('/api/reports/impact?from=2026-02-20&to=2026-03-10')).body;
  assert.equal(api.period.from, '2026-02-20');
  assert.equal(api.period.days, 19);
  assert.ok(api.avoidedKwh > 0);
  assert.ok(Math.abs(api.avoidedKgCo2e - api.avoidedKwh * 0.126) <= 0.01);
  assert.ok(Math.abs(api.reductionPct - (api.avoidedKwh / api.baselineKwh) * 100) <= 0.01);
  assert.equal(api.emissionFactorSource, 'UPME 2024 (prueba)');
  assert.match(api.methodology, /kWh evitados × factor de emisión/);

  const json = await sustainability.get('/api/reports/impact/download?format=json&from=2026-02-20&to=2026-03-10');
  assert.equal(json.status, 200);
  assert.equal(JSON.parse(json.text).avoidedKgCo2e, api.avoidedKgCo2e);

  const pdf = await sustainability.get('/api/reports/impact/download?format=pdf&from=2026-02-20&to=2026-03-10');
  assert.equal(pdf.status, 200);
  const text = pdfText(pdf.buffer);
  assert.equal(after_(text, 'Energía evitada'), api.avoidedKwh);
  assert.equal(after_(text, 'Reducción'), api.reductionPct);
  assert.equal(after_(text, 'Emisiones evitadas'), api.avoidedKgCo2e);
  assert.ok(text.includes('2026-02-20 a 2026-03-10'));
  assert.ok(text.includes('UPME 2024 (prueba)'));
  assert.ok(text.includes('Metodología'));

  assert.equal((await sustainability.get('/api/reports/impact?from=2026-03-10&to=2026-02-20')).status, 400);
  assert.equal((await sustainability.get('/api/reports/impact?to=2030-01-01')).status, 400);
  for (const role of Object.keys(ROLES).filter((r) => !['owner', 'sustainability'].includes(r))) {
    await expectDenied(role, '/api/reports/impact');
    await expectDenied(role, '/api/reports/impact/download?format=pdf');
  }
});
