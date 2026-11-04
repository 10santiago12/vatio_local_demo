const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, PASSWORD } = require('../helpers/api');

let env;
let owner;
before(async () => { env = await startApp(); owner = await env.as('owner'); });
after(() => env.close());
const names = () => env.repos.events.list({ limit: 500 }).map((e) => e.name);

test('login ok, login failed and logout are tracked without credentials', async () => {
  const bad = await fetch(`${env.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong-password-typed' }) });
  assert.equal(bad.status, 401);
  const session = await env.login('admin');
  await session.post('/api/auth/logout');
  const all = names();
  for (const n of ['login_ok', 'login_failed', 'logout']) assert.ok(all.includes(n), n);
  const dump = JSON.stringify(env.repos.events.list({ limit: 500 }));
  assert.ok(!dump.includes('wrong-password-typed') && !dump.includes(PASSWORD));
});

test('business actions are tracked: alert created/reviewed, recommendation, control, report, export', async () => {
  const run = await owner.post('/api/alerts/run');
  assert.equal(run.status, 200);
  const alerts = (await owner.get('/api/alerts?view=active')).body.alerts;
  if (alerts.length) await owner.post(`/api/alerts/${alerts[0].id}/review`);
  await owner.post('/api/recommendations/refresh');
  const rec = (await owner.get('/api/recommendations')).body.recommendations[0];
  await owner.post(`/api/recommendations/${rec.id}/decision`, { action: 'discard', reason: 'prueba' });
  await owner.post('/api/control/toggle', { load: 'freezer', action: 'off' });
  await owner.get('/api/reports/monthly/download?format=csv');
  await owner.get('/api/data/export?format=csv');
  const all = names();
  for (const n of ['recommendation_decision', 'control_decision', 'report_downloaded', 'data_exported']) assert.ok(all.includes(n), n);
  if (alerts.length) assert.ok(all.includes('alert_reviewed'));
});

test('POST /api/events accepts whitelisted names only and is rate limited per user', async () => {
  assert.equal((await owner.post('/api/events', { name: 'page_view', page: '/hoy' })).status, 202);
  const stored = env.repos.events.list({ name: 'page_view', limit: 1 })[0];
  assert.deepEqual(JSON.parse(stored.properties), { page: '/hoy' });
  assert.equal((await owner.post('/api/events', { name: 'drop_table' })).status, 400);
  assert.equal((await owner.post('/api/events', { name: 'page_view', page: '<script>' })).status, 400);
  const anon = await fetch(`${env.base}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"page_view"}' });
  assert.equal(anon.status, 401);
  const viewer = await env.as('non_technical_employee');
  let last;
  for (let i = 0; i < 61; i += 1) last = await viewer.post('/api/events', { name: 'page_view', page: '/x' });
  assert.equal(last.status, 429);
});
