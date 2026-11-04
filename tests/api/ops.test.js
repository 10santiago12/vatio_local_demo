const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startApp } = require('../helpers/api');
const { ROLES } = require('../../backend/domain/constants');
const { rolesWith } = require('../../backend/domain/permissions');

let env;
let owner;
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-ops-'));
before(async () => { env = await startApp({ env: { VATIO_BACKUP_DIR: backupDir } }); owner = await env.as('owner'); });
after(() => { env.close(); fs.rmSync(backupDir, { recursive: true, force: true }); });

const ENDPOINTS = [['GET', '/api/ops/events'], ['GET', '/api/ops/errors'], ['GET', '/api/ops/metrics'], ['GET', '/api/ops/backups'], ['POST', '/api/ops/backups'], ['GET', '/api/ops/backups/vatio-20260101-000000000.sqlite/download']];

test('ops permissions belong to the owner only', () => {
  assert.deepEqual(rolesWith('view_ops'), ['owner']);
  assert.deepEqual(rolesWith('manage_backups'), ['owner']);
});

test('every other role is rejected and audited on every ops endpoint', async () => {
  for (const role of Object.keys(ROLES).filter((r) => r !== 'owner')) {
    const client = await env.as(role);
    for (const [method, url] of ENDPOINTS) {
      const res = await client.call(method, url);
      assert.equal(res.status, 403, `${role} ${method} ${url}`);
      assert.match(res.body.error, /no tiene permiso/);
    }
  }
  const denied = env.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'permission_denied' AND details LIKE '%view_ops%'").get().n;
  assert.ok(denied >= 8);
});

test('events: filter by name, date range and limit; invalid filters are 400', async () => {
  await owner.post('/api/events', { name: 'page_view', page: '/hoy' });
  await owner.post('/api/events', { name: 'help_opened' });
  const all = (await owner.get('/api/ops/events')).body;
  assert.ok(all.count >= 2);
  const views = (await owner.get('/api/ops/events?name=page_view&limit=1')).body;
  assert.equal(views.count, 1);
  assert.deepEqual(views.events[0].properties, { page: '/hoy' });
  assert.equal((await owner.get('/api/ops/events?from=2999-01-01')).body.count, 0);
  assert.ok((await owner.get('/api/ops/events?from=1970-01-01&to=1970-01-02')).body.count >= 2); // test clock is frozen near 1970
  assert.equal((await owner.get('/api/ops/events?from=nope')).status, 400);
  assert.equal((await owner.get('/api/ops/events?limit=9999')).status, 400);
});

test('errors lists stored failures with request id', async () => {
  env.repos.errors.log({ source: 'test', message: 'boom', requestId: 'abc' });
  const { body } = await owner.get('/api/ops/errors?limit=5');
  assert.ok(body.errors.some((e) => e.message === 'boom' && e.requestId === 'abc'));
});

test('backups: create, list, metrics and download a byte-identical SQLite file', async () => {
  const created = await owner.post('/api/ops/backups');
  assert.equal(created.status, 201);
  const { name } = created.body.backup;
  const list = (await owner.get('/api/ops/backups')).body;
  assert.equal(list.backups[0].name, name);
  const download = await owner.get(`/api/ops/backups/${name}/download`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.ok(download.buffer.equals(fs.readFileSync(path.join(backupDir, name))));
  assert.equal(download.buffer.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await owner.get('/api/ops/backups/..%2F..%2Fsecret/download')).status, 404);
  const m = (await owner.get('/api/ops/metrics')).body;
  assert.equal(m.backup.last_status, 'ok');
  assert.ok(m.backup.last_at);
  assert.ok(m.uptime_s >= 0 && m.requests.total > 0 && m.sessions.active >= 1 && m.db.size_bytes > 0);
  assert.ok(m.latency_ms.p95 >= m.latency_ms.p50);
  for (const k of ['2xx', '3xx', '4xx', '5xx']) assert.ok(k in m.requests.by_status_class);
  const events = env.repos.events.list({ limit: 50 }).map((e) => e.name);
  assert.ok(events.includes('backup_created'));
});
