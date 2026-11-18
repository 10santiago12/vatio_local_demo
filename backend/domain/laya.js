'use strict';
/** Learn high and low demand from recent hourly history and suggest a simulated action for the current operating slot. */
const { baselineSlot } = require('./baseline');
const { isOperatingHours, localParts, localDateKey, addDays } = require('./time');

// Fit two 1-D k-means centroids to this load's observed hourly demand profile.
function layaDecision(baseline, schedule, now) {
  const slot = baselineSlot(baseline, now);
  if (!slot || slot.sampleDays < 2) return null;
  const offset = baseline.offsetMinutes;
  if (baseline.windowEnd !== addDays(localDateKey(now, offset), -1)) return null;
  if (!schedule.some(s => s.weekday === localParts(now, offset).weekday)) return null;
  const watts = Object.values(baseline.hourly).flat()
    .filter(s => s.sampleDays >= 2 && Number.isFinite(s.meanW))
    .map(s => s.meanW);
  if (watts.length < 6) return null;
  let low = Math.min(...watts), high = Math.max(...watts);
  for (let i = 0; i < 48 && high > low; i++) {
    const midpoint = (low + high) / 2;
    const lower = watts.filter(w => w <= midpoint);
    const upper = watts.filter(w => w > midpoint);
    if (lower.length < 2 || upper.length < 2) return null;
    const mean = values => values.reduce((sum, w) => sum + w, 0) / values.length;
    const nextLow = mean(lower), nextHigh = mean(upper);
    if (nextLow === low && nextHigh === high) break;
    low = nextLow;
    high = nextHigh;
  }
  const spread = high - low;
  if (spread < Math.max(5, high * 0.25)) return null;
  const open = isOperatingHours(schedule, now, offset);
  let action;
  if (open && slot.meanW - slot.stdW >= low + 0.65 * spread) action = 'on';
  else if (!open && slot.meanW + slot.stdW <= low + 0.35 * spread) action = 'off';
  else return null;
  return { action, model: 'Laya k-means', lowW: low, highW: high, expectedW: slot.meanW, sampleDays: slot.sampleDays };
}

module.exports = { layaDecision };
