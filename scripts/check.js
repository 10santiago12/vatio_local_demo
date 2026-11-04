'use strict';
// Syntax-checks every JavaScript file in the repository (cross-platform replacement for a shell glob).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const skip = new Set(['node_modules', '.git', 'data']);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(c|m)?js$/.test(entry.name)) files.push(full);
  }
  return files;
}

let failed = 0;
const files = walk(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    console.error(`FAIL ${path.relative(root, file)}\n${result.stderr}`);
  }
}
console.log(`Syntax check: ${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
