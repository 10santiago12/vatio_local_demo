'use strict';
/**
 * Versioned SQL migrations without dependencies.
 *
 * Files live in `backend/db/migrations/NNN_name.sql` and are applied in numeric order, each
 * inside its own transaction, and recorded in `schema_migrations` with a SHA-256 checksum.
 * Running again is a no-op. If an already-applied file was edited (or removed), the runner
 * refuses to continue: schema changes must always be a new migration.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DIR = path.join(__dirname, 'migrations');
const FILE_PATTERN = /^(\d{3,})_([a-z0-9_]+)\.sql$/;

class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** Line endings are normalized so a Windows checkout (CRLF) matches the committed (LF) checksum. */
function checksum(sql) {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

function listMigrationFiles(dir) {
  const seen = new Map();
  for (const file of fs.readdirSync(dir)) {
    const match = FILE_PATTERN.exec(file);
    if (!match) continue;
    const version = Number(match[1]);
    if (seen.has(version)) throw new MigrationError(`Duplicate migration version ${version}: ${seen.get(version).file} and ${file}`);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8').replace(/^﻿/, '');
    seen.set(version, { version, name: match[2], file, sql, checksum: checksum(sql) });
  }
  return [...seen.values()].sort((a, b) => a.version - b.version);
}

/**
 * Applies pending migrations. Returns `{ applied: string[], version: number }`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ dir?: string, now?: () => Date }} [options]
 */
function migrate(db, options = {}) {
  const dir = options.dir || DEFAULT_DIR;
  const now = options.now || (() => new Date());
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const files = listMigrationFiles(dir);
  const byVersion = new Map(files.map((m) => [m.version, m]));
  const applied = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();

  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (!file) throw new MigrationError(`Applied migration ${row.version}_${row.name} is missing from ${dir}.`);
    if (file.checksum !== row.checksum) {
      throw new MigrationError(`Applied migration ${file.file} was modified after being applied. Create a new migration instead of editing it.`);
    }
  }
  const lastApplied = applied.length ? applied[applied.length - 1].version : 0;
  const appliedVersions = new Set(applied.map((r) => r.version));
  const pending = files.filter((m) => !appliedVersions.has(m.version));
  const outOfOrder = pending.find((m) => m.version < lastApplied);
  if (outOfOrder) throw new MigrationError(`Migration ${outOfOrder.file} is older than the latest applied version ${lastApplied}.`);

  const record = db.prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES(?,?,?,?)');
  const done = [];
  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) throw new Error(`foreign key violations after migration: ${JSON.stringify(violations.slice(0, 3))}`);
      record.run(migration.version, migration.name, migration.checksum, now().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw new MigrationError(`Migration ${migration.file} failed and was rolled back: ${error.message}`);
    }
    done.push(`${String(migration.version).padStart(3, '0')}_${migration.name}`);
  }
  return { applied: done, version: done.length ? pending[pending.length - 1].version : lastApplied };
}

module.exports = { migrate, checksum, listMigrationFiles, MigrationError, DEFAULT_DIR };
