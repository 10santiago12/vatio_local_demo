'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/** Opens a SQLite database with the pragmas Vatio relies on (foreign keys, WAL for files). */
function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

/** Runs `fn` atomically. Uses a savepoint so calls can nest inside another transaction. */
function transaction(db, fn) {
  db.exec('SAVEPOINT vatio_tx');
  try {
    const result = fn();
    db.exec('RELEASE vatio_tx');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO vatio_tx; RELEASE vatio_tx');
    throw error;
  }
}

module.exports = { openDatabase, transaction };
