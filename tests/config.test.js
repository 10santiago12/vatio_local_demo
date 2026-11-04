const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildConfig, parseEnv, loadEnvFile, ConfigError } = require('../backend/config');

const STRONG_PASSWORD = 'a-very-long-unique-password';
const STRONG_KEY = 'device-key-unique-0123456789';

test('local profile defaults to loopback host and port 3000', () => {
  const config = buildConfig({});
  assert.equal(config.appEnv, 'local');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
  assert.equal(config.isProduction, false);
});

test('production defaults to 0.0.0.0 and reads PORT', () => {
  const config = buildConfig({ APP_ENV: 'production', PORT: '8080', VATIO_ADMIN_PASSWORD: STRONG_PASSWORD, VATIO_DEVICE_KEY: STRONG_KEY });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 8080);
});

test('invalid APP_ENV and PORT are rejected with every problem listed', () => {
  assert.throws(() => buildConfig({ APP_ENV: 'staging', PORT: '99999' }), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.problems.length, 2);
    return true;
  });
});

test('production requires strong unique secrets', () => {
  const production = { APP_ENV: 'production' };
  assert.throws(() => buildConfig(production), /VATIO_ADMIN_PASSWORD es obligatoria/);
  assert.throws(() => buildConfig({ ...production, VATIO_ADMIN_PASSWORD: 'short' }), /al menos 16/);
  assert.throws(() => buildConfig({ ...production, VATIO_ADMIN_PASSWORD: STRONG_PASSWORD }), /VATIO_DEVICE_KEY es obligatoria/);
  assert.throws(() => buildConfig({ ...production, VATIO_ADMIN_PASSWORD: STRONG_PASSWORD, VATIO_DEVICE_KEY: 'vatio-demo-2026' }), /inseguro/);
  assert.throws(() => buildConfig({ ...production, VATIO_ADMIN_PASSWORD: STRONG_PASSWORD, VATIO_DEVICE_KEY: STRONG_PASSWORD }), /distintas/);
});

test('local profile accepts a missing device key but rejects a short admin password', () => {
  assert.equal(buildConfig({ VATIO_ADMIN_PASSWORD: STRONG_PASSWORD }).deviceKey, '');
  assert.throws(() => buildConfig({ VATIO_ADMIN_PASSWORD: 'short' }), /al menos 16/);
});

test('secure cookie in production, behind HTTPS proxy, or direct TLS only', () => {
  const local = buildConfig({});
  assert.equal(local.secureCookie({ headers: {}, socket: {} }), false);
  assert.equal(local.secureCookie({ headers: { 'x-forwarded-proto': 'https' }, socket: {} }), true);
  assert.equal(local.secureCookie({ headers: { 'x-forwarded-proto': 'http' }, socket: {} }), false);
  assert.equal(local.secureCookie({ headers: {}, socket: { encrypted: true } }), true);
  const production = buildConfig({ APP_ENV: 'production', VATIO_ADMIN_PASSWORD: STRONG_PASSWORD, VATIO_DEVICE_KEY: STRONG_KEY });
  assert.equal(production.secureCookie({ headers: {}, socket: {} }), true);
});

test('.env parser handles comments, quotes and export', () => {
  const parsed = parseEnv('# comment\nA=1\nexport B="two words"\nC=\'x\'\nD=value # trailing\n\nbad line\nE=\n');
  assert.deepEqual(parsed, { A: '1', B: 'two words', C: 'x', D: 'value', E: '' });
});

test('.env loading never overrides real environment variables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-env-'));
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, '﻿PORT=4000\nHOST=0.0.0.0\n');
    const env = { PORT: '5000' };
    const applied = loadEnvFile(file, env);
    assert.deepEqual(applied, ['HOST']);
    assert.equal(env.PORT, '5000');
    assert.equal(env.HOST, '0.0.0.0');
    assert.deepEqual(loadEnvFile(path.join(dir, 'missing.env'), {}), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server refuses to start in production with insecure configuration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-prod-'));
  try {
    const result = spawnSync(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 15000,
      env: { PATH: process.env.PATH, APP_ENV: 'production', VATIO_DB: path.join(dir, 'x.sqlite'), VATIO_ENV_FILE: path.join(dir, 'absent.env') }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR de configuración/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
