-- =====================================================================
-- 064_report_categories.sql
-- The categories the Reports section groups sectors and services into
-- (docs/sales-report-rework-plan.md §4.3, §4.4).
--
-- Sector and service are free text on quotations and enquiries. Nothing
-- here rewrites them: these are the lookups a report reads to put each
-- spelling in a headline category.
--
-- 1. report_sectors / report_service_lines: the headline categories, in
--    the order the report lists them, as JSON arrays. "Other" is implicit.
-- 2. sector_aliases: a spelling that means one of those sectors
--    ("steel" -> Metal Industry). An exact match on the category's own
--    name needs no alias.
-- 3. services.report_line: the service line an admin puts a catalogue
--    entry in. A typed fact, not a derived one; blank means "match the
--    name against the keyword rules".
-- =====================================================================

ALTER TABLE services ADD COLUMN IF NOT EXISTS report_line text;

CREATE TABLE IF NOT EXISTS sector_aliases (
  id     serial PRIMARY KEY,
  alias  text NOT NULL CHECK (name_key(alias) IS NOT NULL),
  sector text NOT NULL CHECK (name_key(sector) IS NOT NULL)
);

-- One alias per spelling, ignoring case and spacing the way every report does.
CREATE UNIQUE INDEX IF NOT EXISTS sector_aliases_alias_key ON sector_aliases (name_key(alias));

INSERT INTO sector_aliases (alias, sector) VALUES
  ('Metal', 'Metal Industry'), ('Metals', 'Metal Industry'), ('Steel', 'Metal Industry'),
  ('Aluminium', 'Metal Industry'), ('Aluminum', 'Metal Industry'), ('Copper', 'Metal Industry'),
  ('Mining & Metals', 'Metal Industry'),
  ('Agri', 'Agriculture'), ('Agro', 'Agriculture'), ('Agrochemicals', 'Agriculture'),
  ('Pharma', 'Pharmaceutical'), ('Pharmaceuticals', 'Pharmaceutical')
ON CONFLICT DO NOTHING;

INSERT INTO settings (key, value, notes) VALUES
  ('report_sectors', '["Metal Industry","Agriculture","Pharmaceutical"]',
   'Headline sectors on the Reports page, in order. Everything else is Other. Edit under Settings -> Reports.'),
  ('report_service_lines', '["EcoVadis","ESIA","Climate Change","ESG","HSE","Sustainability","ISO certification","ASI / Copper Mark / LME","Social & supply-chain audits"]',
   'Service lines on the Reports page, in order. Everything else is Other. Edit under Settings -> Reports.')
ON CONFLICT (key) DO NOTHING;
