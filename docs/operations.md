# Running the tracker: monitoring and incidents

## When something is wrong

1. **Is it up?** Open `https://<tracker>/api/health`. It answers without
   signing in. Uptime Kuma pages on it (below).
2. **What does it say about itself?** Signed in, open
   `/api/health?deep=1`: database, pending migrations, last backup and last
   restore check, every scheduled job's last run, and the job queue. It
   answers 503 when any check fails, and says which.
3. **What broke?** Error tracking (Sentry or GlitchTip) lists each error with
   the release (the deployed commit), the route and a request id. The same
   request id is on the `X-Request-Id` response header and in the logs.
4. **The logs.** Dokploy → the app → Logs. One JSON line per request:
   `req.id`, `user`, `route`, `res.statusCode`, `responseTime` (ms). Filter
   on the request id from the error.
5. **Roll back.** Production is the `production` branch; CI moves it after
   every check passes (see the CI workflow). To go back, point it at the
   previous good commit and let Dokploy redeploy:

   ```bash
   git push --force-with-lease origin <good-sha>:production
   ```

   Migrations only move forward. If the bad deploy ran a migration, the
   previous code still runs against the newer schema in almost every case
   (columns are added, not removed). If not, restore from backup
   (docs/backups.md) into a new database and point the app at it.
6. **Tell people.** The lead first, then the team channel: what is broken,
   since when, what users should do meanwhile, and when you will update.
   Afterwards, write down what happened and what will stop it next time.

## An owner says they were escalated unfairly

Follow-ups (`followups.daily`) only escalate after a reminder **left the
server**, so first find that reminder:

1. Emails & jobs → the email log, template `follow_up_reminder`, sent to the
   owner. Its status must be `sent`; anything else would not have started the
   clock. The body lists the respond-by date.
2. The cycle: `SELECT * FROM follow_up_cycles WHERE entity = '<kind>' AND
   entity_id = '<number>' ORDER BY id DESC;` shows `reminded_at`,
   `respond_by`, `escalated_at` and how it ended (`resolved_reason`).
3. What counts as activity, and its time: a touch, a chase typed by a person
   (not the reminder job: `collection_log.automated`), an outbound email on a
   linked thread, a note, a completed task, or a quotation's stage change or
   revision. It must be later than `reminded_at`. Editing the record or moving
   a date does not count.

If the escalation was wrong, the cycle resolves on the next run once anything
is logged on the record. To stop every follow-up email at once, set
`followup_enabled` to `false` in Settings.

## Error tracking

Set `SENTRY_DSN` (Sentry's free tier, or a self-hosted GlitchTip, which
speaks the same protocol) and `RELEASE` to the deployed commit (Dokploy
provides `SOURCE_COMMIT`). The API, the worker and the browser report
through the tracker's own code; no SDK is loaded. Reports carry the error,
stack, release, environment, route, request id and user name, and never
request bodies, cookies, headers, query strings, tokens, passwords or email
addresses.

Test it: with `SENTRY_DSN` set on staging, trigger an error and check it
arrives within a minute.

## Uptime

Uptime Kuma, on the same server (Dokploy → Templates → Uptime Kuma):

- **HTTP(s)** monitor on `https://<tracker>/api/health`, every 60 seconds,
  2 retries, so an outage alerts within two minutes and recovery closes it.
- **Certificate expiry** notification on the same monitor, 14 days.
- **HTTP(s) – Keyword** monitor on `/api/health?deep=1` with a header
  `Cookie` is not possible without a session, so use the metrics instead:
  a monitor on `/metrics` with `Authorization: Bearer <METRICS_TOKEN>`.
- Notifications: email, and WhatsApp or Slack.

The tracker also checks its own certificate, disk space, backups and stuck
jobs every 15 minutes (the `ops.watch` job) and raises alerts itself.

## Alerts

An alert goes to the notification centre, to the `alert_email` setting (or
`ALERT_EMAIL`), and to error tracking, at most once an hour per subject:

| Alert | When |
| --- | --- |
| Job failed | any scheduled job ends in an error |
| Job stuck | a job has been running for over an hour |
| Backup missing | no successful backup recorded for `backup_max_age_hours` (8) |
| Restore check | the weekly restore check has not passed for 8 days |
| Sign-in attack | repeated failed staff sign-ins (see docs/security.md) |
| Certificate | the site's TLS certificate expires within 14 days |
| Disk | the container's disk is over 80% full |

## Metrics

`/metrics` (Prometheus format) needs `Authorization: Bearer <METRICS_TOKEN>`
or a signed-in session. It has request rate and duration by route and
status, the database pool, job runs by result, PDF build time, alerts, and
failed sign-ins, plus Node's own process metrics.

## Attachment converter

PowerPoint and older Office attachments (`.pptx`, `.ppt`, `.pps`, `.doc`,
`.rtf`, `.odt`, `.odp`) open in the Inbox viewer as PDFs. The API does not
convert them itself: a [Gotenberg](https://gotenberg.dev) container does,
with LibreOffice inside (docs/inbox-attachments-plan.md, step 3). Until it
is set up, those files are listed with "open it in Outlook" and nothing
else changes.

Set it up once in Dokploy, as a Docker Compose service next to the tracker:

```yaml
services:
  gotenberg:
    image: gotenberg/gotenberg:8
    restart: unless-stopped
    command:
      - gotenberg
      - --chromium-disable-routes=true   # LibreOffice only; no web page rendering
      - --webhook-disable=true
      - --api-timeout=60s
      - --libreoffice-auto-start=true
    networks: [dokploy-network]
networks:
  dokploy-network:
    external: true
```

- **No domain and no published port.** Only the tracker reaches it, as
  `http://<service name>:3000` on `dokploy-network`. Set that address as
  `DOC_CONVERTER_URL` on the tracker app and redeploy it.
- **No way out.** The files it reads come from outside the company, so it
  should not reach the internet. Where the host firewall allows it, block
  the container's outbound traffic; the tracker only ever calls it, never
  the other way round.
- **Nothing is stored.** Each file is sent, converted and dropped; the PDF
  goes to the person viewing it and is not kept by the tracker either.
- It needs about 1 GB of memory under load. A conversion that takes over a
  minute, or fails, shows "could not be converted; open it in Outlook" and
  is written to the API log as `[mail] an attachment could not be converted`.
