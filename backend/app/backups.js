'use strict';
/**
 * Backup use cases on top of backend/ops/backup.js: run now (manual or scheduled), list, resolve a file
 * for download, one backup at startup when none exists and the in-server schedule. Runs are serialized
 * and every outcome is tracked as an event (`backup_created` / `backup_failed`).
 */
const path = require('node:path');
const { createBackup, listBackups, NAME } = require('../ops/backup');
const { notFound } = require('../http/http-error');

function createBackups({ db, config, track, logError, wallNow }) {
  let queue = Promise.resolve();
  let timer = null;

  /** @returns {Promise<{name: string, size_bytes: number, sha256: string}>} rejects when the backup fails. */
  function run({ user = null, trigger = 'manual' } = {}) {
    const job = queue.then(async () => {
      try {
        const result = await createBackup({ db, dir: config.backupDir, keep: config.backupKeep, now: () => new Date(wallNow()) });
        track('backup_created', { user, properties: { name: result.name, size_bytes: result.size_bytes, trigger } });
        return { name: result.name, size_bytes: result.size_bytes, sha256: result.sha256 };
      } catch (error) {
        logError('backup', error, { trigger });
        track('backup_failed', { user, properties: { trigger } });
        throw error;
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  /** Absolute path of a stored backup; the name is validated so it can never point outside the directory. */
  function fileOf(name) {
    if (!NAME.test(name) || !listBackups(config.backupDir).some((b) => b.name === name)) throw notFound('No existe ese respaldo.', 'backup_not_found');
    return path.join(config.backupDir, name);
  }

  /** One backup at startup if none exists, then one every `backupIntervalHours` (0 = no schedule). */
  function start() {
    if (listBackups(config.backupDir).length === 0 && config.backupIntervalHours > 0) run({ trigger: 'startup' }).catch(() => {});
    if (config.backupIntervalHours > 0) {
      timer = setInterval(() => run({ trigger: 'scheduled' }).catch(() => {}), config.backupIntervalHours * 3600000);
      timer.unref();
    }
  }

  return { run, list: () => listBackups(config.backupDir), fileOf, start, stop: () => { if (timer) clearInterval(timer); }, whenIdle: () => queue };
}

module.exports = { createBackups };
