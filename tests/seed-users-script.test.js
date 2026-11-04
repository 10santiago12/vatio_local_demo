const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../backend/db/connection');

const ROOT = path.join(__dirname, '..');
const run = (env) => spawnSync(process.execPath, ['scripts/seed-demo-users.js'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, VATIO_ADMIN_PASSWORD: '', VATIO_DEVICE_KEY: '', VATIO_DEMO_PASSWORD: '', ...env },
});

test('seed users: one account per role with generated passwords printed once, idempotent, refused in production', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-users-'));
  try {
    const env = { APP_ENV: 'local', VATIO_ENV_FILE: path.join(dir, 'none.env'), VATIO_DB: path.join(dir, 'u.sqlite') };
    const first = run(env);
    assert.equal(first.status, 0, first.stderr);
    const printed = first.stdout.split('\n').filter((l) => l.trim().startsWith('demo-'));
    assert.equal(printed.length, 9);
    assert.ok(printed.every((l) => l.trim().split(/\s+/)[1].length >= 16), 'generated passwords are long');
    const db = openDatabase(env.VATIO_DB);
    const roles = db.prepare("SELECT role FROM users WHERE username LIKE 'demo-%' ORDER BY role").all().map((r) => r.role);
    db.close();
    assert.equal(new Set(roles).size, 9);
    const again = run(env);
    assert.match(again.stdout, /Ya existía: demo-owner/);
    assert.doesNotMatch(again.stdout, /creados/);

    const prod = run({
      ...env, APP_ENV: 'production', VATIO_ADMIN_PASSWORD: 'prod-admin-password-1234', VATIO_DEVICE_KEY: 'prod-device-key-0123456789abcdef0123456789',
    });
    assert.equal(prod.status, 2);
    assert.match(prod.stderr, /producción/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
