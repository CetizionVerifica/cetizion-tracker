-- 045 — saved views, and the pinned list in the sidebar.
--
-- The redesign replaces a thirty-item sidebar with two links and a short
-- pinned list. A pinned item is a saved view: a resource, a set of filters
-- and a name, with the count of what is behind it.
--
-- The same row also backs reports. A report in this tracker is a filtered
-- list with a summary above it — collections is overdue stages by age,
-- renewals is engagements expiring soon — so a report is a view with a
-- chart named on it rather than a page of its own.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS saved_views (
  id          serial PRIMARY KEY,

  -- Which list this is a view of: the resource key the API already knows,
  -- e.g. 'quotations', 'payment-stages'. Checked against the resource
  -- registry at write time rather than by a constraint here, because the
  -- registry is the one true list and it lives in the code.
  resource    text NOT NULL,

  name        text NOT NULL,

  -- The query the list endpoint would have been given: {"status":"Overdue"}.
  -- Stored as sent, and re-validated against the resource's declared
  -- filters on every read, so a filter removed from a resource stops
  -- being applied instead of erroring.
  filters     jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Null is everybody's. A username here makes it one person's.
  owner       text,

  -- Pinned views are the sidebar. `sort_order` is their order in it.
  pinned      boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL DEFAULT 0,

  -- What the count means, so the sidebar can colour it: the four states
  -- the tracker has, or nothing for a plain count.
  tone        text CHECK (tone IN ('late', 'waiting', 'settled', 'info')),

  -- A report is a view that draws something above its table. Null is a
  -- plain list.
  chart       text,

  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One name per resource per owner: two views both called "Mine" on the
-- same list is a bug being reported later, not a feature.
CREATE UNIQUE INDEX IF NOT EXISTS saved_views_name_key
  ON saved_views (resource, lower(name), COALESCE(owner, ''));

CREATE INDEX IF NOT EXISTS saved_views_pinned_idx
  ON saved_views (pinned, sort_order) WHERE pinned;

-- The three the sidebar shipped with, now real rows people can reorder,
-- rename or unpin. Inserted only when the table is empty, so a site that
-- has already made its own is left alone.
INSERT INTO saved_views (resource, name, filters, pinned, sort_order, tone, chart)
SELECT * FROM (VALUES
  ('payment-stages', 'Overdue money', '{"stage_status":"Overdue"}'::jsonb, true, 1, 'late', 'ageing'),
  ('payment-stages', 'To invoice',    '{"stage_status":"To Invoice"}'::jsonb, true, 2, 'waiting', NULL),
  ('quotations',     'Open deals',    '{"status":"Submitted,Under Negotiation"}'::jsonb, true, 3, 'info', NULL)
) AS seed(resource, name, filters, pinned, sort_order, tone, chart)
WHERE NOT EXISTS (SELECT 1 FROM saved_views);
