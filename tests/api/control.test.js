const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/api');
const { ROLES } = require('../../backend/domain/constants');

let env;
let owner;
before(async () => { env = await startApp(); owner = await env.as('owner'); });
after(() => env.close());

const siteId = () => env.app.siteId;
const loadOf = (code) => env.repos.loads.getByCode(siteId(), code);
const auditRows = (filter) => env.repos.audit.list({ limit: 1000, ...filter });

async function expectDenied(role, method, url, body) {
  const client = await env.as(role);
  const before = auditRows({ role, event: 'permission_denied' }).length;
  const res = await client.call(method, url, body);
  assert.equal(res.status, 403, `${role} ${method} ${url}`);
  assert.match(res.body.error, /no tiene permiso/);
  const rows = auditRows({ role, event: 'permission_denied' });
  assert.equal(rows.length, before + 1, `${role} ${method} ${url} audited`);
  assert.equal(rows[0].result, 'rejected');
}

test('every role without the permission is rejected and audited on toggle, approvals and closing mode (100 %)', async () => {
  const ownerOnly = [
    ['POST', '/api/control/toggle', { load: 'tv', action: 'off' }], ['GET', '/api/control/approvals'],
    ['POST', '/api/control/approvals/1/approve', {}], ['POST', '/api/control/approvals/1/reject', {}],
  ];
  for (const role of Object.keys(ROLES).filter((r) => r !== 'owner')) {
    for (const [method, url, body] of ownerOnly) await expectDenied(role, method, url, body);
  }
  for (const role of Object.keys(ROLES).filter((r) => !['owner', 'closing_employee'].includes(r))) {
    await expectDenied(role, 'GET', '/api/control/closing-mode');
    await expectDenied(role, 'POST', '/api/control/closing-mode', { confirm: true });
  }
  for (const role of Object.keys(ROLES).filter((r) => !['owner', 'operations_manager'].includes(r))) {
    await expectDenied(role, 'POST', '/api/control/proposals', { load: 'tv', action: 'off' });
  }
  for (const role of Object.keys(ROLES).filter((r) => !['owner', 'installer_technician'].includes(r))) await expectDenied(role, 'POST', '/api/modules', { id: 'X-1', manufacturer: 'A', loadName: 'B' });
});

test('critical load off is always rejected and audited; unauthorized-role attempt is audited too', async () => {
  const res = await owner.post('/api/control/toggle', { load: 'freezer', action: 'off' });
  assert.equal(res.status, 422);
  assert.equal(res.body.outcome, 'rejected');
  assert.equal(res.body.reason, 'critical_load_protected');
  assert.equal(loadOf('freezer').power_state, 'on');
  const row = auditRows({ role: 'owner', loadId: loadOf('freezer').id, result: 'rejected' })[0];
  assert.ok(row, 'audit row for the rejected attempt');
  assert.equal(row.actor, 'demo-owner');
  const legacy = await owner.post('/api/control/requests', { site_id: siteId(), load_id: 'freezer', action: 'off' });
  assert.equal(legacy.status, 422);
});

test('monitor-only stays pending, control-enabled executes, simulated', async () => {
  const tv = loadOf('tv');
  env.repos.loads.updateConfig(tv.id, { criticality: 'non_essential', controlMode: 'monitor_only' });
  const pending = await owner.post('/api/control/toggle', { load: 'tv', action: 'off' });
  assert.equal(pending.status, 202);
  assert.equal(pending.body.outcome, 'pending');
  assert.match(pending.body.message, /solo monitoreo/i);
  assert.equal(env.repos.loads.get(tv.id).power_state, 'on');
  assert.equal(env.repos.controlActions.get(pending.body.actionId).status, 'pending');

  env.repos.loads.updateConfig(tv.id, { controlMode: 'control_enabled' });
  const done = await owner.post('/api/control/toggle', { load: 'tv', action: 'off' });
  assert.equal(done.status, 200);
  assert.equal(done.body.outcome, 'executed');
  assert.equal(done.body.simulated, true);
  assert.equal(env.repos.loads.get(tv.id).power_state, 'off');
  assert.equal((await owner.post('/api/control/toggle', { load: 'tv', action: 'on' })).body.outcome, 'executed');
});

