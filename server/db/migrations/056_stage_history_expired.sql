-- 054 — the pipeline keeps a lost deal's reason when it is reopened, and
-- expiry is a stage of its own (#25).
--
-- Reopening a lost quotation cleared its lost reason, notes and competitor,
-- and nothing else held them. Every stage move is now written to
-- quotation_stage_history with the loss it leaves or enters, and the
-- quotation's timeline shows the reopening with what it had been lost for.
--
-- An expired quotation was marked Lost; it now moves to Expired, a lost-type
-- stage of its own, so "lost to a competitor" and "the offer lapsed" are
-- told apart on the board and in the reasons. A status change to Lost still
-- lands on Lost, which sorts first.
CREATE TABLE IF NOT EXISTS quotation_stage_history (
  id              bigserial PRIMARY KEY,
  quotation_id    int NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  from_stage_id   int REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  to_stage_id     int REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  lost_reason_id  int REFERENCES lost_reasons(id) ON DELETE SET NULL,
  lost_notes      text,
  competitor      text,
  changed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quotation_stage_history_quotation_idx ON quotation_stage_history (quotation_id, changed_at);

INSERT INTO pipeline_stages (name, probability, type, maps_to_status, sort_order, color, rotting_days)
VALUES ('Expired', 0, 'lost', 'Lost', 8, '#9ca3af', NULL)
ON CONFLICT (name) DO NOTHING;

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
    -- Every move is kept (#25), with the loss it leaves or enters: a
    -- reopening clears the reason, notes and competitor from the quotation,
    -- and this is where they stay.
    IF TG_OP = 'UPDATE' THEN
      INSERT INTO quotation_stage_history (quotation_id, from_stage_id, to_stage_id, lost_reason_id, lost_notes, competitor)
      VALUES (NEW.id, OLD.stage_id, NEW.stage_id,
              CASE WHEN st.type = 'lost' THEN NEW.lost_reason_id ELSE OLD.lost_reason_id END,
              CASE WHEN st.type = 'lost' THEN NEW.lost_notes ELSE OLD.lost_notes END,
              CASE WHEN st.type = 'lost' THEN NEW.competitor ELSE OLD.competitor END);
    END IF;
    IF st.type IN ('won', 'lost') THEN
      NEW.closed_at := COALESCE(NEW.closed_at, now());
    ELSE
      NEW.closed_at := NULL;
    END IF;
    -- Reopened: the reason it was lost no longer applies to it; the history keeps it.
    IF st.type <> 'lost' THEN
      NEW.lost_reason_id := NULL;
      NEW.lost_notes := NULL;
      NEW.competitor := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
