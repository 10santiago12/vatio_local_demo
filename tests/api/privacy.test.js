'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/api');

test('first sign-in requires two explicit current acceptances and records proof once', async (t) => {
  const env = await startApp({ seed: false });
  t.after(env.close);
  const credentials = { username: 'admin', password: env.PASSWORD };
  const login = (body) => fetch(env.base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Vatio QA', 'x-forwarded-for': '203.0.113.1' },
    body: JSON.stringify({ ...credentials, ...body }),
  });
  const first = await login({});
  assert.equal(first.status, 428);
  assert.equal(first.headers.get('set-cookie'), null);
  const { policyVersion, termsVersion } = await first.json();
  const accepted = { policyVersion, termsVersion, habeasDataAccepted: true, termsAccepted: true };
  for (const partial of [{ termsAccepted: false }, { habeasDataAccepted: 'true' }, { policyVersion: 'outdated' }]) {
    assert.equal((await login({ ...accepted, ...partial })).status, 428);
  }
  assert.equal((await login({ ...accepted, password: 'incorrect' })).status, 401);
  assert.equal((await login(accepted)).status, 200);
  assert.equal((await login(accepted)).status, 200);
  assert.equal((await login({})).status, 200);
  const rows = env.db.prepare('SELECT * FROM consents').all();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.user_id, env.repos.users.getByUsername('admin').id);
  assert.equal(row.timestamp_utc, new Date(1_000_000).toISOString());
  assert.equal(row.ip_address, '127.0.0.1');
  assert.equal(row.user_agent, 'Vatio QA');
  assert.deepEqual([row.policy_version, row.terms_version], [policyVersion, termsVersion]);
  assert.deepEqual([row.habeas_data_accepted, row.terms_accepted], [1, 1]);
});

test('public resources need no session and personal data is restricted to the authenticated subject', async (t) => {
  const env = await startApp({ seed: false });
  t.after(env.close);
  for (const [path, title] of [
    ['/politica-de-tratamiento.html', 'Política de Tratamiento'],
    ['/aviso-de-privacidad.html', 'Aviso de Privacidad'],
    ['/terminos-y-condiciones.html', 'Términos y Condiciones'],
  ]) {
    const page = await fetch(env.base + path);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes(title));
  }
  assert.deepEqual(await (await fetch(env.base + '/api/public/contact')).json(), { feedbackUrl: null, pqrEmail: null });
  assert.equal((await fetch(env.base + '/api/me/personal-data')).status, 401);
  const owner = await env.as('owner');
  const analyst = await env.as('data_analyst');
  const response = await analyst.get('/api/me/personal-data?userId=' + env.repos.users.getByUsername(owner.session.username).id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.body.account.username, analyst.session.username);
  assert.equal(response.body.consents.length, 1);
  assert.equal('hash' in response.body.account, false);
  assert.equal('salt' in response.body.account, false);
  assert.deepEqual(response.body.activity.audit.map(({ event, role }) => [event, role]), [['login', 'data_analyst']]);
  assert.deepEqual(response.body.activity.events.map(({ name }) => name), ['login_ok']);
  assert.equal('details' in response.body.activity.audit[0], false);
  assert.equal('properties' in response.body.activity.events[0], false);
  const event = env.db.prepare("SELECT actor FROM audit WHERE event = 'personal_data_accessed'").get();
  assert.equal(event.actor, analyst.session.username);
});

test('public contact configuration accepts HTTPS and a plain email only', async (t) => {
  const { buildConfig, ConfigError } = require('../../backend/config');
  for (const feedbackUrl of ['javascript:alert(1)', 'http://example.test', 'https://u:p@example.test']) {
    assert.throws(() => buildConfig({ VATIO_FEEDBACK_URL: feedbackUrl }), ConfigError);
  }
  assert.throws(() => buildConfig({ VATIO_PQR_EMAIL: 'a@example.test?bcc=b@example.test' }), ConfigError);
  const env = await startApp({ seed: false, env: { VATIO_FEEDBACK_URL: 'https://example.test/form', VATIO_PQR_EMAIL: 'pqr@example.test' } });
  t.after(env.close);
  assert.deepEqual(await (await fetch(env.base + '/api/public/contact')).json(), {
    feedbackUrl: 'https://example.test/form', pqrEmail: 'pqr@example.test',
  });
});
