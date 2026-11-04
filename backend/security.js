const crypto = require('node:crypto');
const { openDatabase } = require('./db/connection');
const { migrate } = require('./db/migrate');
const { createRepositories } = require('./db/repositories');

const config = require('./config').getConfigOrExit();
const db = openDatabase(config.dbPath);
migrate(db);
const repos = createRepositories(db);
const password = config.adminPassword;
if (!repos.users.getByUsername('admin') && password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  repos.users.create({ username: 'admin', salt, hash, role: 'owner', displayName: 'Administrador' });
}
const sessions = new Map();
const attempts = new Map();
function audit(actor,event,site,details) { repos.audit.append({actor,event,siteId:site || null,details}); }
function login(username, password, ip) {
  const now=Date.now();
  let a=attempts.get(ip);
  if (!a || now-a.since>60000) { a={since:now,count:0}; attempts.set(ip,a); }
  if (++a.count>10) return {limited:true};
  const user=repos.users.getByUsername(typeof username==='string' ? username : '');
  const salt=user?.salt || '00000000000000000000000000000000';
  const candidate=crypto.scryptSync(typeof password==='string' && password.length<=256 ? password : '',salt,64);
  const actual=user ? Buffer.from(user.hash,'hex') : Buffer.alloc(64);
  if (!user || !user.active || !crypto.timingSafeEqual(candidate,actual)) { audit('anonymous','login_failed',null,{}); return null; }
  attempts.delete(ip);
  const id=crypto.randomBytes(32).toString('hex');
  const csrf=crypto.randomBytes(32).toString('hex');
  // `role` is the Spanish display name the current UI shows; `roleCode` is the stable identifier.
  const session={username:user.username,role:repos.roles.get(user.role).name,roleCode:user.role,csrf,expires:now+8*3600000};
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
module.exports={db,repos,login,session,audit,saveReadings};
