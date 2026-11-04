const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vatio-test-'));
const port = 31876;
const base = `http://127.0.0.1:${port}`;
let child;
async function call(url, options = {}) {
  const response = await fetch(base + url, options);
  return { response, body: await response.json() };
}
before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: {...process.env, PORT: String(port), HOST: '127.0.0.1', APP_ENV: 'local', VATIO_ENV_FILE: path.join(temp, 'absent.env'), VATIO_DB: path.join(temp, 'test.sqlite'), VATIO_ADMIN_PASSWORD: 'test-only-strong-password', VATIO_DEVICE_KEY: 'test-device-secret'} });
  for (let n = 0; n < 100; n++) {
    try { await fetch(base + '/api/health'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('Server failed to start');
});
after(async () => { if (child && child.exitCode === null) { const closed = new Promise(r => child.once('exit', r)); child.kill(); await closed; } fs.rmSync(temp, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); });

test('secret is not exposed and sensitive endpoints require authentication', async () => {
  const info = await call('/api/info');
  assert.equal(JSON.stringify(info.body).includes('test-device-secret'), false);
  assert.equal((await call('/api/reset', {method: 'POST'})).response.status, 401);
  assert.equal((await call('/api/telemetry/latest')).response.status, 401);
});

test('device key and input are checked', async () => {
  const opts = {method:'POST', headers:{'content-type':'application/json','x-device-key':'wrong'}, body:JSON.stringify({readings:[]})};
  assert.equal((await call('/api/telemetry', opts)).response.status, 401);
  opts.headers['x-device-key'] = 'test-device-secret';
  assert.equal((await call('/api/telemetry', opts)).response.status, 400);
});

test('login, CSRF, and critical load policy enforced on server', async () => {
  const login = await call('/api/auth/login', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'test-only-strong-password'})});
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie').split(';')[0];
  const info = await call('/api/info',{headers:{cookie}});
  assert.equal(JSON.stringify(info.body).includes('test-device-secret'),false);
  const options = {method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({site_id:'la-espiga-chia',load_id:'freezer',action:'off'})};
  assert.equal((await call('/api/control/requests',options)).response.status, 403);
  options.headers['x-csrf-token'] = login.body.csrf;
  assert.equal((await call('/api/control/requests',options)).response.status, 422);
});

test('wrong password is rejected', async () => {
  const result=await call('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'wrong'})});
  assert.equal(result.response.status,401);
});

test('telemetry is restored after server restart', async () => {
  const payload={gateway_id:'ESP32-DEMO-01',site_id:'la-espiga-chia',readings:[{module_id:'MX-001',load_id:'freezer',power_w:412}]};
  const ingest=await call('/api/telemetry',{method:'POST',headers:{'content-type':'application/json','x-device-key':'test-device-secret'},body:JSON.stringify(payload)});
  assert.equal(ingest.response.status,200);
  const closed = new Promise(r => child.once('exit',r)); child.kill(); await closed;
  child = spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',APP_ENV:'local',VATIO_ENV_FILE:path.join(temp,'absent.env'),VATIO_DB:path.join(temp,'test.sqlite'),VATIO_ADMIN_PASSWORD:'test-only-strong-password',VATIO_DEVICE_KEY:'test-device-secret'}});
  for (let n=0;n<100;n++) { try { await fetch(base+'/api/health'); break; } catch { await new Promise(r=>setTimeout(r,100)); } }
  const login=await call('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'test-only-strong-password'})});
  const cookie=login.response.headers.get('set-cookie').split(';')[0];
  const latest=await call('/api/telemetry/latest',{headers:{cookie}});
  assert.equal(latest.body.readings[0].power_w,412);
});
