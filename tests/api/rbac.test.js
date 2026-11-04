const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/api');
const { ROLES } = require('../../backend/domain/constants');
const { permissionsOf } = require('../../backend/domain/permissions');

let env;
let owner;
before(async () => { env = await startApp(); owner = await env.as('owner'); });
after(() => env.close());

test('login, me and logout: me returns role code, display name and permissions', async () => {
  const bad = await env.login('demo-owner', 'wrong-password-123456');
  assert.equal(bad.status, 401);
  const me = await owner.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.roleCode, 'owner');
  assert.equal(me.body.displayName, ROLES.owner);
  assert.deepEqual(me.body.permissions, permissionsOf('owner'));
  const finance = await env.as('finance');
  assert.deepEqual((await finance.get('/api/auth/me')).body.permissions, permissionsOf('finance'));
  const temp = await env.as('owner');
  assert.equal((await temp.post('/api/auth/logout')).status, 200);
  assert.equal((await temp.get('/api/auth/me')).status, 401);
});

test('unauthenticated calls get 401', async () => {
  assert.equal((await fetch(`${env.base}/api/loads`)).status, 401);
  const noSession = await fetch(`${env.base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noSession.status, 401);
});

test('owner manages users: create with a role, weak password refused, change role, deactivate, reset password', async () => {
  const weak = await owner.post('/api/users', { username: 'ana', role: 'finance', password: 'short' });
  assert.equal(weak.status, 400);
  const created = await owner.post('/api/users', { username: 'ana', role: 'finance', password: 'a-long-enough-password-1', displayName: 'Ana' });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, 'finance');
  const id = created.body.id;
  assert.equal((await env.login('ana', 'a-long-enough-password-1')).status, 200);

  assert.equal((await owner.patch(`/api/users/${id}/role`, { role: 'sustainability' })).body.role, 'sustainability');
  assert.equal((await owner.patch(`/api/users/${id}/role`, { role: 'nope' })).status, 400);

  const session = await env.login('ana', 'a-long-enough-password-1');
  assert.equal((await owner.post(`/api/users/${id}/reset-password`, { password: 'another-long-password-2' })).status, 200);
  assert.equal((await session.get('/api/auth/me')).status, 401, 'reset ends the old sessions');
  assert.equal((await env.login('ana', 'a-long-enough-password-1')).status, 401);
  assert.equal((await env.login('ana', 'another-long-password-2')).status, 200);

  assert.equal((await owner.post(`/api/users/${id}/deactivate`)).body.active, false);
  assert.equal((await env.login('ana', 'another-long-password-2')).status, 401);
  const events = env.repos.audit.list({ role: 'owner', limit: 500 }).map((r) => r.event);
  assert.ok(events.includes('user_created'));
  assert.ok(events.includes('user_role_changed'));
});

test('the last active owner cannot be demoted or deactivated', async () => {
  const owners = (await owner.get('/api/users')).body.users.filter((u) => u.role === 'owner' && u.active);
  const me = owners.find((u) => u.username === 'demo-owner');
  for (const u of owners.filter((o) => o.id !== me.id)) await owner.post(`/api/users/${u.id}/deactivate`);
  assert.equal((await owner.post(`/api/users/${me.id}/deactivate`)).status, 422);
  assert.equal((await owner.patch(`/api/users/${me.id}/role`, { role: 'finance' })).status, 422);
});

test('every non-owner role is rejected on administration with a 403, plain Spanish and an audit row', async () => {
  const adminCalls = [
    ['GET', '/api/users'], ['GET', '/api/audit'], ['GET', '/api/settings'], ['PUT', '/api/settings'], ['GET', '/api/tariffs'],
    ['POST', '/api/tariffs'], ['GET', '/api/loads/config'], ['POST', '/api/users'],
  ];
  for (const role of Object.keys(ROLES).filter((r) => r !== 'owner')) {
    const client = await env.as(role);
    for (const [method, url] of adminCalls) {
      const before = env.repos.audit.list({ role, event: 'permission_denied', limit: 1000 }).length;
      const res = await client.call(method, url, method === 'GET' ? undefined : {});
      assert.equal(res.status, 403, `${role} ${method} ${url}`);
      assert.match(res.body.error, /no tiene permiso/);
      const after = env.repos.audit.list({ role, event: 'permission_denied', limit: 1000 });
      assert.equal(after.length, before + 1, `${role} ${method} ${url} audited`);
      assert.equal(after[0].result, 'rejected');
      assert.equal(after[0].role, role);
    }
  }
});

test('audit list filters by role, result and action', async () => {
  const rejected = await owner.get('/api/audit?result=rejected&role=finance');
  assert.equal(rejected.status, 200);
  assert.ok(rejected.body.count > 0);
  assert.ok(rejected.body.entries.every((e) => e.role === 'finance' && e.result === 'rejected'));
  assert.equal((await owner.get('/api/audit?role=wizard')).status, 400);
});

test('settings: read, validate and update investment, emission factor, threshold and window', async () => {
  const before = (await owner.get('/api/settings')).body;
  assert.ok(before.investmentCop > 0);
  const updated = await owner.put('/api/settings', { investmentCop: 5_000_000, emissionFactorKgPerKwh: 0.2, emissionFactorSource: 'UPME 2025', alertThresholdPct: 25, alertWindowMinutes: 20 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.investmentCop, 5_000_000);
  assert.equal(updated.body.emissionFactorSource, 'UPME 2025');
  assert.equal(updated.body.alertThresholdPct, 25);
  assert.equal((await owner.put('/api/settings', { investmentCop: -1 })).status, 400);
  assert.ok(env.repos.audit.list({ event: 'settings_updated' }).length >= 1);
  await owner.put('/api/settings', {
    investmentCop: before.investmentCop, emissionFactorKgPerKwh: before.emissionFactorKgPerKwh, emissionFactorSource: before.emissionFactorSource,
    alertThresholdPct: before.alertThresholdPct, alertWindowMinutes: before.alertWindowMinutes,
  });
});

test('tariff with an effective date only changes costs from that date', async () => {
  const loadId = env.repos.loads.getByCode(env.app.siteId, 'freezer').id;
  const cost = (date) => {
    const from = Date.parse(`${date}T05:00:00Z`);
    return env.app.analytics.energy(loadId, from, from + 86_400_000, env.app.analytics.tariffsOf(env.app.siteId));
  };
  const day = '2026-03-09';
  const beforeCop = cost(day).cop;
  assert.ok(cost(day).kwh > 0);
  const list = (await owner.get('/api/tariffs')).body.tariffs;
  const baseRate = list[list.length - 1].copPerKwh;
  const created = await owner.post('/api/tariffs', { copPerKwh: baseRate * 2, effectiveFrom: '2026-03-10' });
  assert.equal(created.status, 201);
  assert.ok(Math.abs(cost(day).cop - beforeCop) < 1e-6, 'a day before the effective date keeps its price');
  const after = cost('2026-03-10');
  assert.ok(Math.abs(after.cop / after.kwh - baseRate * 2) < 1e-6, 'from the effective date the new rate applies');
  assert.equal((await owner.post('/api/tariffs', { copPerKwh: 0, effectiveFrom: '2026-03-10' })).status, 400);
});

test('load configuration: critical never gets control, new loads are monitor-only and essential', async () => {
  const configs = (await owner.get('/api/loads/config')).body.loads;
  const critical = configs.find((l) => l.criticality === 'critical');
  const refused = await owner.put(`/api/loads/${critical.code}/config`, { controlMode: 'control_enabled' });
  assert.ok([400, 422].includes(refused.status));
  assert.equal(env.repos.loads.getByCode(env.app.siteId, critical.code).control_mode, 'monitor_only');
  const target = configs.find((l) => l.criticality !== 'critical');
  const ok = await owner.put(`/api/loads/${target.code}/config`, { criticality: 'non_essential', controlMode: 'control_enabled' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.controlMode, 'control_enabled');
  const technician = await env.as('installer_technician');
  const registered = await technician.post('/api/modules', { id: 'MX-NEW-01', manufacturer: 'EnerSense', loadName: 'Horno nuevo' });
  assert.equal(registered.status, 201);
  const fresh = env.repos.loads.listBySite(env.app.siteId).find((l) => l.name === 'Horno nuevo');
  assert.equal(fresh.control_mode, 'monitor_only');
  assert.equal(fresh.criticality, 'essential');
});

test('migration 008: the operations manager proposes, the administrator approves', () => {
  const role = env.repos.roles.get('operations_manager');
  assert.match(role.description, /propone/i);
  assert.match(role.description, /administrador/i);
});
