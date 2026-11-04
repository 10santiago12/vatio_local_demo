const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../backend/db/connection');

const ROOT = path.join(__dirname, '..');
const run = (env, args = []) => spawnSync(process.execPath, ['scripts/seed-demo.js', ...args], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, VATIO_ADMIN_PASSWORD: '', VATIO_DEVICE_KEY: '', APP_ENV: 'local', ...env },
});

test('seed script: seeds a temp database, is idempotent, and reproduces the same data for the same instant', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-seed-'));
  try {
    const env = { VATIO_ENV_FILE: path.join(dir, 'none.env'), VATIO_DB: path.join(dir, 'a.sqlite') };
    const first = run(env, ['--now', '2026-03-11T20:30:00Z']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Datos de demostración cargados/);
    assert.match(first.stdout, /Lecturas de 1 minuto: \d+/);
    const again = run(env, ['--now', '2026-03-11T20:30:00Z']);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /ya estaban cargados/);

    const other = run({ ...env, VATIO_DB: path.join(dir, 'b.sqlite') }, ['--now', '2026-03-11T20:30:00Z']);
    assert.equal(other.status, 0);
    const digest = (file) => {
      const db = openDatabase(file);
      const rows = db.prepare('SELECT ts, power_w, energy_kwh FROM readings ORDER BY load_id, ts').all();
      const out = [rows.length, JSON.stringify(rows.filter((_, i) => i % 997 === 0))];
      db.close();
      return out;
    };
    assert.deepEqual(digest(path.join(dir, 'a.sqlite')), digest(path.join(dir, 'b.sqlite')), 'same seed and instant, same data');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('seed script: production refuses unless explicitly enabled, and rejects unknown options', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-seed-prod-'));
  try {
    const production = {
      APP_ENV: 'production', VATIO_ENV_FILE: path.join(dir, 'none.env'), VATIO_DB: path.join(dir, 'prod.sqlite'),
      VATIO_ADMIN_PASSWORD: 'a-long-unique-test-password', VATIO_DEVICE_KEY: 'a-long-unique-device-key',
    };
    const refused = run(production);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /no se cargan automáticamente en producción/);
    assert.equal(fs.existsSync(path.join(dir, 'prod.sqlite')), false, 'nothing was created');
    const allowed = run({ ...production, VATIO_ALLOW_DEMO_SEED: 'yes' }, ['--now', '2026-03-11T20:30:00Z']);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /Datos de demostración cargados/);
    const bad = run({ VATIO_ENV_FILE: path.join(dir, 'none.env'), VATIO_DB: path.join(dir, 'c.sqlite') }, ['--bogus']);
    assert.notEqual(bad.status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
