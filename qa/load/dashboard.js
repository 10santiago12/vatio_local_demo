'use strict';
// RNF-02: 20 instrumented loads + 24 h of history; dashboard endpoints and real page render. Criterion: < 5 s.
const { chromium } = require('@playwright/test');
const { startServer, login } = require('../lib/server');

const TARGET_LOADS = 20;
const SAMPLES = 30;
const BROWSER_RUNS = 10;
const CRITERION_MS = 5000;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { p50: +pct(s, 50).toFixed(1), p95: +pct(s, 95).toFixed(1), max: +s.at(-1).toFixed(1) }; };

async function main() {
  const server = await startServer({ port: 31902, seed: true });
  try {
    const { cookie, csrf } = await login(server.baseUrl, server.adminPassword);
    const headers = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
    const get = (p) => fetch(`${server.baseUrl}${p}`, { headers });
    const current = (await (await get('/api/loads')).json()).loads.length;
    const extra = Math.max(0, TARGET_LOADS - current);
    if (extra) {
      const g = await fetch(`${server.baseUrl}/api/demo/generate-loads`, { method: 'POST', headers, body: JSON.stringify({ count: extra }) });
      if (!g.ok) throw new Error(`generate-loads ${g.status}`);
    }
    const loads = (await (await get('/api/loads')).json()).loads;
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 3600 * 1000);
    const history = await (await get(`/api/data/readings?load=${loads[0].code}&from=${from.toISOString()}&to=${to.toISOString()}&granularity=raw&limit=5000`)).json();
    const endpoints = {
      'GET /api/loads': '/api/loads',
      'GET /api/simple': '/api/simple',
      'GET /api/loads/:load (serie en vivo)': `/api/loads/${loads[0].code}`,
      'GET /api/data/readings (24 h, un equipo, hasta 5000 filas)': `/api/data/readings?load=${loads[0].code}&from=${from.toISOString()}&to=${to.toISOString()}&granularity=raw&limit=5000`,
      'GET /api/telemetry/latest': '/api/telemetry/latest',
    };
    const api = {};
    for (const [name, path] of Object.entries(endpoints)) {
      const times = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const t0 = performance.now();
        const r = await get(path); await r.arrayBuffer();
        if (!r.ok) throw new Error(`${name} -> ${r.status}`);
        times.push(performance.now() - t0);
      }
      api[name] = stats(times);
    }

    const browser = await chromium.launch();
    const renders = [];
    for (let i = 0; i < BROWSER_RUNS; i += 1) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addCookies(cookie.split('; ').map((c) => { const [name, ...v] = c.split('='); return { name, value: v.join('='), url: server.baseUrl }; }));
      const page = await context.newPage();
      const t0 = performance.now();
      await page.goto(`${server.baseUrl}/?view=Inicio`);
      await page.waitForSelector('.rank-row');
      renders.push(performance.now() - t0);
      await context.close();
    }
    await browser.close();

    const out = {
      instrumentedLoads: loads.length, hoursOfHistory: 24, rawRowsReturnedFor24h: history.count, apiSamplesPerEndpoint: SAMPLES, api,
      pageRenderMs: stats(renders), browserRuns: BROWSER_RUNS, criterionMs: CRITERION_MS,
    };
    const worstApi = Math.max(...Object.values(api).map((s) => s.max));
    out.pass = loads.length >= TARGET_LOADS && worstApi < CRITERION_MS && out.pageRenderMs.max < CRITERION_MS;
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = out.pass ? 0 : 1;
  } finally { server.stop(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
