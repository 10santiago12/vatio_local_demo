const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SystemClock, SimulatedClock, ALLOWED_SPEEDS } = require('../../backend/adapters/clock');

/** Controllable "real time" so the tests never sleep. */
function fakeReal(start = 1_000_000) {
  const real = { t: start, now: () => real.t, tick(ms) { real.t += ms; } };
  return real;
}
const START = Date.parse('2026-03-11T12:00:00.000Z');

test('SystemClock returns the real time as epoch milliseconds', () => {
  const clock = new SystemClock();
  const before = Date.now();
  const value = clock.now();
  assert.ok(value >= before && value <= Date.now());
  assert.match(clock.nowIso(), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(clock.state().mode, 'system');
});

test('SimulatedClock runs at 1x, 60x and 3600x', () => {
  for (const speed of ALLOWED_SPEEDS) {
    const real = fakeReal();
    const clock = new SimulatedClock({ startMs: START, speed, realNow: real.now });
    real.tick(2000);
    assert.equal(clock.now(), START + 2000 * speed, `speed ${speed}`);
  }
});

test('changing speed re-anchors: time never jumps', () => {
  const real = fakeReal();
  const clock = new SimulatedClock({ startMs: START, realNow: real.now });
  real.tick(1000);
  clock.setSpeed(60);
  assert.equal(clock.now(), START + 1000);
  real.tick(1000);
  assert.equal(clock.now(), START + 1000 + 60_000);
});

test('pause freezes time and resume continues from the same instant', () => {
  const real = fakeReal();
  const clock = new SimulatedClock({ startMs: START, speed: 60, realNow: real.now });
  real.tick(1000);
  clock.pause();
  const frozen = clock.now();
  real.tick(5000);
  assert.equal(clock.now(), frozen);
  assert.equal(clock.state().paused, true);
  clock.resume();
  real.tick(1000);
  assert.equal(clock.now(), frozen + 60_000);
});

test('advance 1 hour, 1 day and 7 days (also while paused)', () => {
  const real = fakeReal();
  const clock = new SimulatedClock({ startMs: START, paused: true, realNow: real.now });
  clock.advanceHours(1);
  assert.equal(clock.now(), START + 3600_000);
  clock.advanceDays(1);
  assert.equal(clock.now(), START + 3600_000 + 86_400_000);
  clock.advanceDays(7);
  assert.equal(clock.now(), START + 3600_000 + 8 * 86_400_000);
  assert.equal(clock.nowIso(), '2026-03-19T13:00:00.000Z');
});

test('invalid input is rejected', () => {
  assert.throws(() => new SimulatedClock({ startMs: 'nope' }), TypeError);
  const clock = new SimulatedClock({ startMs: START, realNow: fakeReal().now });
  assert.throws(() => clock.setSpeed(5), RangeError);
  assert.throws(() => clock.advance(-1), RangeError);
  assert.throws(() => clock.advance(Number.NaN), RangeError);
});

test('accepts ISO and Date start values', () => {
  const real = fakeReal();
  assert.equal(new SimulatedClock({ startMs: '2026-03-11T12:00:00.000Z', realNow: real.now }).now(), START);
  assert.equal(new SimulatedClock({ startMs: new Date(START), realNow: real.now }).now(), START);
});
