'use strict';
// Reference data: roles, sites (with schedules), users, tariffs and per-site settings.

function createReferenceRepositories(db) {
  const q = {
    roles: db.prepare('SELECT code, name, description FROM roles ORDER BY code'),
    role: db.prepare('SELECT code, name, description FROM roles WHERE code = ?'),

    siteInsert: db.prepare('INSERT INTO sites(id, name, city, timezone) VALUES(?,?,?,?)'),
    site: db.prepare('SELECT * FROM sites WHERE id = ?'),
    sites: db.prepare('SELECT * FROM sites ORDER BY name'),
    scheduleUpsert: db.prepare(`INSERT INTO site_schedules(site_id, weekday, closed, opens_at, closes_at) VALUES(?,?,?,?,?)
      ON CONFLICT(site_id, weekday) DO UPDATE SET closed = excluded.closed, opens_at = excluded.opens_at, closes_at = excluded.closes_at`),
    schedule: db.prepare('SELECT weekday, closed, opens_at, closes_at FROM site_schedules WHERE site_id = ? ORDER BY weekday'),

    userInsert: db.prepare('INSERT INTO users(username, salt, hash, role, display_name, created_by) VALUES(?,?,?,?,?,?)'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    users: db.prepare('SELECT id, username, role, display_name, active, created_at, last_login_at FROM users ORDER BY username'),
    userRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    userActive: db.prepare('UPDATE users SET active = ? WHERE id = ?'),
    userLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
    grant: db.prepare('INSERT INTO user_sites(user_id, site_id) VALUES(?,?) ON CONFLICT DO NOTHING'),
    revoke: db.prepare('DELETE FROM user_sites WHERE user_id = ? AND site_id = ?'),
    userSites: db.prepare('SELECT s.* FROM sites s JOIN user_sites us ON us.site_id = s.id WHERE us.user_id = ? ORDER BY s.name'),

    tariffInsert: db.prepare('INSERT INTO tariffs(site_id, cop_per_kwh, effective_from, created_by, note) VALUES(?,?,?,?,?)'),
    tariffs: db.prepare('SELECT * FROM tariffs WHERE site_id = ? ORDER BY effective_from'),
    tariffAt: db.prepare('SELECT * FROM tariffs WHERE site_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1'),

    settingsGet: db.prepare('SELECT * FROM settings WHERE site_id = ?'),
    settingsInsert: db.prepare('INSERT INTO settings(site_id) VALUES(?) ON CONFLICT DO NOTHING')
  };
  const settingColumns = ['investment_cop', 'emission_factor_kg_per_kwh', 'emission_factor_source', 'alert_threshold_pct', 'alert_window_minutes'];

  return {
    roles: {
      list: () => q.roles.all(),
      get: (code) => q.role.get(code) ?? null
    },
    sites: {
      create({ id, name, city = null, timezone = 'America/Bogota' }) { q.siteInsert.run(id, name, city, timezone); return q.site.get(id); },
      get: (id) => q.site.get(id) ?? null,
      list: () => q.sites.all(),
      setSchedule(siteId, weekday, { closed = false, opensAt = null, closesAt = null }) {
        q.scheduleUpsert.run(siteId, weekday, closed ? 1 : 0, closed ? null : opensAt, closed ? null : closesAt);
      },
      getSchedule: (siteId) => q.schedule.all(siteId)
    },
    users: {
      create({ username, salt, hash, role, displayName = null, createdBy = null }) {
        const result = q.userInsert.run(username, salt, hash, role, displayName, createdBy);
        return q.userById.get(Number(result.lastInsertRowid));
      },
      getById: (id) => q.userById.get(id) ?? null,
      getByUsername: (username) => q.userByName.get(username) ?? null,
      list: () => q.users.all(),
      setRole: (id, role) => q.userRole.run(role, id).changes === 1,
      setActive: (id, active) => q.userActive.run(active ? 1 : 0, id).changes === 1,
      touchLogin: (id, at) => q.userLogin.run(at, id),
      grantSite: (userId, siteId) => q.grant.run(userId, siteId),
      revokeSite: (userId, siteId) => q.revoke.run(userId, siteId),
      sitesFor: (userId) => q.userSites.all(userId)
    },
    tariffs: {
      create({ siteId, copPerKwh, effectiveFrom, createdBy = null, note = null }) {
        const result = q.tariffInsert.run(siteId, copPerKwh, effectiveFrom, createdBy, note);
        return Number(result.lastInsertRowid);
      },
      list: (siteId) => q.tariffs.all(siteId),
      /** Tariff in force at `ts` (latest effective_from not after ts), or null. */
      effectiveAt: (siteId, ts) => q.tariffAt.get(siteId, ts) ?? null
    },
    settings: {
      /** Returns the site settings, creating the row with defaults when missing. */
      get(siteId) {
        q.settingsInsert.run(siteId);
        return q.settingsGet.get(siteId);
      },
      update(siteId, patch, { updatedBy = null, at = new Date().toISOString() } = {}) {
        q.settingsInsert.run(siteId);
        const keys = Object.keys(patch).filter((k) => settingColumns.includes(k));
        if (keys.length) {
          const sql = `UPDATE settings SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE site_id = ?`;
          db.prepare(sql).run(...keys.map((k) => patch[k]), updatedBy, at, siteId);
        }
        return q.settingsGet.get(siteId);
      }
    }
  };
}

module.exports = { createReferenceRepositories };
