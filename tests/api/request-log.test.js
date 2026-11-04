const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, PASSWORD } = require('../helpers/api');
const { createMetrics, requestLine } = require('../../backend/ops/request-log');

let env;
before(async () => { env = await startApp({ seed: false }); });
after(() => env.close());

test('every response carries a fresh X-Request-Id and one JSON log line without secrets', async () => {
  const lines = [];
  env.app.logRequest = (entry) => lines.push(requestLine({ at: 'T', ...entry }));
  const login = await fetch(`${env.base}/api/auth/login?token=abc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
  const other = await fetch(`${env.base}/api/health`);
  const id1 = login.headers.get('x-request-id');
  const id2 = other.headers.get('x-request-id');
  assert.match(id1, /^[0-9a-f]{16}$/);
  assert.notEqual(id1, id2);
  await new Promise((r) => setTimeout(r, 20));
  const parsed = lines.map((l) => JSON.parse(l));
  const entry = parsed.find((l) => l.request_id === id1);
  assert.deepEqual([entry.method, entry.path, entry.status], ['POST', '/api/auth/login', 200]);
  assert.equal(typeof entry.ms, 'number');
  const text = lines.join('\n');
  for (const secret of [PASSWORD, 'token=abc', 'vatio_session', 'csrf']) assert.ok(!text.includes(secret), secret);
});

test('metrics count status classes and compute percentiles', () => {
  const m = createMetrics({ now: () => 5000 });
  [200, 200, 404, 500].forEach((s, i) => m.record(s, (i + 1) * 10));
  const snap = m.snapshot();
  assert.deepEqual(snap.requests, { total: 4, by_status_class: { '2xx': 2, '3xx': 0, '4xx': 1, '5xx': 1, other: 0 } });
  assert.deepEqual([snap.latency_ms.p50, snap.latency_ms.p95], [20, 40]);
});
