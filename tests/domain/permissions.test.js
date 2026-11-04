const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PERMISSIONS, MATRIX, can, authorize, permissionsOf, rolesWith } = require('../../backend/domain/permissions');
const { ROLES } = require('../../backend/domain/constants');

const ROLE_CODES = Object.keys(ROLES);

test('the matrix covers exactly the nine roles', () => {
  assert.deepEqual(Object.keys(MATRIX).sort(), [...ROLE_CODES].sort());
});

test('every permission named in the matrix exists', () => {
  for (const role of ROLE_CODES) for (const p of MATRIX[role]) assert.ok(p in PERMISSIONS, `${role}:${p}`);
});

test('owner holds every permission', () => {
  for (const p of Object.keys(PERMISSIONS)) assert.equal(can('owner', p), true, p);
});

test('exact allowed set of each non-owner role', () => {
  assert.deepEqual(permissionsOf('operations_manager').sort(),
    ['propose_action', 'review_alert', 'view_alerts', 'view_load_detail', 'view_operations', 'view_recommendations', 'view_simple']);
  assert.deepEqual(permissionsOf('closing_employee').sort(), ['activate_closing_mode', 'view_simple']);
  assert.deepEqual(permissionsOf('finance').sort(), ['download_report', 'view_reports', 'view_savings']);
  assert.deepEqual(permissionsOf('sustainability').sort(), ['download_impact_report', 'view_impact_report']);
  assert.deepEqual(permissionsOf('chain_owner'), ['view_multisite']);
  assert.deepEqual(permissionsOf('installer_technician').sort(), ['register_module', 'view_diagnostics', 'view_modules']);
  assert.deepEqual(permissionsOf('data_analyst').sort(), ['export_raw_data', 'import_raw_data', 'view_raw_data']);
  assert.deepEqual(permissionsOf('non_technical_employee'), ['view_simple']);
});

test('operations manager can propose but never approve or toggle', () => {
  assert.equal(can('operations_manager', 'propose_action'), true);
  assert.equal(can('operations_manager', 'approve_action'), false);
  assert.equal(can('operations_manager', 'toggle_load'), false);
});

test('every role except owner is denied direct control (toggle and approve)', () => {
  for (const role of ROLE_CODES.filter((r) => r !== 'owner')) {
    for (const p of ['toggle_load', 'approve_action']) {
      const verdict = authorize(role, p);
      assert.equal(verdict.allowed, false, `${role}:${p}`);
      assert.equal(verdict.reason, 'role_not_permitted');
    }
  }
});

test('closing mode is limited to owner and closing employee', () => {
  assert.deepEqual(rolesWith('activate_closing_mode').sort(), ['closing_employee', 'owner']);
});

test('raw export is limited to owner and data analyst; reports to their audiences', () => {
  assert.deepEqual(rolesWith('export_raw_data').sort(), ['data_analyst', 'owner']);
  for (const role of ROLE_CODES.filter((r) => !['owner', 'data_analyst'].includes(r))) {
    assert.equal(authorize(role, 'export_raw_data').allowed, false, role);
    assert.equal(authorize(role, 'import_raw_data').allowed, false, role);
  }
  assert.deepEqual(rolesWith('download_report').sort(), ['finance', 'owner']);
  assert.deepEqual(rolesWith('download_impact_report').sort(), ['owner', 'sustainability']);
});

test('denial carries a plain Spanish message, a machine reason and an audit record', () => {
  const v = authorize('non_technical_employee', 'toggle_load', { at: '2026-03-01T10:00:00.000Z', actor: 'luis' });
  assert.equal(v.allowed, false);
  assert.match(v.message, /Empleado no técnico/);
  assert.match(v.message, /encender o apagar equipos/);
  assert.doesNotMatch(v.message, /toggle_load|403|error/i);
  assert.deepEqual(v.audit, {
    event: 'permission_denied', result: 'rejected', role: 'non_technical_employee', permission: 'toggle_load',
    reason: 'role_not_permitted', at: '2026-03-01T10:00:00.000Z', actor: 'luis',
  });
});

test('denial audit defaults to null timestamp and actor', () => {
  const v = authorize('finance', 'export_raw_data');
  assert.equal(v.audit.at, null);
  assert.equal(v.audit.actor, null);
});

test('unknown role or permission fails closed', () => {
  assert.equal(can('hacker', 'view_simple'), false);
  assert.equal(can('owner', 'fly'), false);
  assert.equal(authorize('hacker', 'view_simple').reason, 'unknown_role');
  assert.equal(authorize('owner', 'fly').reason, 'unknown_permission');
  assert.match(authorize('hacker', 'view_simple').message, /no tiene permiso/);
  assert.deepEqual(permissionsOf('hacker'), []);
  assert.equal(can('constructor', 'view_simple'), false);
  assert.equal(can('owner', 'toString'), false);
});

test('allowed verdict has no audit payload', () => {
  assert.deepEqual(authorize('owner', 'configure'), { allowed: true, role: 'owner', permission: 'configure' });
});

test('permissionsOf returns a copy', () => {
  const list = permissionsOf('finance');
  list.push('configure');
  assert.equal(can('finance', 'configure'), false);
});
