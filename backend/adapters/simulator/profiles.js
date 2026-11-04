'use strict';
/**
 * Load catalogue and behaviour profiles of the simulated bakery (spec: "DATOS DE DEMOSTRACIÓN").
 *
 * A profile answers one question for a load at a minute of the day: what is its instantaneous power
 * (`w`, including the compressor/thermostat cycle) and what is its expected mean power for that slot
 * (`mean`, used to scale injected anomalies). Profiles are pure functions of a daily `plan` (flags
 * drawn once per local day from the seeded PRNG) and a minute context.
 *
 * Cycles are deliberately shorter than the 15-minute alert window, so a normally cycling load never
 * looks like a sustained deviation, while an injected anomaly (steady excess) does.
 *
 * Natural waste patterns baked into the history (all detectable by the domain rules):
 *  - the sign stays on all night on some days;
 *  - the air conditioner stays on after closing on some days;
 *  - the coffee machine keeps its 150 W standby every night until the owner accepts the standby
 *    recommendation (see `behavior.coffeeStandbyEndsMs`);
 *  - the hot display sometimes stays on at night.
 */

const MAIN_SITE_ID = 'la-espiga-chia';

/** Operating hours of the main site: Mon-Sat 06:00-20:00, Sunday 07:00-13:00 (weekday 0 = Sunday). */
const MAIN_SCHEDULE = Object.freeze([
  { weekday: 0, closed: false, opensAt: '07:00', closesAt: '13:00' },
  ...[1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, closed: false, opensAt: '06:00', closesAt: '20:00' })),
]);

/** The two simulated manufacturers (different payload formats, see backend/adapters/manufacturers). */
const MANUFACTURERS = Object.freeze({ ENERSENSE: 'EnerSense', VOLTIOLAB: 'VoltioLab' });

const cycleOn = (abs, period, onMin, phase) => ((abs + phase) % period) < onMin;
const hoursBetween = (minute, fromHour, toHour) => minute >= fromHour * 60 && minute < toHour * 60;

/**
 * @typedef {{w: number, mean: number}} Draw Instant and expected mean power in watts.
 * @typedef {{minute: number, abs: number, weekday: number, open: boolean, opensMin: number, closesMin: number}} MinuteContext
 * @typedef {{code: string, name: string, icon: string, moduleId: (string|null), manufacturer: string, typicalPowerW: number,
 *   criticality: string, controlMode: string, installedDaysAgo?: number, phase: number,
 *   plan: function(object, {code: string, date: string, startMs: number}, object): object,
 *   at: function(object, object, object, MinuteContext): Draw}} Profile
 */

