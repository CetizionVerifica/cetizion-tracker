-- =====================================================================
-- 089_service_questionnaires.sql
-- Service questionnaires as digital client forms (#208 phase 1, §4).
--
--   questionnaires               one form per service (an admin builds it)
--   questionnaire_versions       its versions; the definition (steps,
--                                questions, show-if rules) is a validated
--                                JSON document. A published version is
--                                frozen, so old answers always match their
--                                questions. pricing is for phase 2.
--   questionnaire_responses      one client's answers for one enquiry
--   questionnaire_links          the client's link: a random token, only its
--                                SHA-256 stored, with expiry and revoke, as
--                                acceptance links are (#53)
--   questionnaire_response_files files a client uploaded into a "file"
--                                question: the documents they own, so the
--                                purge keeps them and their reach follows
--                                the enquiry
--
-- Settings: questionnaire_link_days (30), questionnaire_reminder_days (3).
-- =====================================================================

CREATE TABLE IF NOT EXISTS questionnaires (
  id          serial PRIMARY KEY,
  service_id  int  NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, name)
);

CREATE TABLE IF NOT EXISTS questionnaire_versions (
  id               serial PRIMARY KEY,
  questionnaire_id int  NOT NULL REFERENCES questionnaires(id) ON DELETE CASCADE,
  version          int  NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  definition       jsonb NOT NULL DEFAULT '{"steps":[]}',
  pricing          jsonb NOT NULL DEFAULT '{"lines":[]}',
  published_at     timestamptz,
  published_by     text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (questionnaire_id, version)
);
-- At most one published version per questionnaire.
CREATE UNIQUE INDEX IF NOT EXISTS questionnaire_versions_one_published
  ON questionnaire_versions (questionnaire_id) WHERE status = 'published';

-- A version that has left draft is frozen: its questions and pricing never
-- change under the answers given to them. Only its status moves on.
CREATE OR REPLACE FUNCTION questionnaire_version_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.definition IS DISTINCT FROM OLD.definition OR NEW.pricing IS DISTINCT FROM OLD.pricing) THEN
    RAISE EXCEPTION 'questionnaire version % is %; make a new version to change it', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'a retired questionnaire version stays retired' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS questionnaire_versions_frozen ON questionnaire_versions;
CREATE TRIGGER questionnaire_versions_frozen BEFORE UPDATE ON questionnaire_versions
  FOR EACH ROW EXECUTE FUNCTION questionnaire_version_frozen();

CREATE TABLE IF NOT EXISTS questionnaire_responses (
  id                 serial PRIMARY KEY,
  version_id         int  NOT NULL REFERENCES questionnaire_versions(id),
  enquiry_id         int  REFERENCES enquiries(id) ON DELETE SET NULL,
  company_id         int  REFERENCES companies(id) ON DELETE SET NULL,
  contact_id         int  REFERENCES contacts(id) ON DELETE SET NULL,
  answers            jsonb NOT NULL DEFAULT '{}',
  current_step       int  NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'not_started'
                       CHECK (status IN ('not_started','in_progress','submitted','reopened','withdrawn')),
  filled_by          text NOT NULL DEFAULT 'client' CHECK (filled_by IN ('client','staff','portal')),
  submitted_at       timestamptz,
  submitted_by_name  text,
  submitted_by_email text,
  -- Who sent it. Its reach follows its enquiry's owner; this is only for a
  -- response with no enquiry. Not named owner_user_id: that marks the three
  -- sales tables that carry their own owner (018).
  requested_by_user_id int REFERENCES users(id) ON DELETE SET NULL,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'submitted' OR submitted_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS questionnaire_responses_enquiry ON questionnaire_responses (enquiry_id);
CREATE INDEX IF NOT EXISTS questionnaire_responses_company ON questionnaire_responses (company_id);

CREATE TABLE IF NOT EXISTS questionnaire_links (
  id              serial PRIMARY KEY,
  response_id     int  NOT NULL REFERENCES questionnaire_responses(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  sent_to         text,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  first_opened_at timestamptz,
  last_opened_at  timestamptz,
  open_count      int  NOT NULL DEFAULT 0,
  reminded_at     timestamptz,
  reminder_count  int  NOT NULL DEFAULT 0,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS questionnaire_links_response ON questionnaire_links (response_id);

CREATE TABLE IF NOT EXISTS questionnaire_response_files (
  id            serial PRIMARY KEY,
  response_id   int  NOT NULL REFERENCES questionnaire_responses(id) ON DELETE CASCADE,
  question_key  text NOT NULL,
  document_id   int  NOT NULL UNIQUE REFERENCES documents(id),
  uploaded_by   text NOT NULL DEFAULT 'client',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS questionnaire_response_files_response ON questionnaire_response_files (response_id);

DROP TRIGGER IF EXISTS questionnaires_set_updated_at ON questionnaires;
CREATE TRIGGER questionnaires_set_updated_at BEFORE UPDATE ON questionnaires FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS questionnaire_versions_set_updated_at ON questionnaire_versions;
CREATE TRIGGER questionnaire_versions_set_updated_at BEFORE UPDATE ON questionnaire_versions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS questionnaire_responses_set_updated_at ON questionnaire_responses;
CREATE TRIGGER questionnaire_responses_set_updated_at BEFORE UPDATE ON questionnaire_responses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO settings (key, value, notes) VALUES
  ('questionnaire_link_days', '30', 'How long a questionnaire link sent to a client stays open.'),
  ('questionnaire_reminder_days', '3', 'Days after sending (and between reminders) before a client who has not submitted a questionnaire is reminded; at most two reminders. 0: never.')
ON CONFLICT (key) DO NOTHING;
