const { test } = require('node:test');
const assert = require('node:assert/strict');
const control = require('../../backend/domain/control');

const NOW = '2026-03-11T22:00:00.000Z';
const load = (over = {}) => ({ id: 1, name: 'Letrero', criticality: 'non_essential', controlMode: 'monitor_only', powerState: 'on', moduleId: 'MX-1', ...over });
const decide = (over = {}) => control.decideControlAction({ load: load(), action: 'off', origin: 'manual', approved: false, moduleState: 'healthy', now: NOW, actor: 'ana', ...over });

test('new loads default to monitor_only + essential', () => {
  assert.deepEqual(control.newLoadDefaults(), { criticality: 'essential', controlMode: 'monitor_only', powerState: 'on' });
});

test('load configuration: a critical load cannot be put under control', () => {
  assert.equal(control.validateLoadConfig({ criticality: 'critical', controlMode: 'control_enabled' }).valid, false);
  assert.equal(control.validateLoadConfig({ criticality: 'critical', controlMode: 'control_enabled' }).reason, 'critical_load_cannot_be_controlled');
  assert.equal(control.validateLoadConfig({ criticality: 'critical', controlMode: 'monitor_only' }).valid, true);
  assert.equal(control.validateLoadConfig({ criticality: 'essential', controlMode: 'control_enabled' }).valid, true);
  assert.equal(control.validateLoadConfig({ criticality: 'vital', controlMode: 'monitor_only' }).reason, 'unknown_criticality');
  assert.equal(control.validateLoadConfig({ criticality: 'essential', controlMode: 'auto' }).reason, 'unknown_control_mode');
});

test('module communication state: boundaries at 2 and 5 minutes, never seen is offline', () => {
  const state = (seconds) => control.moduleCommunicationState({ lastSeenAt: Date.parse(NOW) - seconds * 1000, now: NOW }).state;
  assert.equal(state(0), 'healthy');
  assert.equal(state(120), 'healthy');
  assert.equal(state(121), 'inactive');
  assert.equal(state(300), 'inactive');
  assert.equal(state(301), 'offline');
  assert.deepEqual(control.moduleCommunicationState({ lastSeenAt: null, now: NOW }), { state: 'offline', silentMinutes: null });
  assert.equal(control.moduleCommunicationState({ lastSeenAt: undefined, now: NOW }).state, 'offline');
  assert.equal(control.moduleCommunicationState({ lastSeenAt: Date.parse(NOW) - 4 * 60000, now: NOW, inactiveMinutes: 1, safeStateMinutes: 3 }).state, 'offline');
});

test('rule 1/4: without approval a manual action on a monitor-only load stays pending and nothing executes', () => {
  const d = decide();
  assert.equal(d.outcome, 'pending');
  assert.equal(d.reason, 'monitor_only_pending');
  assert.equal(d.nextPowerState, 'on');
  assert.equal(d.loadStaysEnergized, true);
  assert.equal(d.audit.result, null);
  assert.equal(decide({ origin: 'recommendation' }).outcome, 'pending');
});

test('processes without approval on a monitor-only load are rejected (no autonomy)', () => {
  for (const origin of ['closing_mode', 'autonomous']) {
    const d = decide({ origin });
    assert.equal(d.outcome, 'rejected', origin);
    assert.equal(d.reason, 'autonomy_not_enabled');
    assert.equal(d.audit.result, 'rejected');
    assert.equal(d.nextPowerState, 'on');
  }
});

test('an approved action on a monitor-only load never executes: it stays pending and tells the admin to enable control', () => {
  for (const origin of ['manual', 'recommendation', 'closing_mode', 'autonomous']) {
    for (const action of ['on', 'off']) {
      const d = decide({ approved: true, origin, action });
      assert.equal(d.outcome, 'pending', origin);
      assert.equal(d.reason, 'monitor_only_pending');
      assert.equal(d.nextPowerState, 'on');
      assert.equal(d.audit.result, null);
      assert.equal(d.audit.approved, true);
      assert.match(d.message, /habilite el control en Configuración/);
    }
  }
});

test('autonomous control executes without approval, on and off', () => {
  const l = load({ controlMode: 'control_enabled' });
  const off = decide({ load: l, origin: 'autonomous' });
  assert.deepEqual([off.outcome, off.reason, off.nextPowerState], ['executed', 'autonomous_control', 'off']);
  const on = decide({ load: load({ controlMode: 'control_enabled', powerState: 'off' }), action: 'on' });
  assert.deepEqual([on.outcome, on.nextPowerState, on.loadStaysEnergized], ['executed', 'on', true]);
});

