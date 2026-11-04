'use strict';
/**
 * Safe control rules, safe state and closing mode (RF-06, RF-07, RF-12, HU-06, HU-09, RNF-18).
 *
 * `decideControlAction` is the single place where a request to switch a load is judged. It never
 * touches hardware or storage: it returns what should happen plus the audit record to persist.
 * Rules, evaluated in this order:
 *  1. CRITICAL loads can never be switched off, by a user, a process or an approved action. The
 *     attempt is rejected and flagged for audit (even when the module is unreachable).
 *  2. SAFE STATE (RNF-18): a module silent for more than 5 minutes keeps its load energized; the
 *     action is discarded with a reason. A module silent between 2 and 5 minutes is "inactive":
 *     nothing is executed and the action stays pending.
 *  3. A load with `control_enabled` ("autonomous control") executes without approval.
 *  4. A `monitor_only` load never acts alone. Without explicit approval a manual or recommended
 *     action stays PENDING, and an automatic process (closing mode, autonomous) is REJECTED because
 *     it has no autonomy there. With explicit approval by a person the action executes.
 *  5. New loads default to monitor_only + essential (`newLoadDefaults`).
 * Closing mode switches off only loads that are non-essential AND control_enabled AND whose module
 * is healthy; critical and essential loads are never switched off.
 */

const {
  AUDIT_RESULT, CONTROL_ACTION, CONTROL_MODE, CONTROL_ORIGIN, CONTROL_OUTCOME, CRITICALITY, DEFAULTS, MODULE_COMM, POWER_STATE,
} = require('./constants');
const { toMs, toIso, MS_PER_MINUTE } = require('./time');

/**
 * Defaults for a newly registered load (rule 5).
 * @returns {{criticality: string, controlMode: string, powerState: string}}
 */
function newLoadDefaults() {
  return { criticality: CRITICALITY.ESSENTIAL, controlMode: CONTROL_MODE.MONITOR_ONLY, powerState: POWER_STATE.ON };
}

/**
 * Validate a criticality/control mode pair (a critical load can never be remotely controlled).
 * @param {{criticality: string, controlMode: string}} config
 * @returns {{valid: boolean, reason?: string, message?: string}}
 */
function validateLoadConfig(config) {
  if (!Object.values(CRITICALITY).includes(config.criticality)) return { valid: false, reason: 'unknown_criticality', message: 'La criticidad indicada no es válida.' };
  if (!Object.values(CONTROL_MODE).includes(config.controlMode)) return { valid: false, reason: 'unknown_control_mode', message: 'El modo de control indicado no es válido.' };
  if (config.criticality === CRITICALITY.CRITICAL && config.controlMode === CONTROL_MODE.CONTROL_ENABLED) {
    return { valid: false, reason: 'critical_load_cannot_be_controlled', message: 'Un equipo crítico solo puede estar en modo de solo monitoreo.' };
  }
  return { valid: true };
}

/**
 * Communication state of a module from the silence since its last report.
 * No report at all is treated as offline (fail safe).
 * @param {{lastSeenAt: (string|number|Date|null), now: (string|number|Date), inactiveMinutes?: number, safeStateMinutes?: number}} input
 * @returns {{state: 'healthy'|'inactive'|'offline', silentMinutes: (number|null)}} healthy <= 2 min, inactive <= 5 min, offline beyond.
 */
function moduleCommunicationState(input) {
  const inactiveMinutes = input.inactiveMinutes ?? DEFAULTS.MODULE_INACTIVE_MINUTES;
  const safeStateMinutes = input.safeStateMinutes ?? DEFAULTS.SAFE_STATE_MINUTES;
  if (input.lastSeenAt === null || input.lastSeenAt === undefined) return { state: MODULE_COMM.OFFLINE, silentMinutes: null };
  const silentMinutes = (toMs(input.now) - toMs(input.lastSeenAt)) / MS_PER_MINUTE;
  let state = MODULE_COMM.HEALTHY;
  if (silentMinutes > safeStateMinutes) state = MODULE_COMM.OFFLINE;
  else if (silentMinutes > inactiveMinutes) state = MODULE_COMM.INACTIVE;
  return { state, silentMinutes };
}

/** Accepts 'healthy' | 'inactive' | 'offline', {state}, or nothing (treated as offline: fail safe). */
function stateOf(moduleState) {
  const value = moduleState && typeof moduleState === 'object' ? moduleState.state : moduleState;
  return Object.values(MODULE_COMM).includes(value) ? value : MODULE_COMM.OFFLINE;
}

