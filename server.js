const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DEVICE_KEY = process.env.VATIO_DEVICE_KEY || "vatio-demo-2026";

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const LOG_FILE = path.join(DATA_DIR, "telemetry.jsonl");
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY = 2500;

fs.mkdirSync(DATA_DIR, { recursive: true });

const latestByModule = new Map();
const history = [];
let gatewayState = {
  gateway_id: null,
  site_id: "la-espiga-chia",
  last_received_at: null
};

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
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Device-Key",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
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
  relative = decodeURIComponent(relative);
  const resolved = path.normalize(path.join(PUBLIC_DIR, relative));

  if (!resolved.startsWith(PUBLIC_DIR)) {
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

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeReading(raw, receivedAt) {
  const power = Math.max(0, safeNumber(raw.power_w));
  const voltage = Math.max(0, safeNumber(raw.voltage_v, 120));
  const current = Math.max(0, safeNumber(raw.current_a, voltage ? power / voltage : 0));

  return {
    module_id: String(raw.module_id || raw.moduleId || "UNKNOWN").slice(0, 64),
    load_id: String(raw.load_id || raw.loadId || "unknown").slice(0, 64),
    load_name: String(raw.load_name || raw.loadName || raw.load_id || "Carga").slice(0, 120),
    manufacturer: String(raw.manufacturer || "ESP32 virtual").slice(0, 80),
    voltage_v: Number(voltage.toFixed(2)),
    current_a: Number(current.toFixed(3)),
    power_w: Number(power.toFixed(1)),
    energy_kwh: Number(Math.max(0, safeNumber(raw.energy_kwh)).toFixed(6)),
    status: String(raw.status || "active").slice(0, 32),
    timestamp: raw.timestamp ? String(raw.timestamp).slice(0, 64) : receivedAt,
    received_at: receivedAt
  };
}

function ingest(payload) {
  const receivedAt = new Date().toISOString();
  const readings = Array.isArray(payload.readings) ? payload.readings : [];
  if (!readings.length) {
    throw new Error("El payload debe contener readings[] con al menos una lectura.");
  }
  if (readings.length > 100) {
    throw new Error("Máximo 100 lecturas por lote.");
  }

  const normalized = readings.map((reading) => normalizeReading(reading, receivedAt));
  gatewayState = {
    gateway_id: String(payload.gateway_id || "ESP32").slice(0, 80),
    site_id: String(payload.site_id || "la-espiga-chia").slice(0, 80),
    last_received_at: receivedAt
  };

  for (const reading of normalized) {
    latestByModule.set(reading.module_id, reading);
    history.push({ gateway_id: gatewayState.gateway_id, site_id: gatewayState.site_id, ...reading });
  }
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  const logLine = JSON.stringify({
    gateway_id: gatewayState.gateway_id,
    site_id: gatewayState.site_id,
    received_at: receivedAt,
    readings: normalized
  }) + "\n";
  fs.appendFile(LOG_FILE, logLine, () => {});

  return { receivedAt, normalized };
}

function simulatorReadings() {
  const t = Date.now() / 1000;
  const cycle = (period, duty = 0.5, phase = 0) => ((t + phase) % period) / period < duty;
  const hour = new Date().getHours();

  const defs = [
    ["MX-001","freezer","Congelador vertical","EnerSense", cycle(44,0.60) ? 412 : 18],
    ["MX-002","fridge","Nevera exhibidora","VoltioLab", cycle(37,0.55,9) ? 395 : 16],
    ["MX-003","pos","Computador / POS","EnerSense", hour >= 6 && hour < 20 ? 121 : 8],
    ["MX-004","oven","Horno eléctrico","VoltioLab", ((hour >= 5 && hour < 10) || (hour >= 15 && hour < 17)) && cycle(28,0.70) ? 5900 : 90],
    ["MX-005","coffee","Cafetera industrial","EnerSense", hour >= 6 && hour < 20 ? (cycle(21,0.38) ? 1930 : 150) : 150],
    ["MX-006","ac","Aire acondicionado","VoltioLab", hour >= 12 && hour <= 20 ? (cycle(31,0.68,5) ? 1180 : 80) : 0],
    ["MX-007","sign","Letrero luminoso","EnerSense", hour >= 17 || hour < 2 ? 249 : 0],
    ["MX-008","tv","Televisor","VoltioLab", hour >= 8 && hour < 19 ? 108 : 3]
  ];

  return defs.map((d, i) => {
    const voltage = 120 + Math.sin(t / 17 + i) * 1.2;
    const power = Math.max(0, d[4] * (0.97 + 0.03 * Math.sin(t / 11 + i * 0.6)));
    return {
      module_id: d[0],
      load_id: d[1],
      load_name: d[2],
      manufacturer: d[3],
      voltage_v: Number(voltage.toFixed(2)),
      current_a: Number((voltage ? power / voltage : 0).toFixed(3)),
      power_w: Number(power.toFixed(1)),
      energy_kwh: Number((i * 3.7 + (t % 3600) / 3600 * power / 1000).toFixed(6)),
      status: "active",
      timestamp: new Date().toISOString(),
      received_at: new Date().toISOString()
    };
  });
}

function latestPayload() {
  const now = Date.now();
  const hasReal = latestByModule.size > 0;
  const readings = hasReal ? [...latestByModule.values()] : simulatorReadings();

  const withFreshness = readings.map((reading) => {
    const ageSec = Math.max(0, Math.round((now - new Date(reading.received_at || reading.timestamp).getTime()) / 1000));
    return {
      ...reading,
      age_seconds: ageSec,
      effective_status: ageSec > 120 ? "inactive" : reading.status
    };
  });

  return {
    source: hasReal ? "esp32" : "simulator",
    gateway: hasReal ? gatewayState : {
      gateway_id: "SIMULATOR",
      site_id: "la-espiga-chia",
      last_received_at: new Date().toISOString()
    },
    server_time: new Date().toISOString(),
    readings: withFreshness
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

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Device-Key",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });
    res.end();
    return;
  }

  if (pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      service: "Vatio Local",
      source: latestByModule.size ? "esp32" : "simulator",
      local_ips: localIPv4Addresses(),
      port: PORT,
      server_time: new Date().toISOString()
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
      device_key: DEVICE_KEY
    });
    return;
  }

  if (pathname === "/api/telemetry/latest" && req.method === "GET") {
    sendJson(res, 200, latestPayload());
    return;
  }

  if (pathname === "/api/telemetry/history" && req.method === "GET") {
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || 250)));
    sendJson(res, 200, {
      count: Math.min(limit, history.length),
      readings: history.slice(-limit)
    });
    return;
  }

  if (pathname === "/api/telemetry" && req.method === "POST") {
    if (req.headers["x-device-key"] !== DEVICE_KEY) {
      sendJson(res, 401, { ok: false, error: "X-Device-Key inválida." });
      return;
    }

    try {
      const rawBody = await readBody(req);
      const payload = JSON.parse(rawBody || "{}");
      const result = ingest(payload);
      sendJson(res, 200, {
        ok: true,
        received: result.normalized.length,
        received_at: result.receivedAt
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (pathname === "/api/reset" && req.method === "POST") {
    latestByModule.clear();
    history.splice(0, history.length);
    gatewayState = { gateway_id: null, site_id: "la-espiga-chia", last_received_at: null };
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
  console.log(` X-Device-Key:          ${DEVICE_KEY}`);
  console.log("======================================================");
  console.log("");
  console.log("Si el ESP32 no puede conectarse, revisa el Firewall de Windows");
  console.log(`y permite conexiones TCP entrantes al puerto ${PORT}.`);
  console.log("");
});
