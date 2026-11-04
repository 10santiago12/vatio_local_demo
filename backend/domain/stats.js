'use strict';
/**
 * Small descriptive-statistics helpers shared by the baseline, alert and savings rules.
 *
 * Conventions: empty input never throws (mean of nothing is 0); the standard deviation is the
 * SAMPLE deviation (n - 1) because baselines work with few days, which keeps the +-2 sigma band
 * conservative; with fewer than two values it is 0.
 * Requirements covered: RF-02 (baseline band), RF-14 (attribution band), calculation tolerances.
 */

/**
 * Sum of numbers.
 * @param {number[]} values
 * @returns {number}
 */
function sum(values) {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * Arithmetic mean (0 for an empty list).
 * @param {number[]} values
 * @returns {number}
 */
function mean(values) {
  return values.length ? sum(values) / values.length : 0;
}

/**
 * Sample standard deviation (0 when there are fewer than two values).
 * @param {number[]} values
 * @returns {number}
 */
function stdDev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  let squares = 0;
  for (const v of values) squares += (v - m) ** 2;
  return Math.sqrt(squares / (values.length - 1));
}

/**
 * Percentile with linear interpolation (p in [0, 100]); 0 for an empty list.
 * @param {number[]} values
 * @param {number} p
 * @returns {number}
 */
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/**
 * Round to a number of decimals.
 * @param {number} value
 * @param {number} [digits]
 * @returns {number}
 */
function round(value, digits = 2) {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
}

/**
 * Clamp a number into [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Whether `actual` is within a relative tolerance of `expected` (e.g. 0.02 = +-2 %).
 * When expected is 0 the actual must be 0 as well (within 1e-12).
 * @param {number} actual
 * @param {number} expected
 * @param {number} tolerance Relative tolerance (fraction).
 * @returns {boolean}
 */
function withinTolerance(actual, expected, tolerance) {
  if (expected === 0) return Math.abs(actual) <= 1e-12;
  return Math.abs(actual - expected) / Math.abs(expected) <= tolerance;
}

module.exports = { sum, mean, stdDev, percentile, round, clamp, withinTolerance };
