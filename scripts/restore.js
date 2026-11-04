'use strict';
/**
 * Restores a backup over the database: `node scripts/restore.js <file> [--force]`.
 * Stop the server first. The replaced database is kept as `<db>.before-restore`.
 */
require('../backend/runtime-guard').assertNodeVersion();
const path = require('node:path');
const { getConfigOrExit } = require('../backend/config');
const { restoreBackup } = require('../backend/ops/backup');

const args = process.argv.slice(2);
const force = args.includes('--force');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Uso: node scripts/restore.js <archivo-de-respaldo> [--force]');
  process.exit(2);
}
try {
  const config = getConfigOrExit();
  const result = restoreBackup({ file: path.resolve(file), target: config.dbPath, force });
  for (const warning of result.warnings) console.warn(`Aviso: ${warning}`);
  console.log(`Base restaurada en ${result.target}.`);
  if (result.previous) console.log(`La base anterior se guardó en ${result.previous}.`);
} catch (error) {
  console.error(`No se restauró nada: ${error.message}`);
  process.exit(1);
}
