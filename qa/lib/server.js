'use strict';
// Starts a throwaway Vatio server (temp DB, local profile, random secrets) for QA runs.
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

function randomSecret() { return crypto.randomBytes(18).toString('hex'); }

async function startServer({ port, seed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-qa-'));
  const env = {
    ...process.env,
    APP_ENV: 'local',
    PORT: String(port),
    VATIO_DB: path.join(dir, 'qa.sqlite'),
    VATIO_ENV_FILE: path.join(dir, 'none.env'),
    VATIO_ADMIN_PASSWORD: randomSecret(),
    VATIO_DEVICE_KEY: randomSecret(),
  };
  if (seed) {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'seed-demo.js')], { env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`seed failed: ${r.stderr}`);
  }
  const child = spawn(process.execPath, [path.join(root, 'server.js')], { env, stdio: 'ignore', cwd: root });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    baseUrl, env, dir, pid: child.pid,
    adminPassword: env.VATIO_ADMIN_PASSWORD, deviceKey: env.VATIO_DEVICE_KEY,
    stop() {
      child.kill();
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite file may linger briefly */ }
    },
  };
}

async function login(baseUrl, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  if (!res.ok) throw new Error(`login failed ${res.status}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const { csrf } = await res.json();
  return { cookie, csrf };
}

module.exports = { startServer, login };
