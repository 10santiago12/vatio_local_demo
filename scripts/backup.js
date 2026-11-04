'use strict';
/** Creates a consistent backup of the live database now: `npm run backup`. */
require('../backend/runtime-guard').assertNodeVersion();
const { getConfigOrExit } = require('../backend/config');
const { openDatabase } = require('../backend/db/connection');
const { createBackup } = require('../backend/ops/backup');

const config = getConfigOrExit();
const db = openDatabase(config.dbPath);
createBackup({ db, dir: config.backupDir, keep: config.backupKeep })
  .then((result) => { console.log(`Respaldo creado: ${result.file} (${result.size_bytes} bytes, sha256 ${result.sha256})`); })
  .catch((error) => { console.error(`No se pudo crear el respaldo: ${error.message}`); process.exitCode = 1; })
  .finally(() => db.close());
