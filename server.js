require("./backend/runtime-guard").assertNodeVersion();
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { URL } = require("url");

const config = require("./backend/config").getConfigOrExit();
const { SystemClock } = require("./backend/adapters/clock");
const { MAIN_SITE_ID } = require("./backend/adapters/simulator/profiles");
const { createIngestion, envelopeFromPayload, IngestionError } = require("./backend/app/ingestion");
const { ensureMainSite } = require("./backend/app/site-setup");
const { loadDemoScenario } = require("./backend/app/demo-data");
const PORT = config.port;
const HOST = config.host;
const DEVICE_KEY = config.deviceKey;

const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_SITE = MAIN_SITE_ID;

const security = require('./backend/security');

// Ports and use cases (hexagonal layout): the clock is injected everywhere; real devices and the
// simulator feed the same ingestion use case.
const clock = new SystemClock();
ensureMainSite({ repos: security.repos, clock });
const ingestion = createIngestion({ repos: security.repos, clock, options: { autoRegister: !config.isProduction } });
const scenario = loadDemoScenario({ repos: security.repos, clock });

// Readings from a real device older than this instant are hidden after POST /api/reset.
let ignoreDeviceBefore = "";
let gatewayState = { gateway_id: null, site_id: DEFAULT_SITE, last_received_at: null };
{
  const last = security.repos.readings.latestBySite(DEFAULT_SITE, { source: "esp32" }).map((r) => r.ts).sort().pop();
  if (last) gatewayState = { gateway_id: "ESP32", site_id: DEFAULT_SITE, last_received_at: last };
}

// Housekeeping: modules silent for more than 2 minutes become inactive; raw readings older than
// 2 days are folded into hourly aggregates.
function runSafely(task, name) {
  try { task(); } catch (error) {
    try { security.repos.errors.log({ at: new Date(clock.now()).toISOString(), source: name, message: error.message, stack: error.stack }); } catch { /* the error log itself failed */ }
    console.error(`${name}: ${error.message}`);
  }
}
setInterval(() => runSafely(() => ingestion.refreshModuleStatuses(), "module-status"), 30 * 1000).unref();
setInterval(() => runSafely(() => ingestion.compact(), "readings-compaction"), 60 * 60 * 1000).unref();

function localIPv4Addresses() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === "IPv4" && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return [...new Set(ips)];
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function mimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "application/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    default: return "application/octet-stream";
  }
}

function serveStatic(req, res, pathname) {
  let relative = pathname === "/" ? "/index.html" : pathname;
  try { relative = decodeURIComponent(relative); } catch { return sendText(res, 400, 'Bad request'); }
  const resolved = path.normalize(path.join(PUBLIC_DIR, relative));

  const withinPublic = path.relative(PUBLIC_DIR, resolved);
  if (withinPublic.startsWith('..') || path.isAbsolute(withinPublic)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackErr, fallback) => {
        if (fallbackErr) {
          sendText(res, 404, "Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fallback);
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeType(resolved),
      "Cache-Control": "no-cache"
    });
    res.end(data);
  });
}

/** Legacy API shape of a stored reading row (what the UI and the ESP32 docs describe). */
function legacyReading(row, nowMs) {
  const ageSec = Math.max(0, Math.round((nowMs - Date.parse(row.ts)) / 1000));
  const status = row.module_status || "active";
  return {
    module_id: row.module_id,
    load_id: row.load_code,
    load_name: row.load_name,
    manufacturer: row.manufacturer || "ESP32 virtual",
    voltage_v: row.voltage_v,
    current_a: row.current_a,
    power_w: row.power_w,
    energy_kwh: row.energy_kwh,
    status,
    timestamp: row.ts,
    received_at: row.ts,
    age_seconds: ageSec,
    effective_status: ageSec > 120 ? "inactive" : status
  };
}