test('approvals inbox: approving a monitor-only item keeps it pending, rejecting records the reason, control-enabled executes', async () => {
  const warmer = loadOf('warmer');
  env.repos.loads.updateConfig(warmer.id, { criticality: 'non_essential', controlMode: 'control_enabled' });
  const at = env.app.clock.nowIso();
  const a = env.repos.controlActions.create({ siteId: siteId(), loadId: warmer.id, origin: 'recommendation', action: 'off', requestedAt: at });
  const b = env.repos.controlActions.create({ siteId: siteId(), loadId: loadOf('tv').id, origin: 'manual', action: 'off', requestedAt: at });
  const inbox = (await owner.get('/api/control/approvals')).body.approvals;
  assert.ok(inbox.some((x) => x.id === a.id && x.origin === 'recommendation'));
  assert.ok(inbox.some((x) => x.id === b.id && x.origin === 'user'));

  env.repos.loads.updateConfig(loadOf('tv').id, { controlMode: 'monitor_only' });
  const kept = await owner.post(`/api/control/approvals/${b.id}/approve`);
  assert.equal(kept.status, 202);
  assert.equal(env.repos.controlActions.get(b.id).status, 'pending');
  const rejected = await owner.post(`/api/control/approvals/${b.id}/reject`, { reason: 'Hoy hay evento' });
  assert.equal(rejected.status, 200);
  assert.equal(env.repos.controlActions.get(b.id).reason, 'Hoy hay evento');
  assert.equal((await owner.post(`/api/control/approvals/${b.id}/reject`, {})).status, 409);

  const executed = await owner.post(`/api/control/approvals/${a.id}/approve`);
  assert.equal(executed.status, 200);
  assert.equal(env.repos.loads.get(warmer.id).power_state, 'off');
  await owner.post('/api/control/toggle', { load: 'warmer', action: 'on' });
});

test('operations manager proposals never execute: they wait in the inbox', async () => {
  const manager = await env.as('operations_manager');
  env.repos.loads.updateConfig(loadOf('warmer').id, { controlMode: 'control_enabled' });
  const res = await manager.post('/api/control/proposals', { load: 'warmer', action: 'off', reason: 'Está vacío' });
  assert.equal(res.status, 202);
  assert.equal(env.repos.loads.getByCode(siteId(), 'warmer').power_state, 'on');
  const inbox = (await owner.get('/api/control/approvals')).body.approvals;
  assert.ok(inbox.some((x) => x.id === res.body.actionId && x.requestedBy === 'demo-operations-manager'));
  assert.equal((await manager.post('/api/control/proposals', { load: 'freezer', action: 'off' })).status, 422);
  assert.equal((await manager.get('/api/control/proposals')).body.proposals.length >= 1, true);
});

test('closing mode: preview changes nothing, confirmation is mandatory, critical loads stay on, estimate and audit', async () => {
  const employee = await env.as('closing_employee');
  const preview = await employee.get('/api/control/closing-mode');
  assert.equal(preview.status, 200);
  assert.ok(preview.body.staysOn.length > 0);
  assert.ok(preview.body.staysOn.some((s) => s.loadId === loadOf('freezer').id));
  assert.ok(Number.isFinite(preview.body.estimatedNightlySavings.cop));
  const states = env.repos.loads.listBySite(siteId()).map((l) => l.power_state).join();

  assert.equal((await employee.post('/api/control/closing-mode', {})).status, 400);
  assert.equal(env.repos.loads.listBySite(siteId()).map((l) => l.power_state).join(), states, 'nothing changed without confirmation');

  env.repos.loads.updateConfig(loadOf('coffee').id, { criticality: 'non_essential', controlMode: 'control_enabled' });
  const confirmed = await employee.post('/api/control/closing-mode', { confirm: true });
  assert.equal(confirmed.status, 200);
  assert.ok(confirmed.body.switchedOff.includes('coffee'));
  assert.equal(loadOf('freezer').power_state, 'on');
  assert.equal(loadOf('coffee').power_state, 'off');
  const audit = auditRows({ role: 'closing_employee', event: 'closing_mode' });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].result, 'executed');
  env.repos.loads.setPowerState(loadOf('coffee').id, 'on');
});

test('safe state: a module silent for more than 5 minutes keeps its load on and its pending actions are discarded with a reason and an audit row', async () => {
  const warmer = loadOf('warmer');
  const module_ = env.repos.modules.listBySite(siteId()).find((m) => m.load_id === warmer.id);
  env.repos.loads.setPowerState(warmer.id, 'on');
  const action = env.repos.controlActions.create({ siteId: siteId(), loadId: warmer.id, origin: 'manual', action: 'off', requestedAt: env.app.clock.nowIso() });
  assert.equal((await owner.post(`/api/demo/modules/${module_.id}/disconnect`)).status, 200);
  env.app.clock.current.advance(4 * 60_000);
  env.app.demo.runJobs();
  assert.equal(env.repos.controlActions.get(action.id).status, 'pending', 'not yet: only 4 minutes of silence');
  env.app.clock.current.advance(2 * 60_000);
  env.app.demo.runJobs();
  const discarded = env.repos.controlActions.get(action.id);
  assert.equal(discarded.status, 'discarded');
  assert.ok(discarded.reason.length > 10);
  assert.equal(env.repos.loads.get(warmer.id).power_state, 'on');
  assert.equal(auditRows({ event: 'safe_state' }).filter((r) => JSON.parse(r.details).actionId === action.id).length, 1);
  const reconnect = await owner.post(`/api/demo/modules/${module_.id}/reconnect`);
  assert.equal(reconnect.status, 200);
  assert.match(reconnect.body.message, /Se sincronizaron \d+ lecturas, 0 perdidas/);
  assert.ok(reconnect.body.stored > 0 && reconnect.body.lost === 0);
});

