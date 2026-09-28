-- The workbook's own worked example (PO-77310 / PO-77455), kept
-- out of seed.sql so the real data stays clean. Optional:
--   npm run seed:demo

BEGIN;

INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, payment_terms_days, actual_initiation_date, project_manager_email, remarks) VALUES
  ('PO-77310', 'PRJ-2026-001', '2026-05-20', 250000, 30, '2026-05-25', 'diksha@cetizion.com', 'Workbook example'),
  ('PO-77455', 'PRJ-2026-001', '2026-06-02', 150000, 45, NULL, 'diksha@cetizion.com', 'Workbook example');

INSERT INTO po_services (po_number, service, service_value, remarks) VALUES
  ('PO-77310', 'GHG report preparation', 150000, 'Workbook example'),
  ('PO-77310', 'Assurance', 100000, 'Workbook example'),
  ('PO-77455', 'Supply chain audit', 150000, 'Workbook example');

INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, invoice_no, invoice_date, amount_received, remarks) VALUES
  ('PO-77310', 1, 'Advance (50%)', 'On PO Registration', 0.5, 'CTZ/INV/2026/021', '2026-05-26', 100000, 'Workbook example'),
  ('PO-77310', 2, 'On delivery (50%)', 'On Delivery', 0.5, NULL, NULL, 0, 'Workbook example'),
  ('PO-77455', 1, 'Advance (50%)', 'On PO Registration', 0.5, NULL, NULL, 0, 'Workbook example'),
  ('PO-77455', 2, 'On delivery (50%)', 'On Delivery', 0.5, NULL, NULL, 0, 'Workbook example');


-- People for the visit schedule (#42): everyone who runs projects or travels.
INSERT INTO staff (name)
SELECT DISTINCT btrim(n) FROM (SELECT project_manager AS n FROM projects UNION SELECT employee_name FROM travel_logs) x
WHERE n IS NOT NULL AND btrim(n) <> ''
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- A shared inbox with mail in it (#30).
--
-- Without this the inbox is an empty screen: syncing real mail needs a
-- Microsoft tenant, so nobody has ever seen it populated, and a feature
-- nobody can look at is a feature nobody reviews. These four threads
-- cover the states the screen has to tell apart — new business, a reply
-- on a live deal, something that is finance's, and a sender nothing
-- matches.
-- ---------------------------------------------------------------------

INSERT INTO connected_accounts (username, provider, email, display_name, is_shared, status, visibility, last_synced_at)
VALUES ('demo', 'microsoft', 'sales@cetizionverifica.com', 'Sales', true, 'active', 'share_everything', now() - interval '12 minutes')
ON CONFLICT DO NOTHING;

INSERT INTO inboxes (name, account_id, default_assignment, members, first_response_hours)
SELECT 'Sales', a.id, 'unassigned', '{}', 24 FROM connected_accounts a WHERE a.email = 'sales@cetizionverifica.com'
ON CONFLICT DO NOTHING;

WITH acct AS (SELECT id FROM connected_accounts WHERE email = 'sales@cetizionverifica.com'),
     box  AS (SELECT id FROM inboxes WHERE name = 'Sales'),
     -- Matched to real demo clients, so the company column is not a fiction.
     seed(conversation_id, subject, entity, entity_id, from_email, from_name, client, snippet, ago) AS (VALUES
       ('demo-conv-1', 'RFQ: ISO 45001 certification, Jamshedpur works', NULL, NULL,
        'r.iyer@hindalco.com', 'R. Iyer', 'Hindalco',
        'Dear Cetizion team, we are planning ISO 45001 certification for our Jamshedpur works this year. Could you share a proposal and indicative timelines?', interval '3 hours'),
       ('demo-conv-2', 'Re: quotation — board date confirmed', 'quotation', 'CTZ/QT/2026/004',
        'k.almansoori@hetero.com', 'K. Al Mansoori', 'Hetero',
        'The board meets on the 14th, so we should be able to confirm the week after. Nothing further needed from you for now.', interval '1 day'),
       ('demo-conv-3', 'Invoice CTZ/INV/2026/021 — payment advice attached', 'payment_stage', NULL,
        'accounts@midal.com', 'Accounts payable', 'Midal',
        'Please find the payment advice attached. The remittance went out on Monday and should reach you within two working days.', interval '2 days'),
       ('demo-conv-4', 'Training cost for SA8000 internal auditor?', NULL, NULL,
        'unknown@gmail.com', NULL, NULL,
        'Hello, could you tell me what an SA8000 internal auditor course costs and when the next one runs?', interval '2 days')
     ),
     threads AS (
       INSERT INTO email_threads (account_id, conversation_id, subject, company_id, entity, entity_id,
                                  first_message_at, last_message_at, message_count, last_direction)
       SELECT acct.id, s.conversation_id, s.subject, co.id, s.entity, s.entity_id,
              now() - s.ago, now() - s.ago, 1, 'inbound'
         FROM seed s
              LEFT JOIN companies co ON co.name = s.client
              CROSS JOIN acct
       RETURNING id, conversation_id, subject, company_id, last_message_at
     ),
     msgs AS (
       INSERT INTO email_messages (account_id, thread_id, provider_id, direction, from_email, from_name,
                                   to_emails, cc_emails, subject, snippet, body_html, sent_at, company_id)
       SELECT acct.id, t.id, 'demo-' || s.conversation_id, 'inbound', s.from_email, s.from_name,
              ARRAY['sales@cetizionverifica.com'], '{}', s.subject, s.snippet,
              '<p>' || s.snippet || '</p><p>Regards,<br>' || COALESCE(s.from_name, s.from_email) || '</p>',
              t.last_message_at, t.company_id
         FROM threads t
              JOIN seed s ON s.conversation_id = t.conversation_id
              CROSS JOIN acct
       RETURNING 1
     )
INSERT INTO inbox_conversations (inbox_id, thread_id, company_id, from_email, from_name, status, assignee, response_due_at)
SELECT box.id, t.id, t.company_id, s.from_email, s.from_name, 'open',
       CASE WHEN s.conversation_id = 'demo-conv-2' THEN 'Ramesh' END,
       -- Only the oldest is past its reply window: a list where every row
       -- is overdue says nothing, because the tag is what picks one out.
       CASE WHEN s.conversation_id = 'demo-conv-4' THEN now() - interval '6 hours'
            ELSE now() + interval '18 hours' END
  FROM threads t
  JOIN seed s ON s.conversation_id = t.conversation_id
  CROSS JOIN box;


COMMIT;
