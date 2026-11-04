'use strict';
// RNF-01: 50 simulated modules post readings at the same time (ESP32 format). Criterion: < 3 s.
const { startServer, login } = require('../lib/server');

const MODULES = 50;
const ROUNDS = 20;
const CRITERION_MS = 3000;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

async function main() {
  const server = await startServer({ port: 31901, seed: false });
  try {
    const session = await login(server.baseUrl, server.adminPassword);
    const latencies = [];
    const roundMs = [];
    let accepted = 0;
    let failures = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const roundStart = performance.now();
      const results = await Promise.all(Array.from({ length: MODULES }, async (_, m) => {
        const id = String(m + 1).padStart(3, '0');
        const body = {
          gateway_id: `QA-GW-${id}`, site_id: 'la-espiga-chia',
          readings: [{
            module_id: `QA-${id}`, load_id: `qa-load-${id}`, load_name: `Carga QA ${id}`, manufacturer: 'EnerSense',
            voltage_v: 120.1, current_a: 3.4, power_w: 300 + m + round, energy_kwh: 0.1 + round * 0.01, status: 'active',
            timestamp: new Date().toISOString(),
          }],
        };
        const t0 = performance.now();
        const res = await fetch(`${server.baseUrl}/api/telemetry`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-device-key': server.deviceKey }, body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        latencies.push(performance.now() - t0);
        return { ok: res.ok, accepted: json.accepted || 0 };
      }));
      roundMs.push(performance.now() - roundStart);
      for (const r of results) { if (r.ok) accepted += r.accepted; else failures += 1; }
    }
    // Persistence check through the API: every module must have one reading per round (raw export by load).
    const res = await fetch(`${server.baseUrl}/api/data/export?format=json&limit=500000`, { headers: { cookie: session.cookie } });
    const exported = await res.json();
    const rows = Array.isArray(exported) ? exported : (exported.rows || exported.readings || []);
    const qaRows = rows.filter((r) => String(r.module_id || '').startsWith('QA-')).length;
    latencies.sort((a, b) => a - b);
    roundMs.sort((a, b) => a - b);
    const out = {
      modules: MODULES, rounds: ROUNDS, requests: MODULES * ROUNDS, accepted, failedRequests: failures, persistedRows: qaRows,
      lost: MODULES * ROUNDS - qaRows,
      latencyMs: { p50: +pct(latencies, 50).toFixed(1), p95: +pct(latencies, 95).toFixed(1), max: +latencies.at(-1).toFixed(1) },
      roundMs: { p50: +pct(roundMs, 50).toFixed(1), max: +roundMs.at(-1).toFixed(1) },
      criterionMs: CRITERION_MS,
    };
    out.pass = out.lost === 0 && failures === 0 && out.roundMs.max < CRITERION_MS && out.latencyMs.max < CRITERION_MS;
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = out.pass ? 0 : 1;
  } finally { server.stop(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