function build(load, input, outcome, reason, message, extra = {}) {
  const result = outcome === CONTROL_OUTCOME.PENDING ? null : AUDIT_RESULT[outcome.toUpperCase()];
  const energizedBefore = load.powerState !== POWER_STATE.OFF;
  const executed = outcome === CONTROL_OUTCOME.EXECUTED;
  return {
    outcome,
    reason,
    message,
    nextPowerState: executed ? input.action : (load.powerState ?? POWER_STATE.ON),
    loadStaysEnergized: executed ? input.action === CONTROL_ACTION.ON : energizedBefore,
    audit: {
      event: extra.event || 'control_action', at: toIso(input.now), actor: input.actor ?? null, loadId: load.id, action: input.action,
      origin: input.origin, approved: Boolean(input.approved), result, reason, flagged: Boolean(extra.flagged), detail: message,
    },
  };
}

/**
 * Judge one control request.
 * @param {{load: {id: number, name?: string, criticality: string, controlMode: string, powerState?: string},
 *   action: 'on'|'off', origin: 'manual'|'recommendation'|'closing_mode'|'autonomous', approved: boolean,
 *   moduleState: ('healthy'|'inactive'|'offline'|{state: string}), now: (string|number|Date), actor?: string}} input
 * @returns {{outcome: 'executed'|'pending'|'rejected'|'discarded', reason: string, message: string, nextPowerState: string,
 *   loadStaysEnergized: boolean, audit: {event: string, at: string, actor: (string|null), loadId: number, action: string,
 *   origin: string, approved: boolean, result: (string|null), reason: string, flagged: boolean, detail: string}}}
 *   `audit.result` is null while pending. `reason` is a machine code; `message` is plain Spanish.
 * @throws {TypeError} on an unknown action or origin.
 */
function decideControlAction(input) {
  const { load } = input;
  if (!Object.values(CONTROL_ACTION).includes(input.action)) throw new TypeError(`Unknown control action: ${String(input.action)}`);
  if (!Object.values(CONTROL_ORIGIN).includes(input.origin)) throw new TypeError(`Unknown control origin: ${String(input.origin)}`);
  const name = load.name || 'El equipo';

  if (load.criticality === CRITICALITY.CRITICAL && input.action === CONTROL_ACTION.OFF) {
    return build(load, input, CONTROL_OUTCOME.REJECTED, 'critical_load_protected',
      `${name} es un equipo crítico y no se puede apagar. El intento quedó registrado.`, { event: 'critical_load_off_attempt', flagged: true });
  }
  const comm = stateOf(input.moduleState);
  if (comm === MODULE_COMM.OFFLINE) {
    return build(load, input, CONTROL_OUTCOME.DISCARDED, 'safe_state_module_offline',
      `No hay comunicación con el módulo de ${name} desde hace más de ${DEFAULTS.SAFE_STATE_MINUTES} minutos. El equipo se mantiene encendido y la acción se descartó.`, { event: 'safe_state' });
  }
  if (comm === MODULE_COMM.INACTIVE) {
    return build(load, input, CONTROL_OUTCOME.PENDING, 'module_inactive',
      `No hay confirmación del módulo de ${name}. La acción queda pendiente hasta que vuelva la comunicación.`);
  }
  if (load.controlMode === CONTROL_MODE.CONTROL_ENABLED) {
    return build(load, input, CONTROL_OUTCOME.EXECUTED, 'autonomous_control', `${name}: acción ejecutada por control automático habilitado.`);
  }
  if (input.approved === true) {
    return build(load, input, CONTROL_OUTCOME.EXECUTED, 'approved', `${name}: acción ejecutada con aprobación.`);
  }
  if (input.origin === CONTROL_ORIGIN.AUTONOMOUS || input.origin === CONTROL_ORIGIN.CLOSING_MODE) {
    return build(load, input, CONTROL_OUTCOME.REJECTED, 'autonomy_not_enabled',
      `${name} está en solo monitoreo: el sistema no puede actuar por su cuenta sobre este equipo.`);
  }
  return build(load, input, CONTROL_OUTCOME.PENDING, 'awaiting_approval', `${name}: la acción queda pendiente hasta que alguien la apruebe.`);
}

/**
 * Safe state for queued actions: pending actions of a module that lost communication for more than
 * 5 minutes are discarded, and their loads stay energized.
 * @param {{pendingActions: Array<{id: number, loadId: number, moduleId: string, action: string, origin: string, loadName?: string}>,
 *   moduleStates: Object<string, (string|{state: string})>, now: (string|number|Date)}} input
 * @returns {{discarded: Array<{actionId: number, loadId: number, outcome: string, reason: string, message: string, audit: object}>,
 *   kept: Array<object>}}
 */
function discardPendingActions(input) {
  const discarded = [];
  const kept = [];
  for (const action of input.pendingActions) {
    if (stateOf(input.moduleStates[action.moduleId]) !== MODULE_COMM.OFFLINE) {
      kept.push(action);
      continue;
    }
    const message = `Se descartó la acción pendiente de ${action.loadName || 'un equipo'}: el módulo lleva más de ${DEFAULTS.SAFE_STATE_MINUTES} minutos sin comunicación y el equipo se mantiene encendido.`;
    discarded.push({
      actionId: action.id, loadId: action.loadId, outcome: CONTROL_OUTCOME.DISCARDED, reason: 'safe_state_module_offline', message,
      audit: {
        event: 'safe_state', at: toIso(input.now), actor: null, loadId: action.loadId, action: action.action, origin: action.origin,
        approved: false, result: AUDIT_RESULT.DISCARDED, reason: 'safe_state_module_offline', flagged: false, detail: message,
      },
    });
  }
  return { discarded, kept };
}

