'use strict';
/**
 * Shared domain vocabulary and default thresholds.
 *
 * Every enumeration here mirrors a CHECK constraint (or lookup table) of the database schema
 * (backend/db/migrations/*.sql, docs/der.md). tests/domain/constants.test.js compares them with the
 * SQL so both sides cannot drift apart silently.
 *
 * Requirements covered: RF-04 (alert defaults), RF-05 (criticality factors), RF-06/RF-07 (control
 * vocabulary), RF-08 (module communication limits), RNF-18 (safe-state limit).
 * No logic lives here: only frozen data.
 */

const freeze = Object.freeze;

/** Load criticality: how harmful an unplanned shutdown is for the business. */
const CRITICALITY = freeze({ CRITICAL: 'critical', ESSENTIAL: 'essential', NON_ESSENTIAL: 'non_essential' });
/** Weight applied to the recommendation score (RF-05). */
const CRITICALITY_FACTOR = freeze({ critical: 0.3, essential: 0.6, non_essential: 1.0 });
/** Plain-Spanish label shown to users. */
const CRITICALITY_LABEL = freeze({ critical: 'crítico', essential: 'esencial', non_essential: 'no esencial' });

/** monitor_only: the system never acts alone. control_enabled: "autonomous control" (RF-07). */
const CONTROL_MODE = freeze({ MONITOR_ONLY: 'monitor_only', CONTROL_ENABLED: 'control_enabled' });
const POWER_STATE = freeze({ ON: 'on', OFF: 'off' });
/** Control action requested on a load. */
const CONTROL_ACTION = freeze({ ON: 'on', OFF: 'off' });
const CONTROL_ORIGIN = freeze({ MANUAL: 'manual', RECOMMENDATION: 'recommendation', CLOSING_MODE: 'closing_mode', AUTONOMOUS: 'autonomous' });
/** Persisted status of a control action row. */
const CONTROL_STATUS = freeze({ PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected', EXECUTED: 'executed', DISCARDED: 'discarded' });
/** Result of the pure decision function (see control.js). */
const CONTROL_OUTCOME = freeze({ EXECUTED: 'executed', PENDING: 'pending', REJECTED: 'rejected', DISCARDED: 'discarded' });
/** Values allowed in audit.result (a pending action has no result yet). */
const AUDIT_RESULT = freeze({ EXECUTED: 'executed', REJECTED: 'rejected', DISCARDED: 'discarded' });

const DAY_TYPE = freeze({ WORKDAY: 'workday', SUNDAY: 'sunday' });

/** Maintenance is a distinct alert type (RF-15). */
const ALERT_TYPE = freeze({ CONSUMPTION: 'consumption', OFF_HOURS: 'off_hours', MAINTENANCE: 'maintenance', INACTIVE_MODULE: 'inactive_module' });
const ALERT_STATUS = freeze({ ACTIVE: 'active', REVIEWED: 'reviewed' });

const RECOMMENDATION_TYPE = freeze({
  OFF_HOURS_SHUTDOWN: 'off_hours_shutdown',
  SCHEDULE: 'schedule',
  REDUCE_STANDBY: 'reduce_standby',
  MAINTENANCE_REVIEW: 'maintenance_review',
  REPLACEMENT: 'replacement',
});
const RECOMMENDATION_STATUS = freeze({ PENDING: 'pending', ACCEPTED: 'accepted', POSTPONED: 'postponed', DISCARDED: 'discarded' });

const MODULE_STATUS = freeze({ ACTIVE: 'active', INACTIVE: 'inactive', ERROR: 'error' });
/** Communication state derived from the silence of a module (control.js, moduleCommunicationState). */
const MODULE_COMM = freeze({ HEALTHY: 'healthy', INACTIVE: 'inactive', OFFLINE: 'offline' });

/** The nine roles of the requirements, with the display names stored in the roles table. */
const ROLES = freeze({
  owner: 'Administrador',
  operations_manager: 'Gerente de operaciones',
  closing_employee: 'Empleado de cierre',
  finance: 'Responsable financiero',
  sustainability: 'Responsable de sostenibilidad',
  chain_owner: 'Dueño de cadena',
  installer_technician: 'Técnico instalador',
  data_analyst: 'Analista de datos',
  non_technical_employee: 'Empleado no técnico',
});

/** Business thresholds (all overridable through function options / site settings). */
const DEFAULTS = freeze({
  MIN_BASELINE_DAYS: 7,
  ALERT_THRESHOLD_PCT: 30,
  ALERT_WINDOW_MINUTES: 15,
  MODULE_INACTIVE_MINUTES: 2,
  SAFE_STATE_MINUTES: 5,
  MAINTENANCE_RECENT_DAYS: 3,
  MAINTENANCE_MIN_HISTORY_DAYS: 30,
  MAINTENANCE_THRESHOLD_PCT: 15,
  ATTRIBUTION_WINDOW_DAYS: 7,
  BAND_SIGMAS: 2,
  DAYS_PER_MONTH: 30,
  /** America/Bogota is UTC-5 all year (no daylight saving time). */
  UTC_OFFSET_MINUTES: -300,
  CALC_TOLERANCE_COST: 0.01,
  CALC_TOLERANCE_SAVINGS: 0.02,
});

module.exports = {
  CRITICALITY, CRITICALITY_FACTOR, CRITICALITY_LABEL, CONTROL_MODE, POWER_STATE, CONTROL_ACTION, CONTROL_ORIGIN,
  CONTROL_STATUS, CONTROL_OUTCOME, AUDIT_RESULT, DAY_TYPE, ALERT_TYPE, ALERT_STATUS, RECOMMENDATION_TYPE,
  RECOMMENDATION_STATUS, MODULE_STATUS, MODULE_COMM, ROLES, DEFAULTS,
};
