'use strict';
/**
 * Role permission matrix (RNF-10, RF-02..RF-17, roles table of the prototype requirements).
 *
 * Rule: every attempt to control equipment or export data from a role that lacks the permission is
 * rejected HERE, in the domain, never only by hiding a button. `authorize` returns a structured
 * denial with a plain-Spanish message (RNF-06, no technical words) and an audit-ready record; the
 * application layer must persist that record (result = rejected).
 *
 * How to read it: PERMISSIONS lists every named permission with a Spanish phrase used in denial
 * messages; MATRIX maps each role to the permissions it holds. Owner holds all of them. Unknown
 * roles or permissions are always denied (fail closed).
 */

const { ROLES } = require('./constants');

/** Named permission -> Spanish phrase completing "no tiene permiso para ...". */
const PERMISSIONS = Object.freeze({
  view_simple: 'ver el resumen del consumo',
  view_operations: 'ver el panel general de equipos',
  view_load_detail: 'ver el detalle de un equipo',
  view_technical_data: 'ver los datos técnicos de un equipo',
  view_alerts: 'ver las alertas',
  review_alert: 'marcar alertas como revisadas',
  view_recommendations: 'ver las recomendaciones',
  decide_recommendation: 'aceptar, posponer o descartar recomendaciones',
  propose_action: 'proponer acciones sobre los equipos',
  approve_action: 'aprobar o rechazar acciones sobre los equipos',
  toggle_load: 'encender o apagar equipos',
  activate_closing_mode: 'cerrar el local con el modo cierre',
  configure: 'cambiar la configuración',
  view_savings: 'ver el ahorro y el retorno de la inversión',
  view_reports: 'ver los reportes',
  download_report: 'descargar los reportes',
  view_impact_report: 'ver el reporte de impacto ambiental',
  download_impact_report: 'descargar el reporte de impacto ambiental',
  view_multisite: 'comparar las sedes',
  view_modules: 'ver el estado de los módulos de medición',
  register_module: 'registrar módulos de medición',
  view_diagnostics: 'ver el diagnóstico de los módulos',
  view_raw_data: 'ver los datos crudos',
  export_raw_data: 'exportar los datos',
  import_raw_data: 'reimportar archivos de datos',
  view_audit: 'ver el registro de auditoría',
  manage_users: 'administrar usuarios',
  view_demo_panel: 'usar el panel de demostración',
});

const ALL = Object.keys(PERMISSIONS);

/** Permissions held by each role. Mirrors the "Ve / Puede" table of the requirements. */
const MATRIX = Object.freeze({
  owner: Object.freeze([...ALL]),
  operations_manager: Object.freeze([
    'view_simple', 'view_operations', 'view_load_detail', 'view_alerts', 'review_alert', 'view_recommendations', 'propose_action',
  ]),
  closing_employee: Object.freeze(['view_simple', 'activate_closing_mode']),
  finance: Object.freeze(['view_savings', 'view_reports', 'download_report']),
  sustainability: Object.freeze(['view_impact_report', 'download_impact_report']),
  chain_owner: Object.freeze(['view_multisite']),
  installer_technician: Object.freeze(['view_modules', 'register_module', 'view_diagnostics']),
  data_analyst: Object.freeze(['view_raw_data', 'export_raw_data', 'import_raw_data']),
  non_technical_employee: Object.freeze(['view_simple']),
});

/**
 * Whether `role` holds `permission`. Unknown role or permission returns false.
 * @param {string} role Role code (see ROLES).
 * @param {string} permission Permission name (see PERMISSIONS).
 * @returns {boolean}
 */
function can(role, permission) {
  const held = Object.prototype.hasOwnProperty.call(MATRIX, role) ? MATRIX[role] : null;
  return Boolean(held) && Object.prototype.hasOwnProperty.call(PERMISSIONS, permission) && held.includes(permission);
}

/**
 * Decide a request and build an audit-ready denial when it is not allowed.
 * @param {string} role Role code of the requester.
 * @param {string} permission Permission being exercised.
 * @param {{at?: string, actor?: string}} [context] Optional ISO timestamp and actor copied into the audit record.
 * @returns {{allowed: true, role: string, permission: string}
 *   | {allowed: false, role: string, permission: string, reason: string, message: string,
 *      audit: {event: string, result: string, role: string, permission: string, reason: string, at: (string|null), actor: (string|null)}}}
 */
function authorize(role, permission, context = {}) {
  if (can(role, permission)) return { allowed: true, role, permission };
  const knownRole = Object.prototype.hasOwnProperty.call(ROLES, role);
  const knownPermission = Object.prototype.hasOwnProperty.call(PERMISSIONS, permission);
  let reason = 'role_not_permitted';
  if (!knownRole) reason = 'unknown_role';
  else if (!knownPermission) reason = 'unknown_permission';
  const phrase = knownPermission ? PERMISSIONS[permission] : 'hacer esto';
  const who = knownRole ? `Tu perfil (${ROLES[role]})` : 'Tu perfil';
  const message = `${who} no tiene permiso para ${phrase}. Pídele a la persona administradora que lo haga o que ajuste tu acceso.`;
  return {
    allowed: false,
    role,
    permission,
    reason,
    message,
    audit: {
      event: 'permission_denied', result: 'rejected', role, permission, reason,
      at: context.at || null, actor: context.actor || null,
    },
  };
}

/**
 * Permissions of a role (empty for unknown roles).
 * @param {string} role
 * @returns {string[]}
 */
function permissionsOf(role) {
  return Object.prototype.hasOwnProperty.call(MATRIX, role) ? [...MATRIX[role]] : [];
}

/**
 * Roles that hold a permission.
 * @param {string} permission
 * @returns {string[]}
 */
function rolesWith(permission) {
  return Object.keys(MATRIX).filter((role) => MATRIX[role].includes(permission));
}

module.exports = { PERMISSIONS, MATRIX, can, authorize, permissionsOf, rolesWith };