/** @type {Profile[]} */
const MAIN_PROFILES = [
  {
    code: 'freezer', name: 'Congelador vertical', icon: 'snowflake', moduleId: 'MX-001', manufacturer: MANUFACTURERS.ENERSENSE,
    typicalPowerW: 350, criticality: 'critical', controlMode: 'monitor_only', phase: 3,
    plan: () => ({}),
    at: (plan, prev, p, c) => {
      const onMin = c.open ? 11 : 9;
      return { w: cycleOn(c.abs, 20, onMin, p.phase) ? 350 : 8, mean: (onMin * 350 + (20 - onMin) * 8) / 20 };
    },
  },
  {
    code: 'fridge', name: 'Nevera exhibidora', icon: 'snowflake', moduleId: 'MX-002', manufacturer: MANUFACTURERS.VOLTIOLAB,
    typicalPowerW: 400, criticality: 'critical', controlMode: 'monitor_only', phase: 7,
    plan: () => ({}),
    at: (plan, prev, p, c) => {
      const onMin = c.open ? 12 : 10;
      return { w: cycleOn(c.abs, 24, onMin, p.phase) ? 400 : 10, mean: (onMin * 400 + (24 - onMin) * 10) / 24 };
    },
  },
  {
    code: 'pos', name: 'Computador / POS', icon: 'cpu', moduleId: 'MX-003', manufacturer: MANUFACTURERS.ENERSENSE,
    typicalPowerW: 120, criticality: 'critical', controlMode: 'monitor_only', phase: 0,
    plan: () => ({}),
    at: (plan, prev, p, c) => { const w = c.open ? 120 : 8; return { w, mean: w }; },
  },
  {
    code: 'oven', name: 'Horno eléctrico', icon: 'zap', moduleId: 'MX-004', manufacturer: MANUFACTURERS.VOLTIOLAB,
    typicalPowerW: 6000, criticality: 'essential', controlMode: 'monitor_only', phase: 2,
    plan: () => ({}),
    at: (plan, prev, p, c) => {
      // Peaks 05:00-10:00 and 15:00-17:00 (Sunday: only the morning, from opening).
      const closedDay = c.closesMin === 0; // the site does not open today (e.g. Zipaquirá on Sunday)
      const peak = closedDay ? false : c.weekday === 0 ? hoursBetween(c.minute, 6, 10) : hoursBetween(c.minute, 5, 10) || hoursBetween(c.minute, 15, 17);
      if (!peak) return { w: 1, mean: 1 };
      return { w: cycleOn(c.abs, 12, 8, p.phase) ? 6000 : 600, mean: (8 * 6000 + 4 * 600) / 12 };
    },
  },
  {
    code: 'mixer', name: 'Amasadora', icon: 'plug', moduleId: 'MX-010', manufacturer: MANUFACTURERS.ENERSENSE,
    typicalPowerW: 1500, criticality: 'essential', controlMode: 'monitor_only', phase: 0,
    plan: (rng, day) => ({ shift: rng.int(`${day.code}|${day.date}|shift`, 0, 10) }),
    at: (plan, prev, p, c) => {
      const active = c.weekday === 0 ? hoursBetween(c.minute, 7, 9) : hoursBetween(c.minute, 5, 9);
      if (!active) return { w: 0.5, mean: 0.5 };
      const inBlock = (c.minute % 30) - plan.shift;
      return { w: inBlock >= 0 && inBlock < 10 ? 1500 : 0.5, mean: 500 };
    },
  },
  {
    code: 'coffee', name: 'Cafetera industrial', icon: 'plug', moduleId: 'MX-005', manufacturer: MANUFACTURERS.ENERSENSE,
    typicalPowerW: 2000, criticality: 'essential', controlMode: 'control_enabled', phase: 5,
    plan: (rng, day, behavior) => ({ standby: day.startMs < (behavior.coffeeStandbyEndsMs ?? Infinity) }),
    at: (plan, prev, p, c) => {
      if (c.open) return { w: cycleOn(c.abs, 21, 8, p.phase) ? 2000 : 150, mean: (8 * 2000 + 13 * 150) / 21 };
      const w = plan.standby ? 150 : 0;
      return { w, mean: w };
    },
  },
  {
    code: 'warmer', name: 'Vitrina caliente', icon: 'sun', moduleId: 'MX-009', manufacturer: MANUFACTURERS.VOLTIOLAB,
    typicalPowerW: 800, criticality: 'non_essential', controlMode: 'control_enabled', phase: 4,
    plan: (rng, day) => ({ leftOn: rng.chance(`${day.code}|${day.date}|left_on`, 0.2) }),
    at: (plan, prev, p, c) => {
      if (c.open) return { w: cycleOn(c.abs, 16, 9, p.phase) ? 800 : 20, mean: (9 * 800 + 7 * 20) / 16 };
      if (plan.leftOn) return { w: cycleOn(c.abs, 16, 6, p.phase) ? 800 : 20, mean: (6 * 800 + 10 * 20) / 16 };
      return { w: 0, mean: 0 };
    },
  },
  {
    code: 'ac', name: 'Aire acondicionado', icon: 'sun', moduleId: 'MX-006', manufacturer: MANUFACTURERS.VOLTIOLAB,
    typicalPowerW: 1200, criticality: 'non_essential', controlMode: 'control_enabled', phase: 6,
    plan: (rng, day) => ({
      afterClose: rng.chance(`${day.code}|${day.date}|after_close`, 0.2),
      extraMinutes: rng.int(`${day.code}|${day.date}|extra`, 60, 240),
    }),
    at: (plan, prev, p, c) => {
      const from = c.weekday === 0 ? 11 * 60 : 12 * 60;
      const until = c.closesMin + (plan.afterClose ? plan.extraMinutes : 0);
      if (c.minute < from || c.minute >= until) return { w: 0, mean: 0 };
      return { w: cycleOn(c.abs, 22, 13, p.phase) ? 1200 : 80, mean: (13 * 1200 + 9 * 80) / 22 };
    },
  },
  {
    code: 'sign', name: 'Letrero luminoso', icon: 'lightbulb', moduleId: 'MX-007', manufacturer: MANUFACTURERS.ENERSENSE,
    typicalPowerW: 250, criticality: 'non_essential', controlMode: 'control_enabled', phase: 0,
    plan: (rng, day, behavior) => ({
      allNight: rng.chance(`${day.code}|${day.date}|all_night`, day.startMs < (behavior.signFixAtMs ?? Infinity) ? 0.25 : 0.12),
    }),
    at: (plan, prev, p, c) => {
      // Normal evening: 17:00-20:00 on workdays. "All night": from 17:00 until 06:00 of the next day.
      const eveningOn = c.minute >= 17 * 60 && (plan.allNight || (c.weekday !== 0 && c.minute < 20 * 60));
      const morningOn = c.minute < 6 * 60 && prev.allNight === true;
      const w = eveningOn || morningOn ? 250 : 0;
      return { w, mean: w };
    },
  },
  {
    code: 'tv', name: 'Televisor', icon: 'lightbulb', moduleId: 'MX-008', manufacturer: MANUFACTURERS.VOLTIOLAB,
    typicalPowerW: 110, criticality: 'non_essential', controlMode: 'control_enabled', phase: 0,
    plan: () => ({}),
    at: (plan, prev, p, c) => { const w = c.open ? 110 : 3; return { w, mean: w }; },
  },
  {
    // Installed 3 days before "now": only 3 days of data, so its baseline stays "building".
    code: 'whisk', name: 'Batidora nueva', icon: 'plug', moduleId: 'MX-011', manufacturer: MANUFACTURERS.ENERSENSE,
    typicalPowerW: 700, criticality: 'essential', controlMode: 'monitor_only', installedDaysAgo: 3, phase: 0,
    plan: () => ({}),
    at: (plan, prev, p, c) => {
      if (!(c.open && c.minute < 18 * 60)) return { w: 0.5, mean: 0.5 };
      return { w: c.minute % 60 >= 10 && c.minute % 60 < 20 ? 700 : 0.5, mean: (10 * 700 + 50 * 0.5) / 60 };
    },
  },
];

/**
 * Additional sites for the multisite comparison: simulated aggregated history only (hourly rows).
 * `trendPct` is the linear change in consumption over the 45 days (negative = improving).
 */
const EXTRA_SITES = Object.freeze([
  {
    id: 'la-espiga-cajica', name: 'La Espiga – Cajicá', city: 'Cajicá', scale: 0.92, trendPct: -12,
    schedule: MAIN_SCHEDULE, loadCodes: ['freezer', 'fridge', 'pos', 'oven', 'ac', 'sign'],
  },
  {
    id: 'la-espiga-zipaquira', name: 'La Espiga – Zipaquirá', city: 'Zipaquirá', scale: 1.08, trendPct: 3,
    // Opens Monday to Saturday 07:00-19:00 and is closed on Sunday: a different number of operating days.
    schedule: Object.freeze([
      { weekday: 0, closed: true },
      ...[1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, closed: false, opensAt: '07:00', closesAt: '19:00' })),
    ]),
    loadCodes: ['freezer', 'fridge', 'pos', 'oven', 'ac', 'sign'],
  },
]);

module.exports = { MAIN_SITE_ID, MAIN_SCHEDULE, MAIN_PROFILES, EXTRA_SITES, MANUFACTURERS };
