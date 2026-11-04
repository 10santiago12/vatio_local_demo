'use strict';
/**
 * Clock port and its two adapters.
 *
 * Everything outside `backend/adapters` receives a clock and calls `clock.now()` (epoch milliseconds);
 * nothing else in the application reads the real time. This is the only place that may touch
 * `Date.now()`, which keeps simulated time (demo, tests) and real time interchangeable.
 *
 *  - SystemClock: the real time.
 *  - SimulatedClock: advances live at 1x, 60x (1 s = 1 min) or 3600x (1 s = 1 h), can be paused and
 *    resumed, and can jump forward 1 hour, 1 day or 7 days (demo panel, spec "Tiempo simulado").
 */

const MS_PER_HOUR = 3600 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
/** Speeds offered by the demo panel. */
const ALLOWED_SPEEDS = Object.freeze([1, 60, 3600]);

class SystemClock {
  /** @returns {number} Epoch milliseconds. */
  now() { return Date.now(); }

  nowIso() { return new Date(this.now()).toISOString(); }

  state() { return { mode: 'system', nowIso: this.nowIso(), speed: 1, paused: false }; }
}

class SimulatedClock {
  /**
   * @param {{startMs: (number|string|Date), speed?: number, paused?: boolean, realNow?: () => number}} options
   *   `realNow` is the real time source (injectable so tests can drive it).
   */
  constructor(options) {
    const start = options.startMs instanceof Date ? options.startMs.getTime() : typeof options.startMs === 'string' ? Date.parse(options.startMs) : options.startMs;
    if (!Number.isFinite(start)) throw new TypeError('SimulatedClock requires a valid startMs');
    this.realNow = options.realNow || (() => Date.now());
    this.speedValue = 1;
    this.pausedValue = Boolean(options.paused);
    this.simAnchor = start;
    this.realAnchor = this.realNow();
    if (options.speed !== undefined) this.setSpeed(options.speed);
  }

  /** @returns {number} Simulated epoch milliseconds. */
  now() {
    if (this.pausedValue) return this.simAnchor;
    return this.simAnchor + (this.realNow() - this.realAnchor) * this.speedValue;
  }

  nowIso() { return new Date(Math.floor(this.now())).toISOString(); }

  /** Re-anchors so that changing speed or pausing never makes time jump. */
  anchor() {
    this.simAnchor = this.now();
    this.realAnchor = this.realNow();
  }

  /** @param {number} speed 1, 60 or 3600. */
  setSpeed(speed) {
    if (!ALLOWED_SPEEDS.includes(speed)) throw new RangeError(`Speed must be one of ${ALLOWED_SPEEDS.join(', ')}`);
    this.anchor();
    this.speedValue = speed;
  }

  pause() { this.anchor(); this.pausedValue = true; }

  resume() { this.anchor(); this.pausedValue = false; }

  /** Jumps forward (works while paused). @param {number} ms */
  advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance() needs a non-negative number of milliseconds');
    this.anchor();
    this.simAnchor += ms;
  }

  advanceHours(hours = 1) { this.advance(hours * MS_PER_HOUR); }

  advanceDays(days = 1) { this.advance(days * MS_PER_DAY); }

  get speed() { return this.speedValue; }

  get paused() { return this.pausedValue; }

  state() { return { mode: 'simulated', nowIso: this.nowIso(), speed: this.speedValue, paused: this.pausedValue }; }
}

module.exports = { SystemClock, SimulatedClock, ALLOWED_SPEEDS, MS_PER_HOUR, MS_PER_DAY };
