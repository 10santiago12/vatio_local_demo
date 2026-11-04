'use strict';
/**
 * Simulation engine: what every load draws at any instant.
 *
 * `sample(loadCode, ts)` is a pure function of (seed, load, minute, active modifiers): it never keeps
 * a running state, so history generation, live ticks and re-generation after a demo control always
 * agree. Voltage is about 120 V with +-2 % noise, current is I = P / V, power carries +-2 % noise.
 *
 * Modifiers are the demo controls applied on top of the natural behaviour:
 *  - anomaly:       steady consumption `pct` % above the expected mean for that hour, in a time range;
 *  - deterioration: power grows by `factor` over `rampMs` and then stays there (aging equipment);
 *  - force_on:      the load is forced to at least `powerW` in a time range (sign left on tonight).
 */

const { localParts, parseHm, addDays, localDayStartMs, MS_PER_MINUTE } = require('../../domain/time');
const { createRng } = require('./prng');
const { MAIN_SCHEDULE, MAIN_PROFILES } = require('./profiles');

const NOMINAL_VOLTAGE = 120;
const NOISE = 0.02;

function createModifiers() {
  const list = [];
  let nextId = 1;
  return {
    /** @returns {number} id of the new modifier */
    add(modifier) { const id = nextId; nextId += 1; list.push({ ...modifier, id }); return id; },
    remove(id) { const i = list.findIndex((m) => m.id === id); if (i >= 0) list.splice(i, 1); return i >= 0; },
    clear() { list.length = 0; },
    list: () => list.map((m) => ({ ...m })),
    forLoad: (code) => list.filter((m) => m.loadCode === code),
  };
}

/**
 * @param {{seed?: (number|string), schedule?: Array, offsetMinutes?: number, profiles?: Array, behavior?: object,
 *   scale?: number, trend?: ({startMs: number, endMs: number, pct: number}|null), modifiers?: object}} [options]
 *   `scale` multiplies every load (site size), `trend` applies a linear change over a period (multisite history).
 */
function createEngine(options = {}) {
  const rng = createRng(options.seed ?? 20260311);
  const schedule = options.schedule || MAIN_SCHEDULE;
  const offset = options.offsetMinutes ?? -300;
  const behavior = options.behavior || {};
  const scale = options.scale ?? 1;
  const trend = options.trend || null;
  const modifiers = options.modifiers || createModifiers();
  const profiles = new Map((options.profiles || MAIN_PROFILES).map((p) => [p.code, { ...p, id: rng.id(p.code) }]));
  const days = new Map(); // code -> date -> {plan, prev}
  const dateOf = new Map(); // date -> previous date (string arithmetic is the slow part)

  const entries = new Map(schedule.map((e) => [e.weekday, e]));
  const hours = (weekday) => {
    const e = entries.get(weekday);
    return e && !e.closed ? { opensMin: parseHm(e.opensAt), closesMin: parseHm(e.closesAt) } : { opensMin: 0, closesMin: 0 };
  };

  function profileOf(code) {
    const p = profiles.get(code);
    if (!p) throw new RangeError(`Unknown simulated load: ${code}`);
    return p;
  }

  function dayInfo(profile, date) {
    let perLoad = days.get(profile.code);
    if (!perLoad) { perLoad = new Map(); days.set(profile.code, perLoad); }
    let info = perLoad.get(date);
    if (!info) {
      let previous = dateOf.get(date);
      if (!previous) { previous = addDays(date, -1); dateOf.set(date, previous); }
      const build = (d) => profile.plan(rng, { code: profile.code, date: d, startMs: localDayStartMs(d, offset) }, behavior);
      info = { plan: build(date), prev: build(previous) };
      perLoad.set(date, info);
    }
    return info;
  }

  function modify(code, ts, w, mean) {
    let power = w;
    let expected = mean;
    for (const m of modifiers.forLoad(code)) {
      if (ts < m.startMs || (m.endMs !== undefined && ts >= m.endMs)) continue;
      if (m.kind === 'force_on') power = Math.max(power, m.powerW);
      else if (m.kind === 'deterioration') {
        const factor = 1 + m.factor * Math.min(1, (ts - m.startMs) / (m.rampMs || 1));
        power *= factor;
        expected *= factor;
      }
    }
    for (const m of modifiers.forLoad(code)) {
      if (m.kind === 'anomaly' && ts >= m.startMs && ts < m.endMs) power = Math.max(1, expected) * (1 + m.pct / 100);
    }
    return power;
  }

  /**
   * @param {string} loadCode
   * @param {number} ts Epoch ms (rounded down to the minute).
   * @returns {{ts: number, powerW: number, voltageV: number, currentA: number}}
   */
  function sample(loadCode, ts) {
    const profile = profileOf(loadCode);
    const abs = Math.floor(ts / MS_PER_MINUTE);
    const lp = localParts(abs * MS_PER_MINUTE, offset);
    const minute = lp.hour * 60 + lp.minute;
    const { opensMin, closesMin } = hours(lp.weekday);
    const ctx = { minute, abs, weekday: lp.weekday, open: minute >= opensMin && minute < closesMin, opensMin, closesMin };
    const info = dayInfo(profile, lp.date);
    const draw = profile.at(info.plan, info.prev, profile, ctx);
    const tsMs = abs * MS_PER_MINUTE;
    let w = modify(loadCode, tsMs, draw.w * scale, draw.mean * scale);
    if (trend) w *= 1 + (trend.pct / 100) * Math.min(1, Math.max(0, (tsMs - trend.startMs) / (trend.endMs - trend.startMs)));
    const power = Math.max(0, w * (1 + NOISE * rng.signed(profile.id, abs, 0)));
    const voltage = NOMINAL_VOLTAGE * (1 + NOISE * rng.signed(profile.id, abs, 1));
    return {
      ts: tsMs,
      powerW: Math.round(power * 10) / 10,
      voltageV: Math.round(voltage * 100) / 100,
      currentA: Math.round((power / voltage) * 1000) / 1000,
    };
  }

  return {
    seed: rng.seed,
    offsetMinutes: offset,
    schedule,
    modifiers,
    behavior,
    rng,
    sample,
    profileOf,
    profiles: () => [...profiles.values()],
    addProfile(profile) { profiles.set(profile.code, { ...profile, id: rng.id(profile.code) }); },
  };
}

module.exports = { createEngine, createModifiers, NOMINAL_VOLTAGE };
