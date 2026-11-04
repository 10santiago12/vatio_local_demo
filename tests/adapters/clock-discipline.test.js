const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..', '..', 'backend');
const SCANNED = ['app', 'adapters', 'domain'];
// The clock adapter is the only place allowed to read the real time.
const ALLOWED = new Set([path.join(BACKEND, 'adapters', 'clock.js')]);
const FORBIDDEN = [/Date\.now\(\)/, /new Date\(\)/, /Math\.random\(\)/, /performance\.now\(\)/, /process\.hrtime/];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.name.endsWith('.js') ? [full] : [];
  });
}

test('nothing outside the clock adapter reads the real time or unseeded randomness', () => {
  const offenders = [];
  for (const dir of SCANNED) {
    for (const file of walk(path.join(BACKEND, dir))) {
      if (ALLOWED.has(file)) continue;
      const code = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n');
      for (const pattern of FORBIDDEN) if (pattern.test(code)) offenders.push(`${path.relative(BACKEND, file)}: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, []);
});
