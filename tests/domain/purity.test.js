const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', '..', 'backend', 'domain');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));

test('the domain index exposes every module', () => {
  const domain = require('../../backend/domain');
  const expected = files.filter((f) => f !== 'index.js').map((f) => f.replace(/\.js$/, '')).sort();
  assert.deepEqual(Object.keys(domain).sort(), expected);
  for (const name of expected) assert.equal(typeof domain[name], 'object', name);
});

test('domain modules only require other domain modules (no http, fs, sqlite, db, network)', () => {
  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
      assert.match(match[2], /^\.\/[a-z]+$/, `${file} requires ${match[2]}`);
    }
  }
});

test('domain modules never read the clock or use randomness', () => {
  for (const file of files) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /Date\.now\(|Math\.random\(|new Date\(\)|process\.hrtime|performance\.now/, file);
  }
});

test('every domain module starts with a header comment explaining its rule', () => {
  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.match(source, /^'use strict';\r?\n\/\*\*[\s\S]*?\*\//, file);
  }
});
