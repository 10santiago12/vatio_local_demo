'use strict';
// Measurement data: loads, modules, raw readings, hourly aggregates and baselines.
const { transaction } = require('../connection');

function createMeasurementRepositories(db) {
  const q = {
    loadInsert: db.prepare('INSERT INTO loads(site_id, code, name, icon, typical_power_w, criticality, control_mode) VALUES(?,?,?,?,?,?,?)'),
    load: db.prepare('SELECT * FROM loads WHERE id = ?'),
    loadByCode: db.prepare('SELECT * FROM loads WHERE site_id = ? AND code = ?'),
    loadsBySite: db.prepare('SELECT * FROM loads WHERE site_id = ? ORDER BY name'),
    loadConfig: db.prepare('UPDATE loads SET name = ?, criticality = ?, control_mode = ? WHERE id = ?'),
    loadPower: db.prepare('UPDATE loads SET power_state = ? WHERE id = ?'),

    moduleInsert: db.prepare('INSERT INTO modules(id, site_id, load_id, manufacturer, status, registered_by, registered_at) VALUES(?,?,?,?,?,?,?)'),
    module: db.prepare('SELECT * FROM modules WHERE id = ?'),
    modulesBySite: db.prepare('SELECT * FROM modules WHERE site_id = ? ORDER BY id'),
    modulesAll: db.prepare('SELECT * FROM modules ORDER BY id'),
    moduleHeartbeat: db.prepare("UPDATE modules SET last_heartbeat = ?, status = CASE WHEN status = 'inactive' THEN 'active' ELSE status END WHERE id = ?"),
    moduleStatus: db.prepare('UPDATE modules SET status = ? WHERE id = ?'),
    moduleAssign: db.prepare('UPDATE modules SET load_id = ? WHERE id = ?'),

    // ON CONFLICT DO NOTHING only skips duplicates; INSERT OR IGNORE would also hide CHECK violations.
    readingInsert: db.prepare('INSERT INTO readings(load_id, module_id, ts, power_w, voltage_v, current_a, energy_kwh, source) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(load_id, ts) DO NOTHING'),
    readingRange: db.prepare('SELECT * FROM readings WHERE load_id = ? AND ts >= ? AND ts < ? ORDER BY ts'),
    readingLatest: db.prepare('SELECT * FROM readings WHERE load_id = ? ORDER BY ts DESC LIMIT 1'),
    readingHasData: db.prepare('SELECT 1 AS found FROM readings WHERE load_id = ? UNION ALL SELECT 1 FROM readings_hourly WHERE load_id = ? LIMIT 1'),
    readingDelete: db.prepare('DELETE FROM readings WHERE load_id = ? AND ts >= ? AND ts < ?'),
    hourlyDelete: db.prepare('DELETE FROM readings_hourly WHERE load_id = ? AND hour_start >= ? AND hour_start < ?'),
    readingLatestBySite: db.prepare(`SELECT r.*, l.code AS load_code, l.name AS load_name, m.manufacturer AS manufacturer, m.status AS module_status
      FROM readings r
      JOIN (SELECT load_id, MAX(ts) AS ts FROM readings
            WHERE load_id IN (SELECT id FROM loads WHERE site_id = ?) AND (? IS NULL OR source = ?) AND ts >= ? GROUP BY load_id) x
        ON x.load_id = r.load_id AND x.ts = r.ts
      JOIN loads l ON l.id = r.load_id LEFT JOIN modules m ON m.id = r.module_id ORDER BY r.module_id, l.code`),
    readingRecentBySite: db.prepare(`SELECT r.*, l.code AS load_code, l.name AS load_name, m.manufacturer AS manufacturer
      FROM readings r JOIN loads l ON l.id = r.load_id LEFT JOIN modules m ON m.id = r.module_id
      WHERE l.site_id = ? AND (? IS NULL OR r.source = ?) AND r.ts >= ? ORDER BY r.ts DESC, r.id DESC LIMIT ?`),
    hourlyInsert: db.prepare(`INSERT INTO readings_hourly(load_id, hour_start, avg_power_w, max_power_w, energy_kwh, samples) VALUES(?,?,?,?,?,?)
      ON CONFLICT(load_id, hour_start) DO NOTHING`),
    readingPrune: db.prepare('DELETE FROM readings WHERE ts < ?'),
    hourlyFromRaw: db.prepare(`SELECT load_id, substr(ts, 1, 13) || ':00:00.000Z' AS hour_start,
        AVG(power_w) AS avg_power_w, MAX(power_w) AS max_power_w,
        AVG(power_w) / 1000.0 * (COUNT(*) / 60.0) AS energy_kwh, COUNT(*) AS samples
      FROM readings WHERE load_id = ? AND ts >= ? AND ts < ? GROUP BY substr(ts, 1, 13)`),
    hourlyUpsert: db.prepare(`INSERT INTO readings_hourly(load_id, hour_start, avg_power_w, max_power_w, energy_kwh, samples) VALUES(?,?,?,?,?,?)
      ON CONFLICT(load_id, hour_start) DO UPDATE SET avg_power_w = excluded.avg_power_w, max_power_w = excluded.max_power_w,
        energy_kwh = excluded.energy_kwh, samples = excluded.samples`),
    hourlyRange: db.prepare('SELECT * FROM readings_hourly WHERE load_id = ? AND hour_start >= ? AND hour_start < ? ORDER BY hour_start'),

    baselineUpsert: db.prepare(`INSERT INTO baselines(load_id, day_type, hour, mean_w, std_w, band_low_w, band_high_w, sample_days, window_start, window_end, computed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(load_id, day_type, hour, window_end) DO UPDATE SET mean_w = excluded.mean_w, std_w = excluded.std_w,
        band_low_w = excluded.band_low_w, band_high_w = excluded.band_high_w, sample_days = excluded.sample_days,
        window_start = excluded.window_start, computed_at = excluded.computed_at`),
    baselineLatest: db.prepare(`SELECT * FROM baselines WHERE load_id = ? AND window_end = (SELECT MAX(window_end) FROM baselines WHERE load_id = ?)
      ORDER BY day_type, hour`),
    baselineAt: db.prepare(`SELECT * FROM baselines WHERE load_id = ? AND day_type = ? AND hour = ?
      AND window_end = (SELECT MAX(window_end) FROM baselines WHERE load_id = ?)`)
  };

  return {
    loads: {
      create({ siteId, code, name, icon = null, typicalPowerW = null, criticality = 'essential', controlMode = 'monitor_only' }) {
        const result = q.loadInsert.run(siteId, code, name, icon, typicalPowerW, criticality, controlMode);
        return q.load.get(Number(result.lastInsertRowid));
      },
      get: (id) => q.load.get(id) ?? null,
      getByCode: (siteId, code) => q.loadByCode.get(siteId, code) ?? null,
      listBySite: (siteId) => q.loadsBySite.all(siteId),
      updateConfig(id, { name, criticality, controlMode }) {
        const current = q.load.get(id);
        if (!current) return null;
        q.loadConfig.run(name ?? current.name, criticality ?? current.criticality, controlMode ?? current.control_mode, id);
        return q.load.get(id);
      },
      setPowerState: (id, state) => q.loadPower.run(state, id).changes === 1
    },
    modules: {
      register({ id, siteId, loadId = null, manufacturer, status = 'active', registeredBy = null, registeredAt = new Date().toISOString() }) {
        q.moduleInsert.run(id, siteId, loadId, manufacturer, status, registeredBy, registeredAt);
        return q.module.get(id);
      },
      get: (id) => q.module.get(id) ?? null,
      listBySite: (siteId) => q.modulesBySite.all(siteId),
      list: () => q.modulesAll.all(),
      heartbeat: (id, at) => q.moduleHeartbeat.run(at, id).changes === 1,
      setStatus: (id, status) => q.moduleStatus.run(status, id).changes === 1,
      assignLoad: (id, loadId) => q.moduleAssign.run(loadId, id).changes === 1
    },
    readings: {
      /** Inserts readings atomically; duplicates of (load_id, ts) are ignored. Returns the number inserted. */
      insertMany(rows) {
        return transaction(db, () => {
          let inserted = 0;
          for (const r of rows) {
            inserted += Number(q.readingInsert.run(r.loadId, r.moduleId ?? null, r.ts, r.powerW, r.voltageV ?? null, r.currentA ?? null, r.energyKwh ?? null, r.source ?? 'simulator').changes);
          }
          return inserted;
        });
      },
      range: (loadId, from, to) => q.readingRange.all(loadId, from, to),
      /** Whether the load has any raw or hourly data. */
      hasData: (loadId) => q.readingHasData.get(loadId, loadId) !== undefined,
      /** Raw readings of [from, to); returns rows removed (used to regenerate simulated history). */
      deleteRange: (loadId, from, to) => Number(q.readingDelete.run(loadId, from, to).changes),
      deleteHourlyRange: (loadId, from, to) => Number(q.hourlyDelete.run(loadId, from, to).changes),
      /** Latest reading of every load of a site, with load code/name and module manufacturer. Optional source and lower bound on ts. */
      latestBySite: (siteId, { source = null, since = '' } = {}) => q.readingLatestBySite.all(siteId, source, source, since),
      /** Newest readings of a site first. */
      recentBySite: (siteId, { source = null, since = '', limit = 250 } = {}) => q.readingRecentBySite.all(siteId, source, source, since, limit),
      /** Inserts hourly aggregates atomically; existing hours are kept. Returns rows written. */
      insertHourlyMany(rows) {
        return transaction(db, () => {
          let inserted = 0;
          for (const h of rows) inserted += Number(q.hourlyInsert.run(h.loadId, h.hourStart, h.avgPowerW, h.maxPowerW, h.energyKwh, h.samples).changes);
          return inserted;
        });
      },
      latest: (loadId) => q.readingLatest.get(loadId) ?? null,
      /** Deletes raw readings older than `before` (call after aggregating them). Returns rows removed. */
      pruneRawBefore: (before) => Number(q.readingPrune.run(before).changes),
      /** Aggregates raw readings in [from, to) into hourly rows (upsert). Returns hours written. */
      aggregateHourly(loadId, from, to) {
        return transaction(db, () => {
          const hours = q.hourlyFromRaw.all(loadId, from, to);
          for (const h of hours) q.hourlyUpsert.run(h.load_id, h.hour_start, h.avg_power_w, h.max_power_w, h.energy_kwh, h.samples);
          return hours.length;
        });
      },
      hourlyRange: (loadId, from, to) => q.hourlyRange.all(loadId, from, to)
    },
    baselines: {
      /** Replaces/inserts a set of hourly baseline rows for one load and window. */
      upsertMany(rows) {
        transaction(db, () => {
          for (const b of rows) {
            q.baselineUpsert.run(b.loadId, b.dayType, b.hour, b.meanW, b.stdW, b.bandLowW, b.bandHighW, b.sampleDays, b.windowStart, b.windowEnd, b.computedAt ?? new Date().toISOString());
          }
        });
      },
      /** Baseline rows of the most recent window for a load. */
      latestForLoad: (loadId) => q.baselineLatest.all(loadId, loadId),
      at: (loadId, dayType, hour) => q.baselineAt.get(loadId, dayType, hour, loadId) ?? null
    }
  };
}

module.exports = { createMeasurementRepositories };
