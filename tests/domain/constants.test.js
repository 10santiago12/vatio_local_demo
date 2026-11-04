const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const c = require('../../backend/domain/constants');

const dir = path.join(__dirname, '..', '..', 'backend', 'db', 'migrations');
const sql = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

/** Values of `<column> ... CHECK (<column> IN (...))` inside CREATE TABLE <table>. */
function enumOf(table, column) {
  const block = sql.split(new RegExp(`CREATE TABLE ${table} \\(`))[1].split(/\n\);/)[0];
  const match = block.match(new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)`));
  assert.ok(match, `no CHECK for ${table}.${column}`);
  return match[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort();
}
const values = (obj) => Object.values(obj).sort();

test('constants match the database CHECK constraints', () => {
  assert.deepEqual(values(c.CRITICALITY), enumOf('loads', 'criticality'));
  assert.deepEqual(values(c.CONTROL_MODE), enumOf('loads', 'control_mode'));
  assert.deepEqual(values(c.POWER_STATE), enumOf('loads', 'power_state'));
  assert.deepEqual(values(c.MODULE_STATUS), enumOf('modules', 'status'));
  assert.deepEqual(values(c.DAY_TYPE), enumOf('baselines', 'day_type'));
  assert.deepEqual(values(c.ALERT_TYPE), enumOf('alerts', 'type'));
  assert.deepEqual(values(c.ALERT_STATUS), enumOf('alerts', 'status'));
  assert.deepEqual(values(c.RECOMMENDATION_TYPE), enumOf('recommendations', 'type'));
  assert.deepEqual(values(c.RECOMMENDATION_STATUS), enumOf('recommendations', 'status'));
  assert.deepEqual(values(c.CONTROL_ORIGIN), enumOf('control_actions', 'origin'));
  assert.deepEqual(values(c.CONTROL_ACTION), enumOf('control_actions', 'action'));
  assert.deepEqual(values(c.CONTROL_STATUS), enumOf('control_actions', 'status'));
});

test('audit results match the audit.result CHECK', () => {
  const match = sql.match(/ADD COLUMN result TEXT CHECK \(result IS NULL OR result IN \(([^)]*)\)/);
  assert.deepEqual(values(c.AUDIT_RESULT), match[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort());
});

test('roles and display names match the roles table seed', () => {
  for (const [code, name] of Object.entries(c.ROLES)) assert.ok(sql.includes(`('${code}', '${name}'`), `${code} / ${name}`);
  assert.equal(Object.keys(c.ROLES).length, 9);
});

test('criticality factors follow the score formula and thresholds match the requirements', () => {
  assert.deepEqual(c.CRITICALITY_FACTOR, { critical: 0.3, essential: 0.6, non_essential: 1.0 });
  assert.equal(c.DEFAULTS.ALERT_THRESHOLD_PCT, 30);
  assert.equal(c.DEFAULTS.ALERT_WINDOW_MINUTES, 15);
  assert.equal(c.DEFAULTS.MODULE_INACTIVE_MINUTES, 2);
  assert.equal(c.DEFAULTS.SAFE_STATE_MINUTES, 5);
  assert.equal(c.DEFAULTS.MIN_BASELINE_DAYS, 7);
});

test('constants are frozen', () => {
  assert.ok(Object.isFrozen(c.CRITICALITY));
  assert.ok(Object.isFrozen(c.DEFAULTS));
});
