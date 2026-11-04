const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/api');

let env;
before(async () => { env = await startApp({ seed: false }); });
after(() => env.close());

test('an unhandled handler error is stored in error_log and answered with a generic Spanish 500', async () => {
  const owner = await env.as('owner');
  env.app.repos.alerts.list = () => { throw new Error('SQLITE_CORRUPT at /secret/path/vatio.sqlite'); };
  const res = await owner.get('/api/alerts');
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Ocurrió un problema inesperado. Intente de nuevo en unos minutos.', code: 'internal_error' });
  assert.ok(!res.text.includes('SQLITE') && !res.text.includes('secret') && !res.text.includes('at '));
  const requestId = res.headers.get('x-request-id');
  const row = env.repos.errors.list({ limit: 1 })[0];
  assert.equal(row.request_id, requestId);
  assert.equal(row.source, 'http');
  assert.match(row.message, /SQLITE_CORRUPT/);
  assert.match(row.stack, /Error/);
  assert.deepEqual(JSON.parse(row.context), { method: 'GET', path: '/api/alerts', route: '/api/alerts', role: 'owner' });
});

test('client errors (4xx) are not written to error_log', async () => {
  const before = env.repos.errors.list().length;
  const res = await fetch(`${env.base}/api/nope`);
  assert.equal(res.status, 401);
  assert.equal(env.repos.errors.list().length, before);
});
