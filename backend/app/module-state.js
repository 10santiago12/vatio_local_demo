'use strict';
/** Communication state of measurement modules, shared by operations, control and diagnostics. */
const { MODULE_COMM, MODULE_STATUS } = require('../domain/constants');
const { moduleCommunicationState } = require('../domain/control');

/** A load of a site by numeric id or by code (slug), or null. */
function findLoad(repos, siteId, key) {
  const load = /^\d+$/.test(String(key)) ? repos.loads.get(Number(key)) : repos.loads.getByCode(siteId, String(key));
  return load && load.site_id === siteId ? load : null;
}

/** Modules of a site by load id. */
function modulesByLoad(repos, siteId) {
  return new Map(repos.modules.listBySite(siteId).filter((m) => m.load_id !== null).map((m) => [m.load_id, m]));
}

/** `{state: healthy|inactive|offline, silentMinutes}` from the module heartbeat. */
function communicationOf(module_, nowMs) {
  return moduleCommunicationState({ lastSeenAt: module_ ? module_.last_heartbeat : null, now: nowMs });
}

/** Plain status shown to the user: active, inactive, offline, error or no_module. */
function statusOf(module_, comm) {
  if (!module_) return 'no_module';
  if (comm.state === MODULE_COMM.OFFLINE) return 'offline';
  if (comm.state === MODULE_COMM.INACTIVE) return MODULE_STATUS.INACTIVE;
  return module_.status === MODULE_STATUS.ERROR ? MODULE_STATUS.ERROR : MODULE_STATUS.ACTIVE;
}

const STATUS_TEXT = Object.freeze({
  active: 'Funcionando', inactive: 'Sin señal reciente', offline: 'Sin comunicación', error: 'Con falla', no_module: 'Sin módulo',
});

/** Map module id -> communication state, the input of the domain safe-state functions. */
function moduleStates(repos, siteId, nowMs) {
  const out = {};
  for (const m of repos.modules.listBySite(siteId)) out[m.id] = communicationOf(m, nowMs);
  return out;
}

module.exports = { findLoad, modulesByLoad, communicationOf, statusOf, moduleStates, STATUS_TEXT };
