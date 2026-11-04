'use strict';
/**
 * Request observability: one JSON line per request and in-memory metrics (status classes, latency percentiles).
 *
 * A log line carries only: time, request id, method, path (no query string), status, latency and role.
 * Bodies, headers, cookies, tokens, keys and passwords are never logged.
 */
const LATENCY_SAMPLES = 1000;

function createMetrics({ now = Date.now } = {}) {
  const startedAt = now();
  const byClass = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  const samples = [];
  let total = 0;
  const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0);
  return {
    record(status, ms) {
      total += 1;
      const key = status >= 200 && status < 600 ? `${Math.floor(status / 100)}xx` : 'other';
      byClass[key in byClass ? key : 'other'] += 1;
      samples.push(ms);
      if (samples.length > LATENCY_SAMPLES) samples.shift();
    },
    snapshot() {
      const sorted = [...samples].sort((a, b) => a - b);
      return {
        uptime_s: Math.round((now() - startedAt) / 1000),
        requests: { total, by_status_class: { ...byClass } },
        latency_ms: { samples: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95) },
      };
    },
  };
}

/** The exact JSON line written for a finished request. */
function requestLine({ at, requestId, method, path, status, ms, role }) {
  return JSON.stringify({ at, level: 'info', type: 'request', request_id: requestId, method, path: String(path).slice(0, 200), status, ms, role: role || null });
}

module.exports = { createMetrics, requestLine };
