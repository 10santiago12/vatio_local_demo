'use strict';
// Test-only builder: the whole application (runtime + HTTP server) on a temporary database seeded with
// the demo scenario, one demo user per role, a frozen wall clock and an ephemeral port.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildConfig } = require('../../backend/config');
const { openDatabase } = require('../../backend/db/connection');
const { migrate } = require('../../backend/db/migrate');
const { createRepositories } = require('../../backend/db/repositories');
const { SimulatedClock } = require('../../backend/adapters/clock');
const { seedDemo } = require('../../backend/app/demo-data');
const { seedDemoUsers, demoUsername } = require('../../backend/app/demo-users');
const { createRuntime } = require('../../backend/runtime');
const { createHttpServer } = require('../../backend/http');
const { ANCHOR } = require('./db');

const { CONSENT_VERSIONS } = require('../../backend/app/consent');
const acceptance = { ...CONSENT_VERSIONS, habeasDataAccepted: true, termsAccepted: true };

const PASSWORD = 'test-only-strong-password';

/**
 * @param {{seed?: boolean, env?: object}} [options] `seed: false` leaves the database without demo data.
 */
async function startApp(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-api-'));
  const dbFile = path.join(dir, 'api.sqlite');
  const config = buildConfig({
    APP_ENV: 'local', VATIO_DB: dbFile, VATIO_ADMIN_PASSWORD: PASSWORD, VATIO_DEVICE_KEY: 'test-device-secret', ...(options.env || {}),
  });
  const db = openDatabase(dbFile);
  migrate(db);
  const repos = createRepositories(db);
  if (options.seed !== false) {
    seedDemo({ repos, db, clock: new SimulatedClock({ startMs: ANCHOR, paused: true, realNow: () => 0 }) });
  }
  seedDemoUsers({ repos, env: { VATIO_DEMO_PASSWORD: PASSWORD } });
  const app = createRuntime({ config: { ...config, quiet: true }, db, wallNow: () => 1_000_000 });
  const { server } = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  /** A logged-in client: `call(method, path, body)` returns `{status, body, headers, text}`. */
  async function login(username, password = PASSWORD) {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, ...acceptance }) });
    const session = await response.json();
    const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
    async function call(method, url, body, extraHeaders = {}) {
      const res = await fetch(base + url, {
        method,
        headers: { cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json', ...extraHeaders },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      });
      const buffer = Buffer.from(await res.arrayBuffer());
      const text = buffer.toString('utf8');
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON (CSV, PDF) */ }
      return { status: res.status, body: parsed, text, buffer, headers: res.headers };
    }
    return {
      session, status: response.status, call,
      get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b), put: (u, b) => call('PUT', u, b), patch: (u, b) => call('PATCH', u, b),
    };
  }
  const as = (role) => login(demoUsername(role));

  return {
    app, repos, db, base, dir, dbFile, login, as, PASSWORD,
    close() { server.close(); server.closeAllConnections?.(); app.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

module.exports = { startApp, PASSWORD, acceptance };
