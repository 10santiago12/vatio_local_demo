'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEmail } = require('../backend/app/email');
const { buildConfig, ConfigError } = require('../backend/config');
const { startApp } = require('./helpers/api');

const values = {
  VATIO_SMTP_HOST: 'smtp.example.test', VATIO_SMTP_PORT: '587',
  VATIO_SMTP_USER: 'test-user', VATIO_SMTP_PASSWORD: 'test-secret',
  VATIO_SMTP_FROM: 'from@example.test', VATIO_SMTP_TO: 'to@example.test',
};

test('SMTP configuration is optional, complete, and limited to TLS ports', () => {
  assert.equal(buildConfig({}).smtp, null);
  assert.throws(() => buildConfig({ VATIO_SMTP_HOST: 'smtp.example.test' }), ConfigError);
  assert.throws(() => buildConfig({ ...values, VATIO_SMTP_PORT: '25' }), ConfigError);
  assert.throws(() => buildConfig({ ...values, VATIO_SMTP_TO: 'one@example.test\nbcc:two@example.test' }), ConfigError);
  assert.equal(buildConfig(values).smtp.port, 587);
});

test('SMTP test message uses fixed recipients, enforces STARTTLS, and audits without secrets', async () => {
  const audit = [];
  let options;
  let message;
  const email = createEmail({
    config: buildConfig(values),
    access: { audit: (record) => audit.push(record) },
    transportFactory: (input) => {
      options = input;
      return { sendMail: async (m) => { message = m; return { accepted: [m.to], rejected: [] }; }, close() {} };
    },
  });
  assert.deepEqual(await email.sendTest({ username: 'owner' }), { ok: true });
  assert.equal(options.requireTLS, true);
  assert.equal(options.secure, false);
  assert.equal(message.to, 'to@example.test');
  assert.equal(message.from, 'from@example.test');
  assert.equal(audit[0].event, 'email_test_sent');
  assert.doesNotMatch(JSON.stringify(audit), /test-secret|to@example/);
  email.close();
});

test('SMTP rejection does not report successful delivery', async () => {
  const audit = [];
  const email = createEmail({
    config: buildConfig({ ...values, VATIO_SMTP_PORT: '465' }),
    access: { audit: (record) => audit.push(record) },
    transportFactory: (options) => {
      assert.equal(options.secure, true);
      return { sendMail: async () => ({ accepted: [], rejected: ['to@example.test'] }), close() {} };
    },
  });
  await assert.rejects(email.sendTest({}), (error) => error.code === 'email_failed');
  assert.equal(audit[0].event, 'email_test_failed');
  email.close();
});

test('email management requires owner session and CSRF', async (t) => {
  const env = await startApp({ seed: false });
  t.after(env.close);
  assert.equal((await fetch(env.base + '/api/ops/email')).status, 401);
  const owner = await env.as('owner');
  assert.deepEqual((await owner.get('/api/ops/email')).body, { configured: false });
  assert.equal((await owner.post('/api/ops/email/test')).status, 503);
  const other = await env.as('finance');
  assert.equal((await other.get('/api/ops/email')).status, 403);
  assert.equal((await other.post('/api/ops/email/test')).status, 403);
  const noCsrf = await owner.call('POST', '/api/ops/email/test', {}, { 'x-csrf-token': '' });
  assert.equal(noCsrf.status, 403);
});
