const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { openDatabase } = require('../backend/db/connection');
const { createBackup, listBackups, verifyBackup, restoreBackup } = require('../backend/ops/backup');
const { createBackups } = require('../backend/app/backups');
const { buildConfig } = require('../backend/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-bk-'));
function seeded(file, rows) {
  const db = openDatabase(file);
  db.exec('CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT)');
  for (const v of rows) db.prepare('INSERT INTO t(v) VALUES(?)').run(v);
  return db;
}
const values = (file) => { const db = openDatabase(file); try { return db.prepare('SELECT v FROM t ORDER BY id').all().map((r) => r.v); } finally { db.close(); } };

test('backup then restore returns exactly the backed-up data after the database is damaged', async () => {
  const dir = tmp();
  const dbFile = path.join(dir, 'live.sqlite');
  const db = seeded(dbFile, ['a', 'b', 'c']);
  const made = await createBackup({ db, dir: path.join(dir, 'bk') });
  assert.match(made.name, /^vatio-\d{8}-\d{9}\.sqlite$/);
  assert.equal(made.sha256.length, 64);
  assert.ok(verifyBackup(made.file).ok);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'bk')).sort(), [made.name, `${made.name}.sha256`]); // no -wal/-shm/.partial leftovers
  db.prepare('DELETE FROM t').run();
  db.prepare("INSERT INTO t(v) VALUES('after')").run();
  db.close();
  fs.writeFileSync(dbFile, 'destroyed'); // worst case: the file itself is garbage
  assert.throws(() => restoreBackup({ file: made.file, target: dbFile }), /--force/);
  const result = restoreBackup({ file: made.file, target: dbFile, force: true });
  assert.equal(fs.readFileSync(result.previous, 'utf8'), 'destroyed');
  assert.deepEqual(values(dbFile), ['a', 'b', 'c']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restore refuses a tampered or corrupt backup', async () => {
  const dir = tmp();
  const db = seeded(path.join(dir, 'live.sqlite'), ['x']);
  const made = await createBackup({ db, dir });
  db.close();
  const target = path.join(dir, 'target.sqlite');
  fs.writeFileSync(`${made.file}.sha256`, `${'0'.repeat(64)}  ${made.name}\n`);
  assert.throws(() => restoreBackup({ file: made.file, target }), /SHA-256/);
  fs.writeFileSync(made.file, 'not a database');
  assert.equal(verifyBackup(made.file).ok, false);
  assert.ok(!fs.existsSync(target));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('retention keeps only the newest copies and removes their checksum files', async () => {
  const dir = tmp();
  const db = seeded(path.join(dir, 'live.sqlite'), ['x']);
  let t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 4; i += 1) await createBackup({ db, dir: path.join(dir, 'bk'), keep: 2, now: () => new Date(t += 1000) });
  db.close();
  const left = listBackups(path.join(dir, 'bk'));
  assert.equal(left.length, 2);
  assert.deepEqual(left.map((b) => b.name), [...left.map((b) => b.name)].sort().reverse());
  assert.equal(fs.readdirSync(path.join(dir, 'bk')).filter((n) => n.endsWith('.sha256')).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the backup service tracks success and failure events and serves only known names', async () => {
  const dir = tmp();
  const db = seeded(path.join(dir, 'live.sqlite'), ['x']);
  const events = [];
  const errors = [];
  const config = buildConfig({ VATIO_BACKUP_DIR: path.join(dir, 'bk') });
  const svc = createBackups({ db, config, track: (n) => events.push(n), logError: (s, e) => errors.push(s), wallNow: () => Date.UTC(2026, 0, 1) });
  const made = await svc.run({ trigger: 'manual' });
  assert.ok(svc.fileOf(made.name).endsWith(made.name));
  assert.throws(() => svc.fileOf('../../etc/passwd'), /No existe/);
  fs.rmSync(path.join(dir, 'bk'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'bk'), 'a file where the directory should be');
  await assert.rejects(svc.run());
  assert.deepEqual(events, ['backup_created', 'backup_failed']);
  assert.deepEqual(errors, ['backup']);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config: backup defaults (off locally, every 6 h in production) and validation', () => {
  assert.equal(buildConfig({}).backupIntervalHours, 0);
  assert.equal(buildConfig({ APP_ENV: 'production', VATIO_ADMIN_PASSWORD: 'a-very-long-unique-password', VATIO_DEVICE_KEY: 'device-key-unique-0123456789' }).backupIntervalHours, 6);
  assert.equal(buildConfig({}).backupKeep, 7);
  assert.throws(() => buildConfig({ VATIO_BACKUP_KEEP: '0' }), /VATIO_BACKUP_KEEP/);
  assert.throws(() => buildConfig({ VATIO_BACKUP_INTERVAL_HOURS: 'x' }), /VATIO_BACKUP_INTERVAL_HOURS/);
});

test('scripts/backup.js and scripts/restore.js work end to end on temp files', () => {
  const dir = tmp();
  const dbFile = path.join(dir, 'vatio.sqlite');
  seeded(dbFile, ['one', 'two']).close();
  const env = { ...process.env, VATIO_ENV_FILE: path.join(dir, 'none.env'), VATIO_DB: dbFile, VATIO_BACKUP_DIR: path.join(dir, 'bk') };
  const root = path.join(__dirname, '..');
  const b = spawnSync(process.execPath, [path.join(root, 'scripts', 'backup.js')], { env, encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr);
  const [{ name }] = listBackups(path.join(dir, 'bk'));
  const file = path.join(dir, 'bk', name);
  const noForce = spawnSync(process.execPath, [path.join(root, 'scripts', 'restore.js'), file], { env, encoding: 'utf8' });
  assert.equal(noForce.status, 1);
  assert.match(noForce.stderr, /--force/);
  seeded(dbFile, ['three']).close();
  const ok = spawnSync(process.execPath, [path.join(root, 'scripts', 'restore.js'), file, '--force'], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(values(dbFile), ['one', 'two']);
  assert.ok(fs.existsSync(`${dbFile}.before-restore`));
  fs.rmSync(dir, { recursive: true, force: true });
});