/**
 * Classify loads for closing mode without changing anything.
 * @param {Array<{id: number, name: string, criticality: string, controlMode: string, powerState?: string, moduleId?: string}>} loads
 * @param {Object<string, (string|{state: string})>} moduleStates Communication state by module id; a missing state counts as offline.
 * @returns {{willSwitchOff: Array<{loadId: number, name: string, message: string}>,
 *   staysOn: Array<{loadId: number, name: string, reason: string, message: string}>,
 *   alreadyOff: Array<{loadId: number, name: string, message: string}>}}
 */
function previewClosingMode(loads, moduleStates) {
  const willSwitchOff = [];
  const staysOn = [];
  const alreadyOff = [];
  const keep = (load, reason, text) => staysOn.push({ loadId: load.id, name: load.name, reason, message: `${load.name}: ${text}, se mantiene encendido` });
  for (const load of loads) {
    if (load.criticality === CRITICALITY.CRITICAL) keep(load, 'critical', 'crítico');
    else if (load.criticality === CRITICALITY.ESSENTIAL) keep(load, 'essential', 'esencial');
    else if (load.controlMode !== CONTROL_MODE.CONTROL_ENABLED) keep(load, 'monitor_only', 'solo monitoreo');
    else if (load.powerState === POWER_STATE.OFF) alreadyOff.push({ loadId: load.id, name: load.name, message: `${load.name}: ya está apagado` });
    else if (stateOf(moduleStates && moduleStates[load.moduleId]) !== MODULE_COMM.HEALTHY) keep(load, 'module_not_healthy', 'sin comunicación con su módulo');
    else willSwitchOff.push({ loadId: load.id, name: load.name, message: `${load.name}: se apagará` });
  }
  return { willSwitchOff, staysOn, alreadyOff };
}

/**
 * Execute closing mode: switches off only the loads the preview lists, each one judged by
 * `decideControlAction` (origin closing_mode, approved by the person who confirmed).
 * @param {{loads: Array, moduleStates: Object, now: (string|number|Date), actor?: string}} input
 * @returns {{switchedOff: number[], failed: Array<{loadId: number, reason: string}>, staysOn: Array, alreadyOff: Array,
 *   decisions: Array<object>, message: string, audit: object}}
 */
function executeClosingMode(input) {
  const preview = previewClosingMode(input.loads, input.moduleStates);
  const byId = new Map(input.loads.map((l) => [l.id, l]));
  const decisions = [];
  const switchedOff = [];
  const failed = [];
  for (const item of preview.willSwitchOff) {
    const load = byId.get(item.loadId);
    const decision = decideControlAction({
      load, action: CONTROL_ACTION.OFF, origin: CONTROL_ORIGIN.CLOSING_MODE, approved: true,
      moduleState: input.moduleStates[load.moduleId], now: input.now, actor: input.actor,
    });
    decisions.push({ loadId: load.id, ...decision });
    if (decision.outcome === CONTROL_OUTCOME.EXECUTED) switchedOff.push(load.id);
    else failed.push({ loadId: load.id, reason: decision.reason });
  }
  const message = `Se apagaron ${switchedOff.length} equipos. Se mantienen encendidos ${preview.staysOn.length}.`;
  return {
    switchedOff, failed, staysOn: preview.staysOn, alreadyOff: preview.alreadyOff, decisions, message,
    audit: {
      event: 'closing_mode', at: toIso(input.now), actor: input.actor ?? null, result: AUDIT_RESULT.EXECUTED,
      switchedOff, kept: preview.staysOn.map((s) => ({ loadId: s.loadId, reason: s.reason })), failed, detail: message,
    },
  };
}

/**
 * Estimated nightly saving of a closing-mode preview.
 * @param {{willSwitchOff: Array<{loadId: number}>}} preview Result of previewClosingMode.
 * @param {Object<string, number>} nightlyKwhByLoad Average kWh each load consumes while closed, by load id.
 * @param {number} copPerKwh Tariff valid tonight.
 * @returns {{kwh: number, cop: number}}
 */
function estimateClosingSavings(preview, nightlyKwhByLoad, copPerKwh) {
  const kwh = preview.willSwitchOff.reduce((total, item) => total + (nightlyKwhByLoad[item.loadId] || 0), 0);
  return { kwh, cop: kwh * copPerKwh };
}

module.exports = {
  newLoadDefaults, validateLoadConfig, moduleCommunicationState, decideControlAction, discardPendingActions,
  previewClosingMode, executeClosingMode, estimateClosingSavings,
};
