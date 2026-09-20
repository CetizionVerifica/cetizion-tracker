-- 038 — sign-in protection (#34).
--
-- Every staff sign-in attempt is recorded. An address with too many
-- failures in a short window is refused for a while, even with the right
-- password, and an alert is raised (#38).
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS auth_events (
  id          bigserial PRIMARY KEY,
  username    text,
  ip          text,
  ok          boolean NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_events_ip_idx ON auth_events (ip, created_at DESC);

INSERT INTO settings (key, value, notes) VALUES
  ('signin_lockout_failures', '10', 'Failed sign-ins from one address, within the lockout window, before it is refused and an alert is raised.'),
  ('signin_lockout_minutes', '15', 'The lockout window, in minutes.')
ON CONFLICT (key) DO NOTHING;
