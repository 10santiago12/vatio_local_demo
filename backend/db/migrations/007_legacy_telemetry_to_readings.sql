-- 007: migrate the first MVP's `telemetry` table (one JSON document per reading) into the product
-- tables: sites, loads, modules and readings. The legacy table is kept untouched as an archive; the
-- application no longer writes to it. Rows that are not valid readings (missing module, load, a
-- negative power, an invalid site slug...) are skipped, never guessed.
-- Idempotent by construction: every statement skips what already exists.

-- Sites referenced by legacy rows (only valid slugs).
INSERT INTO sites(id, name)
SELECT DISTINCT t.site_id,
       CASE t.site_id WHEN 'la-espiga-chia' THEN 'Panadería La Espiga – Chía' ELSE t.site_id END
FROM telemetry t
WHERE length(t.site_id) > 0 AND t.site_id NOT GLOB '*[^a-z0-9-]*'
ON CONFLICT(id) DO NOTHING;

-- One load per (site, load code). The three refrigeration/POS loads of the MVP were hard-coded as
-- critical by the old server; everything else keeps the safe default (essential, monitor only).
INSERT INTO loads(site_id, code, name, criticality)
SELECT site_id, code, COALESCE(name, code),
       CASE WHEN code IN ('freezer', 'fridge', 'pos') THEN 'critical' ELSE 'essential' END
FROM (
  SELECT t.site_id AS site_id,
         json_extract(t.reading, '$.load_id') AS code,
         NULLIF(json_extract(t.reading, '$.load_name'), '') AS name,
         ROW_NUMBER() OVER (PARTITION BY t.site_id, json_extract(t.reading, '$.load_id') ORDER BY (NULLIF(json_extract(t.reading, '$.load_name'), '') IS NULL), t.id DESC) AS rn
  FROM telemetry t
  WHERE json_valid(t.reading)
    AND json_type(t.reading, '$.load_id') = 'text' AND length(json_extract(t.reading, '$.load_id')) BETWEEN 1 AND 64
    AND json_type(t.reading, '$.power_w') IN ('integer', 'real') AND json_extract(t.reading, '$.power_w') >= 0
    AND t.site_id IN (SELECT id FROM sites)
)
WHERE rn = 1
ON CONFLICT(site_id, code) DO NOTHING;

-- Modules: the latest row of each module id gives its manufacturer and load; the load is assigned
-- only to the first module that ever reported it (a load has at most one module).
INSERT INTO modules(id, site_id, load_id, manufacturer, status, last_heartbeat, registered_at)
SELECT m.module_id, m.site_id,
       CASE WHEN m.owner_rank = 1 AND NOT EXISTS (SELECT 1 FROM modules x WHERE x.load_id = l.id) THEN l.id END,
       m.manufacturer, 'active', m.last_seen, m.first_seen
FROM (
  SELECT s.*,
         ROW_NUMBER() OVER (PARTITION BY s.site_id, s.load_code ORDER BY s.first_seen, s.module_id) AS owner_rank
  FROM (
    SELECT t.site_id AS site_id,
           json_extract(t.reading, '$.module_id') AS module_id,
           json_extract(t.reading, '$.load_id') AS load_code,
           COALESCE(NULLIF(json_extract(t.reading, '$.manufacturer'), ''), 'ESP32 virtual') AS manufacturer,
           MAX(t.received_at) OVER (PARTITION BY json_extract(t.reading, '$.module_id')) AS last_seen,
           MIN(t.received_at) OVER (PARTITION BY json_extract(t.reading, '$.module_id')) AS first_seen,
           ROW_NUMBER() OVER (PARTITION BY json_extract(t.reading, '$.module_id') ORDER BY t.id DESC) AS rn
    FROM telemetry t
    WHERE json_valid(t.reading)
      AND json_type(t.reading, '$.module_id') = 'text' AND length(json_extract(t.reading, '$.module_id')) BETWEEN 1 AND 64
      AND json_type(t.reading, '$.load_id') = 'text'
        AND json_type(t.reading, '$.power_w') IN ('integer', 'real') AND json_extract(t.reading, '$.power_w') >= 0
      AND t.site_id IN (SELECT id FROM sites)
  ) s
  WHERE s.rn = 1
) m
LEFT JOIN loads l ON l.site_id = m.site_id AND l.code = m.load_code
WHERE true
ON CONFLICT(id) DO NOTHING;

-- Readings. The timestamp is the one the device sent or, when empty, the reception time, normalized
-- to ISO-8601 UTC with milliseconds. Duplicates of (load, timestamp) are skipped.
INSERT INTO readings(load_id, module_id, ts, power_w, voltage_v, current_a, energy_kwh, source)
SELECT l.id, mo.id,
       COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', NULLIF(json_extract(t.reading, '$.timestamp'), '')), strftime('%Y-%m-%dT%H:%M:%fZ', t.received_at)),
       json_extract(t.reading, '$.power_w'),
       CASE WHEN json_type(t.reading, '$.voltage_v') IN ('integer', 'real') AND json_extract(t.reading, '$.voltage_v') >= 0 THEN json_extract(t.reading, '$.voltage_v') END,
       CASE WHEN json_type(t.reading, '$.current_a') IN ('integer', 'real') AND json_extract(t.reading, '$.current_a') >= 0 THEN json_extract(t.reading, '$.current_a') END,
       CASE WHEN json_type(t.reading, '$.energy_kwh') IN ('integer', 'real') AND json_extract(t.reading, '$.energy_kwh') >= 0 THEN json_extract(t.reading, '$.energy_kwh') END,
       'esp32'
FROM telemetry t
JOIN loads l ON l.site_id = t.site_id AND l.code = json_extract(t.reading, '$.load_id')
LEFT JOIN modules mo ON mo.id = json_extract(t.reading, '$.module_id')
WHERE json_valid(t.reading)
  AND json_type(t.reading, '$.load_id') = 'text'
  AND json_type(t.reading, '$.power_w') IN ('integer', 'real') AND json_extract(t.reading, '$.power_w') >= 0
  AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', NULLIF(json_extract(t.reading, '$.timestamp'), '')), strftime('%Y-%m-%dT%H:%M:%fZ', t.received_at)) IS NOT NULL
ON CONFLICT(load_id, ts) DO NOTHING;
