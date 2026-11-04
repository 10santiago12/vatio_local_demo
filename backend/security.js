const crypto = require('node:crypto');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const config = require('./config').getConfigOrExit();
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS telemetry (id INTEGER PRIMARY KEY, site_id TEXT NOT NULL, gateway_id TEXT NOT NULL, received_at TEXT NOT NULL, reading TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS telemetry_site_time ON telemetry(site_id, received_at);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, site_id TEXT, details TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS control_requests (id INTEGER PRIMARY KEY, site_id TEXT NOT NULL, load_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, requested_by TEXT NOT NULL, created_at TEXT NOT NULL);`);
const password = config.adminPassword;
if (!db.prepare('SELECT id FROM users WHERE username=?').get('admin') && password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  db.prepare('INSERT INTO users(username,salt,hash,role) VALUES(?,?,?,?)').run('admin', salt, hash, 'Administrador');
}
const sessions = new Map();
const attempts = new Map();
function audit(actor,event,site,details) { db.prepare('INSERT INTO audit(at,actor,event,site_id,details) VALUES(?,?,?,?,?)').run(new Date().toISOString(),actor,event,site || null,JSON.stringify(details)); }
function login(username, password, ip) {
  const now=Date.now();
  let a=attempts.get(ip);
  if (!a || now-a.since>60000) { a={since:now,count:0}; attempts.set(ip,a); }
  if (++a.count>10) return {limited:true};
  const user=db.prepare('SELECT * FROM users WHERE username=?').get(typeof username==='string' ? username : '');
  const salt=user?.salt || '00000000000000000000000000000000';
  const candidate=crypto.scryptSync(typeof password==='string' && password.length<=256 ? password : '',salt,64);
  const actual=user ? Buffer.from(user.hash,'hex') : Buffer.alloc(64);
  if (!user || !crypto.timingSafeEqual(candidate,actual)) { audit('anonymous','login_failed',null,{}); return null; }
  attempts.delete(ip);
  const id=crypto.randomBytes(32).toString('hex');
  const csrf=crypto.randomBytes(32).toString('hex');
  const session={username:user.username,role:user.role,csrf,expires:now+8*3600000};
  sessions.set(id,session); audit(user.username,'login',null,{});
  return {id,...session};
}
function session(req) {
  const id=(req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith('vatio_session='))?.slice(14);
  const s=sessions.get(id);
  if (!s || s.expires<Date.now()) { if(id) sessions.delete(id); return null; }
  return s;
}
function saveReadings(site,gateway,time,readings) {
  const stmt=db.prepare('INSERT INTO telemetry(site_id,gateway_id,received_at,reading) VALUES(?,?,?,?)');
  db.exec('BEGIN');
  try { for(const r of readings) stmt.run(site,gateway,time,JSON.stringify(r)); db.exec('COMMIT'); }
  catch(e) { db.exec('ROLLBACK'); throw e; }
}
module.exports={db,login,session,audit,saveReadings};