test('modules: list status and last reading; a technician registers one that is active and reports within 2 simulated minutes', async () => {
  const technician = await env.as('installer_technician');
  const list = (await technician.get('/api/modules')).body.modules;
  assert.ok(list.length >= 11 && list.every((m) => m.status));
  const registered = await technician.post('/api/modules', { id: 'MX-TECH-1', manufacturer: 'EnerSense', loadCode: 'lavadora', loadName: 'Lavadora' });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.status, 'active');
  const load = loadOf('lavadora');
  env.app.clock.current.advance(2 * 60_000);
  env.app.demo.runJobs();
  const first = env.repos.readings.latest(load.id);
  assert.ok(first, 'first reading arrived');
  assert.ok(Date.parse(first.ts) - Date.parse(registered.body.registeredAt) <= 2 * 60_000);
  const diagnostics = await technician.get('/api/modules/MX-TECH-1/diagnostics');
  assert.equal(diagnostics.status, 200);
  assert.ok(diagnostics.body.checks.length >= 3);
  assert.equal((await technician.post('/api/modules', { id: 'MX-TECH-1', manufacturer: 'EnerSense', loadName: 'Otra' })).status, 409);
  assert.equal((await technician.get('/api/control/approvals')).status, 403);
});

test('demo panel: owner only; clock speed, pause, advance; anomaly; sign on; critical off; unauthorized; generate loads; reset', async () => {
  for (const role of Object.keys(ROLES).filter((r) => r !== 'owner')) await expectDenied(role, 'POST', '/api/demo/clock', { speed: 60 });
  const state = (await owner.get('/api/demo/state')).body;
  assert.equal(state.demoMode, true);
  const t0 = Date.parse(state.clock.nowIso ?? env.app.clock.nowIso());
  const day = await owner.post('/api/demo/clock', { paused: true, advance: '1d' });
  assert.equal(day.status, 200);
  assert.ok(Math.abs(Date.parse(env.app.clock.nowIso()) - t0 - 86_400_000) < 120_000);
  assert.equal((await owner.post('/api/demo/clock', { speed: 3600 })).status, 200);
  assert.equal((await owner.post('/api/demo/clock', { speed: 7 })).status, 400);
  assert.equal((await owner.post('/api/demo/clock', { speed: 1, paused: true })).status, 200);
  assert.equal((await owner.post('/api/demo/sign-on')).status, 200);
  assert.equal((await owner.post('/api/demo/deterioration', { loadCode: 'ac', days: 5, pct: 20 })).status, 200);
  const critical = await owner.post('/api/demo/try-critical-off');
  assert.equal(critical.status, 422);
  const unauthorized = await owner.post('/api/demo/try-unauthorized', { asRole: 'finance', permission: 'toggle_load' });
  assert.equal(unauthorized.body.allowed, false);
  assert.ok(auditRows({ event: 'permission_denied' }).some((r) => r.id === unauthorized.body.auditId));
  const before = env.repos.loads.listBySite(siteId()).length;
  assert.equal((await owner.post('/api/demo/generate-loads', { count: 5 })).status, 200);
  assert.equal(env.repos.loads.listBySite(siteId()).length, before + 5);
  const reset = await owner.post('/api/demo/reset');
  assert.equal(reset.status, 200);
  // Generated loads are removed; a load already referenced by the audit trail (lavadora, registered above) is kept.
  assert.equal(env.repos.loads.listBySite(siteId()).length, 12);
  assert.equal(auditRows({ event: 'demo_reset' }).length, 1);
});

test('the demo panel is disabled in production unless VATIO_ENABLE_DEMO_PANEL=yes', async () => {
  const prod = { APP_ENV: 'production', VATIO_DEVICE_KEY: 'prod-device-key-0123456789abcdef0123456789' };
  const off = await startApp({ seed: false, env: prod });
  try {
    const client = await off.as('owner');
    const res = await client.get('/api/demo/state');
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'demo_disabled');
  } finally { off.close(); }
  const on = await startApp({ seed: false, env: { ...prod, VATIO_ENABLE_DEMO_PANEL: 'yes' } });
  try {
    const client = await on.as('owner');
    assert.equal((await client.get('/api/demo/state')).status, 200);
  } finally { on.close(); }
});
