'use strict';
/**
 * Database backup and restore (zero dependencies).
 *
 * - `createBackup` uses SQLite's online backup API (node:sqlite `backup`): a consistent copy of the
 *   live database, WAL included, without stopping the server. The copy is verified with
 *   `PRAGMA integrity_check`, gets a SHA-256 sidecar and old copies beyond `keep` are pruned.
 * - `restoreBackup` verifies integrity and checksum, refuses to overwrite without `force` and keeps
 *   the replaced database as `<db>.before-restore`.
 * The restore must run with the server stopped.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

const NAME = /^vatio-\d{8}-\d{9}\.sqlite$/;

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sidecar = (file) => `${file}.sha256`;

/** Makes the copy a single self-contained file (no -wal/-shm companions) and returns its integrity result. */
function finalizeCopy(file) {
  const copy = new DatabaseSync(file);
  try {
    copy.exec('PRAGMA journal_mode = DELETE');
    return copy.prepare('PRAGMA integrity_check').get().integrity_check;
  } finally { copy.close(); }
}

function integrityOf(file) {
  const copy = new DatabaseSync(file, { readOnly: true });
  try { return copy.prepare('PRAGMA integrity_check').get().integrity_check; } finally { copy.close(); }
}

/** `vatio-YYYYMMDD-HHMMSSmmm.sqlite` in UTC, so names sort chronologically. */
function backupName(date) {
  return `vatio-${date.toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '').replace('Z', '')}.sqlite`;
}

/** Backups in `dir`, newest first: `{name, size_bytes, created_at, sha256}`. */
function listBackups(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter((n) => NAME.test(n)).sort().reverse().map((name) => {
    const stat = fs.statSync(path.join(dir, name));
    let checksum = null;
    try { checksum = fs.readFileSync(sidecar(path.join(dir, name)), 'utf8').split(/\s+/)[0]; } catch { /* sidecar missing */ }
    return { name, size_bytes: stat.size, created_at: stat.mtime.toISOString(), sha256: checksum };
  });
}

function prune(dir, keep) {
  for (const old of listBackups(dir).slice(keep)) {
    fs.rmSync(path.join(dir, old.name), { force: true });
    fs.rmSync(sidecar(path.join(dir, old.name)), { force: true });
  }
}

/**
 * @param {{db: import('node:sqlite').DatabaseSync, dir: string, keep?: number, now?: function(): Date}} input
 * @returns {Promise<{name: string, file: string, size_bytes: number, sha256: string}>}
 */
async function createBackup({ db, dir, keep = 7, now = () => new Date() }) {
  fs.mkdirSync(dir, { recursive: true });
  const name = backupName(now());
  const file = path.join(dir, name);
  const partial = `${file}.partial`;
  try {
    await backup(db, partial);
    const integrity = finalizeCopy(partial);
    if (integrity !== 'ok') throw new Error(`La copia no pasó la verificación de integridad: ${integrity}`);
    fs.renameSync(partial, file);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  const hash = sha256(file);
  fs.writeFileSync(sidecar(file), `${hash}  ${name}\n`);
  prune(dir, keep);
  return { name, file, size_bytes: fs.statSync(file).size, sha256: hash };
}

/** Checks integrity and, when a sidecar exists, the checksum. @returns {{ok: boolean, problems: string[], warnings: string[]}} */
function verifyBackup(file) {
  const problems = [];
  const warnings = [];
  if (!fs.existsSync(file)) return { ok: false, problems: ['El archivo de respaldo no existe.'], warnings };
  try {
    const integrity = integrityOf(file);
    if (integrity !== 'ok') problems.push(`Falló la verificación de integridad: ${integrity}`);
  } catch (error) { problems.push(`El archivo no es una base SQLite válida: ${error.message}`); }
  if (fs.existsSync(sidecar(file))) {
    const expected = fs.readFileSync(sidecar(file), 'utf8').split(/\s+/)[0];
    if (expected !== sha256(file)) problems.push('La suma de verificación SHA-256 no coincide: el archivo cambió o está dañado.');
  } else warnings.push('No hay archivo .sha256 junto al respaldo; solo se verificó la integridad.');
  return { ok: problems.length === 0, problems, warnings };
}

/**
 * Replaces `target` with the backup `file`.
 * @returns {{target: string, previous: string|null, warnings: string[]}} `previous` is where the replaced database was kept.
 */
function restoreBackup({ file, target, force = false }) {
  const check = verifyBackup(file);
  if (!check.ok) throw new Error(check.problems.join(' '));
  const exists = fs.existsSync(target);
  if (exists && !force) throw new Error(`Ya existe una base en ${target}. Use --force para reemplazarla (se guardará como .before-restore).`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const previous = exists ? `${target}.before-restore` : null;
  if (exists) fs.copyFileSync(target, previous);
  // Stale WAL/SHM files of the replaced database must not be replayed over the restored one.
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
  fs.copyFileSync(file, target);
  return { target, previous, warnings: check.warnings };
}

module.exports = { createBackup, listBackups, verifyBackup, restoreBackup, backupName, NAME };