test('rule 3: switching a critical load off is rejected and flagged for audit in every combination', () => {
  const origins = ['manual', 'recommendation', 'closing_mode', 'autonomous'];
  for (const controlMode of ['monitor_only', 'control_enabled']) {
    for (const origin of origins) {
      for (const approved of [true, false]) {
        for (const moduleState of ['healthy', 'inactive', 'offline', undefined]) {
          const d = decide({ load: load({ criticality: 'critical', name: 'Congelador', controlMode }), origin, approved, moduleState });
          const label = `${controlMode}/${origin}/${approved}/${moduleState}`;
          assert.equal(d.outcome, 'rejected', label);
          assert.equal(d.reason, 'critical_load_protected', label);
          assert.equal(d.audit.flagged, true, label);
          assert.equal(d.audit.event, 'critical_load_off_attempt', label);
          assert.equal(d.audit.result, 'rejected', label);
          assert.equal(d.nextPowerState, 'on', label);
          assert.equal(d.loadStaysEnergized, true, label);
          assert.match(d.message, /Congelador es un equipo crítico/);
        }
      }
    }
  }
});

test('switching a critical load ON is not blocked by the critical rule', () => {
  const l = load({ criticality: 'critical', powerState: 'off' });
  assert.equal(decide({ load: { ...l, controlMode: 'control_enabled' }, action: 'on' }).outcome, 'executed');
  assert.equal(decide({ load: l, action: 'on', approved: true }).outcome, 'pending');
});

test('rule 5 (safe state): a module silent for more than 5 minutes discards the action and keeps the load energized', () => {
  for (const controlMode of ['monitor_only', 'control_enabled']) {
    const d = decide({ load: load({ controlMode }), approved: true, moduleState: 'offline' });
    assert.equal(d.outcome, 'discarded');
    assert.equal(d.reason, 'safe_state_module_offline');
    assert.equal(d.nextPowerState, 'on');
    assert.equal(d.loadStaysEnergized, true);
    assert.equal(d.audit.result, 'discarded');
    assert.match(d.message, /se mantiene encendido/);
  }
});

test('a missing module state is treated as offline (fail safe)', () => {
  assert.equal(decide({ moduleState: undefined, approved: true }).outcome, 'discarded');
  assert.equal(decide({ moduleState: 'garbage', approved: true }).outcome, 'discarded');
  assert.equal(decide({ moduleState: { state: 'offline' }, approved: true }).outcome, 'discarded');
  assert.equal(decide({ load: load({ controlMode: 'control_enabled' }), moduleState: { state: 'healthy' } }).outcome, 'executed');
});

test('an inactive module (2-5 minutes) never executes: the action stays pending', () => {
  for (const controlMode of ['monitor_only', 'control_enabled']) {
    const d = decide({ load: load({ controlMode }), approved: true, moduleState: 'inactive' });
    assert.equal(d.outcome, 'pending');
    assert.equal(d.reason, 'module_inactive');
    assert.equal(d.nextPowerState, 'on');
  }
});

test('invalid action or origin throws; unnamed loads get a generic Spanish message', () => {
  assert.throws(() => decide({ action: 'toggle' }), TypeError);
  assert.throws(() => decide({ origin: 'telepathy' }), TypeError);
  assert.match(decide({ load: load({ name: undefined }) }).message, /^El equipo: /);
  assert.equal(decide({ load: { id: 9, criticality: 'essential', controlMode: 'monitor_only' } }).nextPowerState, 'on');
});

test('safe state discards the pending actions of silent modules only', () => {
  const pendingActions = [
    { id: 1, loadId: 10, moduleId: 'MX-1', action: 'off', origin: 'recommendation', loadName: 'Letrero' },
    { id: 2, loadId: 11, moduleId: 'MX-2', action: 'off', origin: 'manual' },
    { id: 3, loadId: 12, moduleId: 'MX-3', action: 'off', origin: 'manual' },
  ];
  const r = control.discardPendingActions({ pendingActions, moduleStates: { 'MX-1': 'offline', 'MX-2': 'healthy', 'MX-3': { state: 'inactive' } }, now: NOW });
  assert.deepEqual(r.discarded.map((d) => d.actionId), [1]);
  assert.deepEqual(r.kept.map((a) => a.id), [2, 3]);
  assert.equal(r.discarded[0].audit.result, 'discarded');
  assert.match(r.discarded[0].message, /Letrero/);
  assert.equal(control.discardPendingActions({ pendingActions: [], moduleStates: {}, now: NOW }).discarded.length, 0);
  const unknown = control.discardPendingActions({ pendingActions: [pendingActions[1]], moduleStates: {}, now: NOW });
  assert.equal(unknown.discarded.length, 1); // module without known state: fail safe, discard
  assert.match(unknown.discarded[0].message, /un equipo/);
});