/** Live readings of the simulator (no database writes): what every simulated load draws right now. */
function simulatorReadings(nowMs) {
  const stored = new Map(security.repos.readings.latestBySite(DEFAULT_SITE).map((r) => [r.load_code, r]));
  return scenario.engine.profiles().map((profile) => {
    const sample = scenario.engine.sample(profile.code, nowMs);
    const iso = new Date(nowMs).toISOString();
    return {
      module_id: profile.moduleId,
      load_id: profile.code,
      load_name: profile.name,
      manufacturer: profile.manufacturer,
      voltage_v: sample.voltageV,
      current_a: sample.currentA,
      power_w: sample.powerW,
      energy_kwh: stored.get(profile.code)?.energy_kwh ?? 0,
      status: "active",
      timestamp: iso,
      received_at: iso,
      age_seconds: 0,
      effective_status: "active"
    };
  });
}

function deviceRows() {
  return security.repos.readings.latestBySite(DEFAULT_SITE, { source: "esp32", since: ignoreDeviceBefore });
}

function latestPayload() {
  const nowMs = clock.now();
  const rows = deviceRows();
  const hasReal = rows.length > 0;
  return {
    source: hasReal ? "esp32" : "simulator",
    gateway: hasReal ? gatewayState : {
      gateway_id: "SIMULATOR",
      site_id: DEFAULT_SITE,
      last_received_at: new Date(nowMs).toISOString()
    },
    server_time: new Date(nowMs).toISOString(),
    readings: hasReal ? rows.map((row) => legacyReading(row, nowMs)) : simulatorReadings(nowMs)
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error("Payload demasiado grande."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req));
      const result = security.login(payload.username, payload.password, req.socket.remoteAddress);
      if (!result) return sendJson(res, 401, {error:'Credenciales inválidas.'});
      if (result.limited) return sendJson(res, 429, {error:'Demasiados intentos.'});
      res.setHeader('Set-Cookie', `vatio_session=${result.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${config.secureCookie(req) ? '; Secure' : ''}`);
      return sendJson(res, 200, {username:result.username, role:result.role, csrf:result.csrf});
    } catch { return sendJson(res,400,{error:'Solicitud inválida.'}); }
  }

  if (pathname.startsWith('/api/') && !['/api/health','/api/telemetry'].includes(pathname)) {
    const user = security.session(req);
    if (!user) return sendJson(res, 401, {error:'Autenticación requerida.'});
    if (!['GET','HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== user.csrf) return sendJson(res,403,{error:'CSRF inválido.'});
    if (pathname === '/api/auth/me' && req.method === 'GET') return sendJson(res,200,{username:user.username,role:user.role,csrf:user.csrf});
    if (pathname === '/api/control/requests' && req.method === 'POST') {
      try {
        const request=JSON.parse(await readBody(req));
        if (request.site_id !== 'la-espiga-chia') return sendJson(res,403,{error:'Sede no autorizada.'});
        if (request.action !== 'off' || !['freezer','fridge','pos','oven','coffee','ac','sign','tv'].includes(request.load_id)) return sendJson(res,400,{error:'Solicitud inválida.'});
        if (['freezer','fridge','pos'].includes(request.load_id)) {
          security.audit(user.username,'control_rejected',request.site_id,{load_id:request.load_id,reason:'critical'});
          return sendJson(res,422,{error:'Carga crítica: acción rechazada.'});
        }
        if (gatewayState.last_received_at && Date.now() - Date.parse(gatewayState.last_received_at) > 120000) {
          security.audit(user.username,'control_rejected',request.site_id,{load_id:request.load_id,reason:'communication_lost'});
          return sendJson(res,422,{error:'Pérdida de comunicación con el gateway.'});
        }
        const result=security.db.prepare('INSERT INTO control_requests(site_id,load_id,action,status,requested_by,created_at) VALUES(?,?,?,?,?,?)').run(request.site_id,request.load_id,request.action,'pending',user.username,new Date().toISOString());
        security.audit(user.username,'control_requested',request.site_id,{load_id:request.load_id});
        return sendJson(res,201,{id:Number(result.lastInsertRowid),status:'pending',simulated:true});
      } catch { return sendJson(res,400,{error:'Solicitud inválida.'}); }
    }
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      service: "Vatio Local",
      source: deviceRows().length ? "esp32" : "simulator",
      local_ips: localIPv4Addresses(),
      port: PORT,
      server_time: new Date(clock.now()).toISOString()
    });
    return;
  }

  if (pathname === "/api/info" && req.method === "GET") {
    const ips = localIPv4Addresses();
    sendJson(res, 200, {
      port: PORT,
      local_ips: ips,
      browser_urls: ips.map(ip => `http://${ip}:${PORT}/`),
      telemetry_urls: ips.map(ip => `http://${ip}:${PORT}/api/telemetry`),
      device_key_configured: Boolean(DEVICE_KEY)
    });
    return;
  }

  if (pathname === "/api/telemetry/latest" && req.method === "GET") {
    sendJson(res, 200, latestPayload());
    return;
  }

  if (pathname === "/api/telemetry/history" && req.method === "GET") {
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || 250)));
    const nowMs = clock.now();
    const readings = security.repos.readings.recentBySite(DEFAULT_SITE, { source: "esp32", since: ignoreDeviceBefore, limit })
      .reverse()
      .map((row) => ({ site_id: DEFAULT_SITE, gateway_id: gatewayState.gateway_id, ...legacyReading(row, nowMs) }));
    sendJson(res, 200, { count: readings.length, readings });
    return;
  }

  if (pathname === "/api/telemetry" && req.method === "POST") {
    if (!DEVICE_KEY || req.headers["x-device-key"] !== DEVICE_KEY) {
      sendJson(res, 401, { ok: false, error: "X-Device-Key inválida." });
      return;
    }

    try {
      const rawBody = await readBody(req);
      const payload = JSON.parse(rawBody || "{}");
      const result = ingestion.ingest(envelopeFromPayload(payload));
      if (result.accepted + result.duplicates === 0) {
        sendJson(res, 400, { ok: false, error: result.rejected[0]?.message || "Lectura inválida.", rejected: result.rejected });
        return;
      }
      if (result.accepted > 0) gatewayState = { gateway_id: String(payload.gateway_id || "ESP32").slice(0, 80), site_id: payload.site_id, last_received_at: result.receivedAt };
      sendJson(res, 200, {
        ok: true,
        received: result.received,
        accepted: result.accepted,
        duplicates: result.duplicates,
        rejected: result.rejected,
        sync: result.sync,
        received_at: result.receivedAt
      });
    } catch (error) {
      if (error instanceof IngestionError || error instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: error instanceof SyntaxError ? "JSON inválido." : error.message });
      } else {
        security.repos.errors.log({ at: new Date(clock.now()).toISOString(), source: "telemetry", message: error.message, stack: error.stack });
        sendJson(res, 500, { ok: false, error: "Error interno al guardar las lecturas." });
      }
    }
    return;
  }

  if (pathname === "/api/reset" && req.method === "POST") {
    ignoreDeviceBefore = new Date(clock.now()).toISOString();
    gatewayState = { gateway_id: null, site_id: DEFAULT_SITE, last_received_at: null };
    sendJson(res, 200, { ok: true, source: "simulator" });
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  const ips = localIPv4Addresses();
  console.log("");
  console.log("======================================================");
  console.log(" Vatio Local está ejecutándose");
  console.log("======================================================");
  console.log(` Navegador en este PC: http://localhost:${PORT}`);
  for (const ip of ips) {
    console.log(` Red local:             http://${ip}:${PORT}`);
    console.log(` ESP32 POST:            http://${ip}:${PORT}/api/telemetry`);
  }
  console.log(` Perfil: ${config.appEnv} | Host: ${HOST}`);
  console.log(` Clave de dispositivo configurada: ${Boolean(DEVICE_KEY)}`);
  console.log("======================================================");
  console.log("");
  console.log("Si el ESP32 no puede conectarse, revisa el Firewall de Windows");
  console.log(`y permite conexiones TCP entrantes al puerto ${PORT}.`);
  console.log("");
});
