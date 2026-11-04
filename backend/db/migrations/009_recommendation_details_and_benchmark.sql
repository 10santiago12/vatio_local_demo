-- 009: details kept with each recommendation (what the user reads) and the editable sector benchmark.
ALTER TABLE recommendations ADD COLUMN description TEXT;
ALTER TABLE recommendations ADD COLUMN evidence TEXT;                 -- JSON with the measurements behind the estimate
ALTER TABLE recommendations ADD COLUMN score_explanation TEXT;        -- plain-Spanish breakdown of the score
-- Reference consumption of a comparable business (kWh per operating day) used by the multisite comparison.
ALTER TABLE settings ADD COLUMN sector_reference_kwh_per_day REAL CHECK (sector_reference_kwh_per_day IS NULL OR sector_reference_kwh_per_day > 0);