const SITE = [
  { id: 1, name: 'Congelador', criticality: 'critical', controlMode: 'monitor_only', powerState: 'on', moduleId: 'MX-1' },
  { id: 2, name: 'Horno', criticality: 'essential', controlMode: 'monitor_only', powerState: 'on', moduleId: 'MX-2' },
  { id: 3, name: 'Cafetera', criticality: 'essential', controlMode: 'control_enabled', powerState: 'on', moduleId: 'MX-3' },
  { id: 4, name: 'Letrero', criticality: 'non_essential', controlMode: 'control_enabled', powerState: 'on', moduleId: 'MX-4' },
  { id: 5, name: 'Televisor', criticality: 'non_essential', controlMode: 'control_enabled', powerState: 'on', moduleId: 'MX-5' },
  { id: 6, name: 'Vitrina', criticality: 'non_essential', controlMode: 'monitor_only', powerState: 'on', moduleId: 'MX-6' },
  { id: 7, name: 'Aire', criticality: 'non_essential', controlMode: 'control_enabled', powerState: 'off', moduleId: 'MX-7' },
  { id: 8, name: 'Lámpara', criticality: 'non_essential', controlMode: 'control_enabled', powerState: 'on', moduleId: 'MX-8' },
];
const STATES = { 'MX-1': 'healthy', 'MX-2': 'healthy', 'MX-3': 'healthy', 'MX-4': 'healthy', 'MX-5': 'offline', 'MX-6': 'healthy', 'MX-7': 'healthy', 'MX-8': 'inactive' };

test('closing mode preview lists what will be switched off and what stays on with the reason', () => {
  const p = control.previewClosingMode(SITE, STATES);
  assert.deepEqual(p.willSwitchOff.map((l) => l.loadId), [4]);
  assert.deepEqual(p.staysOn.map((l) => [l.loadId, l.reason]), [[1, 'critical'], [2, 'essential'], [3, 'essential'], [5, 'module_not_healthy'], [6, 'monitor_only'], [8, 'module_not_healthy']]);
  assert.equal(p.staysOn[0].message, 'Congelador: crítico, se mantiene encendido');
  assert.equal(p.staysOn[1].message, 'Horno: esencial, se mantiene encendido');
  assert.equal(p.staysOn[4].message, 'Vitrina: solo monitoreo, se mantiene encendido');
  assert.equal(p.staysOn[3].message, 'Televisor: sin comunicación con su módulo, se mantiene encendido');
  assert.deepEqual(p.alreadyOff.map((l) => l.message), ['Aire: ya está apagado']);
  assert.equal(p.willSwitchOff[0].message, 'Letrero: se apagará');
});

test('closing mode with no loads or no module states is safe', () => {
  assert.deepEqual(control.previewClosingMode([], {}), { willSwitchOff: [], staysOn: [], alreadyOff: [] });
  assert.equal(control.previewClosingMode(SITE, undefined).willSwitchOff.length, 0); // unknown states = offline
});

test('closing mode switches off only non-essential, control-enabled loads with healthy modules', () => {
  const r = control.executeClosingMode({ loads: SITE, moduleStates: STATES, now: NOW, actor: 'ana' });
  assert.deepEqual(r.switchedOff, [4]);
  assert.deepEqual(r.failed, []);
  assert.equal(r.decisions.length, 1);
  assert.equal(r.decisions[0].outcome, 'executed');
  assert.equal(r.decisions[0].audit.origin, 'closing_mode');
  assert.equal(r.audit.event, 'closing_mode');
  assert.deepEqual(r.audit.switchedOff, [4]);
  assert.equal(r.audit.actor, 'ana');
  assert.equal(r.staysOn.length, 6);
  assert.equal(r.message, 'Se apagaron 1 equipos. Se mantienen encendidos 6.');
});

test('closing mode never switches off critical or essential loads, whatever the configuration', () => {
  for (const criticality of ['critical', 'essential']) {
    for (const controlMode of ['monitor_only', 'control_enabled']) {
      for (const state of ['healthy', 'inactive', 'offline']) {
        const l = [{ id: 1, name: 'X', criticality, controlMode, powerState: 'on', moduleId: 'M' }];
        const r = control.executeClosingMode({ loads: l, moduleStates: { M: state }, now: NOW });
        assert.deepEqual(r.switchedOff, [], `${criticality}/${controlMode}/${state}`);
      }
    }
  }
});

test('closing savings add up the nightly energy of the loads that will be switched off', () => {
  const p = control.previewClosingMode(SITE, STATES);
  assert.deepEqual(control.estimateClosingSavings(p, { 4: 2.5, 1: 9 }, 1000), { kwh: 2.5, cop: 2500 });
  assert.deepEqual(control.estimateClosingSavings({ willSwitchOff: [] }, {}, 1000), { kwh: 0, cop: 0 });
  assert.deepEqual(control.estimateClosingSavings(p, {}, 1000), { kwh: 0, cop: 0 });
});
