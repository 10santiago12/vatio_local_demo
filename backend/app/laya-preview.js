'use strict';
const { computeBaseline } = require('../domain/baseline');
const { layaDecision } = require('../domain/laya');
const { MAIN_SCHEDULE } = require('../adapters/simulator/profiles');

// Fourteen example days, sampled hourly in Bogotá. The preview never writes readings or actions.
const monday = Date.parse('2026-11-16T00:00:00-05:00');
const hourMs = 3600000;
const history = Array.from({ length: 14 * 24 }, (_, i) => {
  const hour = i % 24;
  return { ts: monday + (i - 14 * 24) * hourMs,
    powerW: (hour >= 6 && hour < 20 ? 110 : 4) + Math.floor(i / 24) % 3 };
});
const baseline = computeBaseline(history, { asOf: monday });
module.exports = [9, 21].map(hour => {
  const decision = layaDecision(baseline, MAIN_SCHEDULE, monday + hour * hourMs);
  return { hour, action: decision?.action ?? null, expectedW: decision?.expectedW ?? null };
});
