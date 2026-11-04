const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertNodeVersion } = require('../backend/runtime-guard');

test('guard exits with a Spanish message on Node < 24', () => {
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(String(message));
  let code;
  try { assert.equal(assertNodeVersion('20.17.0', (c) => { code = c; }), false); } finally { console.error = original; }
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /requiere Node\.js 24/);
});

test('guard accepts Node 24 and newer', () => {
  assert.equal(assertNodeVersion('24.0.0', () => assert.fail('must not exit')), true);
  assert.equal(assertNodeVersion('26.1.0', () => assert.fail('must not exit')), true);
});
