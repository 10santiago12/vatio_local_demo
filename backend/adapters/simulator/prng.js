'use strict';
/**
 * Seeded pseudo-random numbers for the simulator (spec: "generador pseudoaleatorio con semilla fija").
 *
 * Two flavours, both fully determined by the seed:
 *  - Stateless hashing (`unit`, `chance`, `noise`): the value depends only on (seed, key), never on the
 *    order of calls. A reading for minute N of load X is the same whether it is generated in a 45-day
 *    batch, live, or re-generated later, which is what makes history, live ticks and tests agree.
 *  - A sequential generator (`sequence`) for the rare places that need a stream.
 */

/** FNV-1a over the UTF-16 code units of a string. @returns {number} uint32 */
function hashString(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Murmur3-style finalizer mixing three integers into one uint32. */
function mix32(a, b, c) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(c + 0x165667b1, 0x27d4eb2f);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Mulberry32 stream. @param {number} seed uint32 @returns {() => number} floats in [0, 1) */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number|string} seed Any number or string; the same seed always gives the same values.
 */
function createRng(seed) {
  const seedInt = typeof seed === 'number' ? seed >>> 0 : hashString(String(seed));
  return {
    seed: seedInt,
    /** Stable id of a label (load code...) to use with `noise`. */
    id: (label) => hashString(String(label)),
    /** Uniform [0, 1) from a string key. */
    unit: (key) => mix32(seedInt, hashString(String(key)), 0) / 4294967296,
    /** Uniform [0, 1) from integers: `id` from `id()`, a counter `n` and a `channel` (independent streams). */
    noise: (id, n, channel = 0) => mix32(seedInt ^ id, n | 0, channel) / 4294967296,
    /** Uniform [-1, 1) from integers. */
    signed: (id, n, channel = 0) => (mix32(seedInt ^ id, n | 0, channel) / 4294967296) * 2 - 1,
    chance: (key, probability) => mix32(seedInt, hashString(String(key)), 1) / 4294967296 < probability,
    int: (key, min, max) => min + Math.floor((mix32(seedInt, hashString(String(key)), 2) / 4294967296) * (max - min + 1)),
    sequence: (label) => mulberry32(mix32(seedInt, hashString(String(label)), 3)),
  };
}

module.exports = { createRng, hashString, mix32, mulberry32 };
