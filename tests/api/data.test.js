const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/api');
const { ROLES } = require('../../backend/domain/constants');
const { parseCsv } = require('../../backend/app/data-exchange');

let env;
let analyst;
before(async () => { env = await startApp(); analyst = await env.as('data_analyst'); });
after(() => env.close());

const FILTER = 'site=la-espiga-chia&load=pos&from=2026-03-10&to=2026-03-10';

test('export raw data as CSV and JSON with filters, audited', async () => {
  const csv = await analyst.get(`/api/data/export?${FILTER}&format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /\.csv"/);
  const table = parseCsv(csv.text);
  assert.deepEqual(table[0], ['site_id', 'load_code', 'ts', 'power_w', 'voltage_v', 'current_a', 'energy_kwh', 'module_id', 'source']);
  assert.ok(table.length > 1000, 'a full day of 1-minute readings');
  assert.ok(table.slice(1).every((r) => r[0] === 'la-espiga-chia' && r[1] === 'pos' && r[2].startsWith('2026-03-1')));

  const json = await analyst.get(`/api/data/export?${FILTER}&format=json`);
  assert.equal(json.body.count, table.length - 1);
  assert.equal(json.body.rows[0].load_code, 'pos');

  const hourly = await analyst.get('/api/data/export?site=la-espiga-chia&load=pos&granularity=hourly&format=json&limit=24');
  assert.equal(hourly.body.count, 24);
  assert.ok('avg_power_w' in hourly.body.rows[0]);
  assert.equal((await analyst.get('/api/data/export?format=xml')).status, 400);
  assert.equal((await analyst.get('/api/data/export?from=ayer')).status, 400);
  assert.equal((await analyst.get('/api/data/export?site=nowhere')).status, 404);
  assert.ok(env.repos.audit.list({ role: 'data_analyst', event: 'data_exported' }).length >= 3);

  const view = await analyst.get(`/api/data/readings?${FILTER}&limit=50`);
  assert.equal(view.body.count, 50);
});

test('export then re-import: every row is verified against the database (100 % preserved, also after deleting the rows)', async () => {
  const exported = await analyst.get(`/api/data/export?${FILTER}&format=csv`);
  const rows = parseCsv(exported.text).length - 1;

  const again = await analyst.post('/api/data/import', { format: 'csv', content: exported.text });
  assert.equal(again.status, 200);
  assert.equal(again.body.received, rows);
  assert.equal(again.body.duplicates, rows, 'nothing new: the rows already exist');
  assert.equal(again.body.preservedPct, 100);
  assert.equal(again.body.invalid, 0);

  const load = env.repos.loads.getByCode('la-espiga-chia', 'pos');
  const removed = env.repos.readings.deleteRange(load.id, '2026-03-10T00:00:00.000Z', '2026-03-12T00:00:00.000Z');
  assert.ok(removed >= rows);
  const restored = await analyst.post('/api/data/import', { format: 'csv', content: exported.text });
  assert.equal(restored.body.inserted, rows);
  assert.equal(restored.body.verified, rows);
  assert.equal(restored.body.preservedPct, 100);
  assert.match(restored.body.message, /100 % conservado/);

  const json = await analyst.get(`/api/data/export?${FILTER}&format=json`);
  const viaJson = await analyst.post('/api/data/import', { format: 'json', content: json.text });
  assert.equal(viaJson.body.preservedPct, 100);
  assert.equal(env.repos.audit.list({ role: 'data_analyst', event: 'data_imported' }).length, 3);
});

test('invalid rows are reported with a reason and never stored; conflicting values are not counted as preserved', async () => {
  const good = { site_id: 'la-espiga-chia', load_code: 'pos', ts: '2026-01-01T00:00:00.000Z', power_w: 55.5, voltage_v: 120.2, current_a: 0.46, energy_kwh: 0.01, module_id: 'MX-003', source: 'import' };
  const rows = [
    good,
    { ...good, ts: '2026-01-01T00:01:00.000Z', load_code: 'nope' },
    { ...good, ts: 'ayer' },
    { ...good, ts: '2026-01-01T00:02:00.000Z', power_w: -4 },
    { ...good, ts: '2026-01-01T00:03:00.000Z', module_id: 'MX-404' },
  ];
  const result = await analyst.post('/api/data/import', { format: 'json', rows });
  assert.equal(result.body.received, 5);
  assert.equal(result.body.valid, 1);
  assert.equal(result.body.invalid, 4);
  assert.equal(result.body.inserted, 1);
  assert.equal(result.body.preservedPct, 100);
  assert.equal(result.body.invalidSamples.length, 4);
  assert.ok(result.body.invalidSamples.every((s) => s.reason.length > 5));

  const conflict = await analyst.post('/api/data/import', { format: 'json', rows: [{ ...good, power_w: 99 }] });
  assert.equal(conflict.body.duplicates, 1);
  assert.equal(conflict.body.conflicts, 1);
  assert.equal(conflict.body.preservedPct, 0);
  assert.equal((await analyst.post('/api/data/import', { format: 'csv', content: 'a,b\n1,2\n' })).status, 400);
  assert.equal((await analyst.post('/api/data/import', { format: 'json', content: 'not json' })).status, 400);
});

test('every role without the permission is rejected and audited on export and import (100 %)', async () => {
  for (const role of Object.keys(ROLES).filter((r) => !['owner', 'data_analyst'].includes(r))) {
    const client = await env.as(role);
    for (const [method, url, body] of [
      ['GET', '/api/data/export?format=csv'], ['GET', '/api/data/readings'], ['POST', '/api/data/import', { format: 'csv', content: '' }],
    ]) {
      const before = env.repos.audit.list({ role, event: 'permission_denied', limit: 1000 }).length;
      const res = await client.call(method, url, body);
      assert.equal(res.status, 403, `${role} ${url}`);
      assert.match(res.body.error, /no tiene permiso/);
      const rows = env.repos.audit.list({ role, event: 'permission_denied', limit: 1000 });
      assert.equal(rows.length, before + 1, `${role} ${url} audited`);
      assert.equal(rows[0].result, 'rejected');
    }
  }
  const owner = await env.as('owner');
  assert.equal((await owner.get('/api/data/export?format=csv&limit=5')).status, 200);
});
