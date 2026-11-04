const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatCop, formatNumber } = require('../../backend/domain/text');

test('pesos use dot thousands separators and round to whole pesos', () => {
  assert.equal(formatCop(1234567), '$ 1.234.567');
  assert.equal(formatCop(480), '$ 480');
  assert.equal(formatCop(0), '$ 0');
  assert.equal(formatCop(949.6), '$ 950');
});

test('decimals use a comma and trailing zeros are trimmed', () => {
  assert.equal(formatNumber(12.5), '12,5');
  assert.equal(formatNumber(12), '12');
  assert.equal(formatNumber(0.126, 3), '0,126');
  assert.equal(formatNumber(40.04, 0), '40');
});
