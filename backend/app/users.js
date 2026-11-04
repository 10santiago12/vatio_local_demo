'use strict';
/**
 * User administration (owner only): create with a role and a password chosen by the administrator
 * (no default passwords), change role, deactivate/reactivate and reset a password. Every change is
 * audited and ends the affected user's sessions. The last active owner can never be demoted or
 * deactivated, so the system cannot lock itself out.
 */
const { ROLES } = require('../domain/constants');
const { badRequest, conflict, notFound, unprocessable } = require('../http/http-error');
const { hashPassword, passwordProblem } = require('./passwords');

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,39}$/;

function present(row) {
  return {
    id: row.id, username: row.username, displayName: row.display_name || row.username, role: row.role, roleName: ROLES[row.role] || row.role,
    active: Boolean(row.active), createdAt: row.created_at, lastLoginAt: row.last_login_at,
  };
}

/** @param {{repos: object, access: object, auth: object}} deps */
function createUserAdmin({ repos, access, auth }) {
  function existing(id) {
    const user = repos.users.getById(Number(id));
    if (!user) throw notFound('No existe ese usuario.', 'user_not_found');
    return user;
  }
  function validRole(role) {
    if (typeof role !== 'string' || !Object.prototype.hasOwnProperty.call(ROLES, role)) throw badRequest('El perfil indicado no existe.', 'invalid_role');
    return role;
  }
  function guardLastOwner(user, message) {
    if (user.role === 'owner' && user.active && repos.users.countActiveOwners() <= 1) throw unprocessable(message, 'last_owner');
  }

  return {
    list: () => repos.users.list().map(present),
    roles: () => repos.roles.list().map((r) => ({ code: r.code, name: r.name, description: r.description })),

    create(input, actor) {
      const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
      if (!USERNAME_PATTERN.test(username)) throw badRequest('El usuario debe tener entre 3 y 40 caracteres: letras minúsculas, números, punto, guion o guion bajo.', 'invalid_username');
      const role = validRole(input.role);
      const problem = passwordProblem(input.password);
      if (problem) throw badRequest(problem, 'weak_password');
      const displayName = typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim().slice(0, 80) : username;
      if (repos.users.getByUsername(username)) throw conflict('Ya existe un usuario con ese nombre.', 'username_taken');
      const { salt, hash } = hashPassword(input.password);
      const user = repos.users.create({ username, salt, hash, role, displayName, createdBy: actor.userId });
      access.audit({ user: actor, event: 'user_created', result: 'executed', details: { userId: user.id, username, role } });
      return present(user);
    },

    changeRole(id, role, actor) {
      const user = existing(id);
      validRole(role);
      if (user.role !== role) guardLastOwner(user, 'Debe quedar al menos un administrador activo: no se puede cambiar este perfil.');
      repos.users.setRole(user.id, role);
      auth.invalidateUser(user.id);
      access.audit({ user: actor, event: 'user_role_changed', result: 'executed', details: { userId: user.id, username: user.username, from: user.role, to: role } });
      return present(repos.users.getById(user.id));
    },

    setActive(id, active, actor) {
      const user = existing(id);
      if (!active) guardLastOwner(user, 'Debe quedar al menos un administrador activo: no se puede desactivar este usuario.');
      repos.users.setActive(user.id, active);
      if (!active) auth.invalidateUser(user.id);
      access.audit({ user: actor, event: active ? 'user_reactivated' : 'user_deactivated', result: 'executed', details: { userId: user.id, username: user.username } });
      return present(repos.users.getById(user.id));
    },

    resetPassword(id, password, actor) {
      const user = existing(id);
      const problem = passwordProblem(password);
      if (problem) throw badRequest(problem, 'weak_password');
      const { salt, hash } = hashPassword(password);
      repos.users.setPassword(user.id, salt, hash);
      auth.invalidateUser(user.id);
      access.audit({ user: actor, event: 'user_password_reset', result: 'executed', details: { userId: user.id, username: user.username } });
      return present(repos.users.getById(user.id));
    },
  };
}

module.exports = { createUserAdmin, USERNAME_PATTERN };
