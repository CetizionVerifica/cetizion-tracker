-- =====================================================================
-- 098_quotation_from_answers.sql
-- A quotation generated from a service questionnaire's answers (#208
-- phase 2, server/src/lib/serviceQuotes/CLAUDE.md §2).
--
-- quotations
--   questionnaire_response_id   the answers it was built from
--   generated_at                when its lines were last generated
-- quotation_lines
--   generated      written by a pricing rule, not typed by a person
--   rule_key       the pricing line that wrote it
--   price_needed   a rule could not price it: rate 0 until a person enters
--                  one, and the quotation cannot be sent meanwhile
--   sac_code       the pricing rule's own SAC code; null = the service's,
--                  which is how every line written before this reads
--   questionnaire_response_id
--                  the answers a generated line came from. One quotation per
--                  enquiry (spec D12): each service's questionnaire adds its
--                  own lines, so this, not the quotation's, says which
--
-- quotations.questionnaire_response_id is the response it was last
-- generated from, and generated_at when; the full list is its lines'.
--
-- A rate above 0 clears price_needed by itself (quotation_lines_price_given),
-- whichever screen or route sets it. Nothing derived is stored: "edited
-- since generated", the count of lines that need a price and the reason
-- each one does are worked out on read (views.sql, generate.js).
--
-- Existing rows: not generated, no price needed. Safe to re-run.
-- =====================================================================

ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS questionnaire_response_id int REFERENCES questionnaire_responses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS generated_at timestamptz;
CREATE INDEX IF NOT EXISTS quotations_questionnaire_response_idx
  ON quotations (questionnaire_response_id) WHERE questionnaire_response_id IS NOT NULL;

ALTER TABLE quotation_lines
  ADD COLUMN IF NOT EXISTS generated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rule_key text,
  ADD COLUMN IF NOT EXISTS price_needed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sac_code     text,
  ADD COLUMN IF NOT EXISTS questionnaire_response_id int REFERENCES questionnaire_responses(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS quotation_lines_questionnaire_response_idx
  ON quotation_lines (questionnaire_response_id) WHERE questionnaire_response_id IS NOT NULL;

CREATE OR REPLACE FUNCTION quotation_lines_price_given() RETURNS trigger AS $$
BEGIN
  IF NEW.price_needed AND NEW.rate > 0 THEN NEW.price_needed := false; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS quotation_lines_price_given ON quotation_lines;
CREATE TRIGGER quotation_lines_price_given BEFORE INSERT OR UPDATE ON quotation_lines
  FOR EACH ROW EXECUTE FUNCTION quotation_lines_price_given();
