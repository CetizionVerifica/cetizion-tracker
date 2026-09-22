# Security: what to do on the server, and what the app does

Checked on 16 Sep 2026 (issue #34): **Postgres is published on port 55432
of the server's public address.** Anyone on the internet can try to log in
to it. Close it first; everything else here can follow.

## 1. Close the database port (server, the lead)

1. Dokploy → the `cetizion-postgres` service → **Advanced → Ports**: remove the
   published port 55432 (external). Leave the internal network as it is; the
   app reaches the database as `cetizion-postgres:5432` inside Docker.
2. Redeploy the database service. The app keeps working; if it does not, its
   `DATABASE_URL` still points at the public address: change the host to the
   internal service name and redeploy the app.
3. From a machine outside the server, check it is shut:

   ```bash
   nc -vz <server-ip> 55432
   ```

   It must fail (time out or be refused).
4. List what else is open, from outside: `nmap -Pn <server-ip>`. Only 22
   (SSH), 80 and 443 (Traefik) should answer. Close anything else in Dokploy or
   the firewall (`ufw status`).

### Reaching the database when you need to (SSH tunnel)

```bash
ssh -N -L 55432:localhost:5432 <user>@<server-ip>
```

That needs Postgres published on the server's loopback only, or a tunnel to
the container: `docker ps` to find it, then
`ssh -N -L 55432:<container-ip>:5432 <user>@<server-ip>`. Then connect to
`localhost:55432` from your machine. Use the read-only user below for looking.

## 2. Rotate every secret (the lead), in this order

Restart the app after each step and check it still signs in.

| Order | Secret | Where | Effect of changing it |
| --- | --- | --- | --- |
| 1 | Database password | Postgres (`ALTER ROLE ... PASSWORD`), then `DATABASE_URL` in Dokploy | none, once the app has the new one |
| 2 | `SESSION_SECRET` | Dokploy env; `openssl rand -base64 48` | everyone is signed out |
| 3 | `AUTH_PASSWORD` | Dokploy env; at least 14 characters (the app refuses less in production) | the team signs in with the new one |
| 4 | Cloudinary API secret | Cloudinary console → regenerate, then Dokploy env | none |
| 5 | Keys added since | `OPENROUTER_API_KEY`, `MAIL_TOKEN_KEY`*, `ZOHO_*`, `METRICS_TOKEN`, `INCOMING_WEBHOOK_SECRET`, SMTP | see below |

\* Changing `MAIL_TOKEN_KEY` makes stored mailbox tokens unreadable: connect
the mailboxes again afterwards.

Then check the old values no longer work (old database password refused, an
old session cookie gets 401).

**Where secrets live:** a team password-manager entry for each, and Dokploy's
environment as the only place the app reads them from. Never in the
repository, an issue, a commit message or a chat. CI's secret scan (gitleaks)
runs on every push.

## 3. What the app does (already in the code)

- **Sign-in protection.** Every attempt is recorded (`auth_events`). After 10
  failures from one address within 15 minutes (both in Settings) that address
  is refused, even with the right password, until the window passes, and an
  alert goes out. The per-address rate limit on failures stays in front.
- **Password rule.** In production the app will not start with an
  `AUTH_PASSWORD` shorter than 14 characters or equal to the development one,
  or a `SESSION_SECRET` shorter than 32.
- **Cookies** are httpOnly, SameSite=Lax (the client portal's is Strict and
  path-limited) and Secure in production.
- **Headers** (helmet): content security policy, HSTS for a year when cookies
  are secure, no framing (`X-Frame-Options: DENY`), referrer limited to the
  origin for other sites.
- **Logs** never contain cookies, authorization headers, one-time tokens in
  links, or the database password; the start-up line shows only host and
  database name.
- **Tokens** (acceptance links, portal links, API tokens) are stored only as
  hashes; mailbox tokens are encrypted.

## 4. Least privilege in the database

The app's user owns its schema. For anyone who only needs to look (reports,
ad-hoc questions), create a read-only user:

```bash
psql "$DATABASE_URL" -v ro_password="'<a long password>'" -f server/scripts/sql/readonly-user.sql
```

It can read every table except the ones holding secrets — mailbox tokens,
API tokens, webhook secrets, portal links and sessions, and `users`, which
holds the password hashes and the team's addresses — and its queries time
out after a minute.

## 5. Access review (every quarter)

| System | Check |
| --- | --- |
| Dokploy | who has an account; 2FA on for each |
| GitHub organisation | members and outside collaborators; 2FA required; branch protection on `main` and `production` |
| Cloudinary, Zoho, Microsoft 365 app, Sentry | who can sign in; 2FA on |
| Server SSH | `~/.ssh/authorized_keys`: one key per person, remove leavers |
| Tracker | API tokens (Settings), webhook endpoints, portal access per client |

Write the date and who did it at the bottom of this file.

## Review log

| Date | By | Notes |
| --- | --- | --- |
| | | |
