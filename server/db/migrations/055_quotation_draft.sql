-- 053 — a Draft quotation status (#24).
--
-- A converted enquiry used to become a Submitted quotation, as if it had
-- gone to the client. It is now a Draft, with a line per service, and
-- becomes Submitted when it is sent. The pipeline's Draft stage, which
-- mapped to Submitted, now maps to Draft, so status and stage say the same
-- thing: Draft is not sent, Submitted is.
ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_status_check;
ALTER TABLE quotations ADD CONSTRAINT quotations_status_check
  CHECK (status IN ('Draft','Submitted','Under Negotiation','Won - PO Received','Lost','On Hold'));

UPDATE pipeline_stages SET maps_to_status = 'Draft' WHERE name = 'Draft' AND maps_to_status = 'Submitted';

-- Every Submitted quotation that was not sent from the app sat in the Draft
-- stage, because that stage came first for Submitted. They were sent — typed
-- in or imported after the fact — so they move to Sent, keeping their status.
-- Straight into the columns: no stage-change stamp, no webhook for a move
-- nobody made.
ALTER TABLE quotations DISABLE TRIGGER USER;

UPDATE quotations q
   SET stage_id = s.id,
       probability = CASE WHEN q.probability IS NOT DISTINCT FROM d.probability THEN s.probability ELSE q.probability END
  FROM pipeline_stages d, pipeline_stages s
 WHERE d.name = 'Draft' AND s.name = 'Sent' AND q.stage_id = d.id AND q.status = 'Submitted';

ALTER TABLE quotations ENABLE TRIGGER USER;

-- The "Open deals" view counts a draft as open, unless someone has changed it.
UPDATE saved_views SET filters = '{"status":"Draft,Submitted,Under Negotiation"}'::jsonb
 WHERE resource = 'quotations' AND name = 'Open deals' AND filters = '{"status":"Submitted,Under Negotiation"}'::jsonb;

-- Sending a draft makes it Submitted; a revision that unsends it makes it a
-- Draft again. The rest is unchanged.
CREATE OR REPLACE FUNCTION quotation_stage_sync() RETURNS trigger AS $$
DECLARE st pipeline_stages%ROWTYPE; stage_changed boolean; status_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    stage_changed := NEW.stage_id IS NOT NULL;
    status_changed := NOT stage_changed;
  ELSE
    stage_changed := NEW.stage_id IS DISTINCT FROM OLD.stage_id AND NEW.stage_id IS NOT NULL;
    status_changed := NEW.stage_id IS NULL OR NEW.status IS DISTINCT FROM OLD.status;
  END IF;

  IF stage_changed THEN
    SELECT * INTO st FROM pipeline_stages WHERE id = NEW.stage_id;
    NEW.status := st.maps_to_status;
    IF TG_OP = 'INSERT' OR NEW.probability IS NOT DISTINCT FROM OLD.probability OR NEW.probability IS NULL THEN
      NEW.probability := st.probability;
    END IF;
  ELSIF status_changed THEN
    SELECT * INTO st FROM pipeline_stages ps
     WHERE ps.maps_to_status = NEW.status AND ps.active
     ORDER BY CASE
       WHEN NEW.status = 'Submitted' AND NEW.sent_at IS NOT NULL AND ps.name = 'Sent' THEN 0
       WHEN NEW.status = 'Under Negotiation' AND NEW.accepted_at IS NOT NULL AND ps.name = 'Verbal yes, awaiting PO' THEN 0
       ELSE 1 END, ps.sort_order
     LIMIT 1;
    IF st.id IS NOT NULL THEN
      NEW.stage_id := st.id;
      NEW.probability := st.probability;
    END IF;
  ELSE
    -- Same stage: a send or an acceptance made in this write moves it
    -- forward, and a revision (which clears both) moves it back. Only the
    -- change counts, so a card moved back by hand stays where it was put.
    SELECT * INTO st FROM pipeline_stages WHERE id = NEW.stage_id;
    IF NEW.accepted_at IS NOT NULL AND OLD.accepted_at IS NULL AND st.name IN ('Draft', 'Sent', 'Negotiation') THEN
      SELECT * INTO st FROM pipeline_stages WHERE name = 'Verbal yes, awaiting PO';
      NEW.stage_id := st.id; NEW.status := st.maps_to_status; NEW.probability := st.probability; stage_changed := true;
    ELSIF NEW.sent_at IS NOT NULL AND OLD.sent_at IS NULL AND st.name = 'Draft' THEN
      SELECT * INTO st FROM pipeline_stages WHERE name = 'Sent';
      NEW.stage_id := st.id; NEW.status := st.maps_to_status; NEW.probability := st.probability; stage_changed := true;
    ELSIF NEW.accepted_at IS NULL AND OLD.accepted_at IS NOT NULL AND st.name = 'Verbal yes, awaiting PO' THEN
      SELECT * INTO st FROM pipeline_stages WHERE name = 'Negotiation';
      NEW.stage_id := st.id; NEW.status := st.maps_to_status; NEW.probability := st.probability; stage_changed := true;
    ELSIF NEW.sent_at IS NULL AND OLD.sent_at IS NOT NULL AND st.name = 'Sent' THEN
      SELECT * INTO st FROM pipeline_stages WHERE name = 'Draft';
      NEW.stage_id := st.id; NEW.status := st.maps_to_status; NEW.probability := st.probability; stage_changed := true;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    NEW.stage_changed_at := now();
    IF st.type IN ('won', 'lost') THEN
      NEW.closed_at := COALESCE(NEW.closed_at, now());
    ELSE
      NEW.closed_at := NULL;
    END IF;
    -- Reopened: the reason it was lost no longer applies.
    IF st.type <> 'lost' THEN
      NEW.lost_reason_id := NULL;
      NEW.lost_notes := NULL;
      NEW.competitor := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
