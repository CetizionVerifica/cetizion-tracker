# Switching the tracker to database sign-in

How to move production from the shared password to real accounts, and how to
put it back if that goes badly.

The whole change is **one environment variable and a restart**. Nothing is
migrated, nothing is rewritten, and the rollback is the same variable set
back. That is deliberate: a cutover you cannot undo in two minutes is one
nobody should attempt on a working day.

```
AUTH_MODE=shared      AUTH_USERNAME / AUTH_PASSWORD from the environment
AUTH_MODE=database    an email and password in the users table
```

`shared` is the default. Deploying new code without touching the environment
changes nothing about how anybody signs in.

The two never help each other out. In database mode the shared password is
not a fallback; in shared mode a users row is not a second way in. Sessions
are not interchangeable either, so **switching mode signs everybody out** —
expected, and the reason to do this outside busy hours.

---

## Before the cutover

Stay on `AUTH_MODE=shared` for all of this. Production keeps working
throughout; you are only filling the users table.

**1. Sign in as you do now**, with `AUTH_USERNAME` / `AUTH_PASSWORD`.

**2. Open Settings → Users.** The shared account counts as an admin, so the
tab is there. This is the point of running both modes at once: the accounts
have to exist *before* the switch, and only somebody already signed in can
create them.

**3. Create the real admin.** Check all four:

- role **Admin**
- **Active**
- a real email address they can receive mail at
- a password you have given them out of band (at least 12 characters)

**4. Create everybody else** — sales users, and any further admins. A second
admin is worth having: the tracker refuses to let the last active admin be
deactivated or demoted, which is protection, not convenience.

**5. Run the readiness check.** Read-only; it changes nothing and prints no
secrets.

```bash
npm --prefix server run auth:check
```

```
Database authentication readiness

  Database reachable                    PASS   answered
  Users table                           PASS   4 rows
  Active database admins                PASS   2
  Sign-in credentials present           PASS   3 active accounts, all complete
  Email uniqueness (case-insensitive)   PASS   no collisions
  Email addresses usable                PASS   all parse as addresses

READY FOR AUTH_MODE=database
```

It exits non-zero when the answer is no, so a deploy pipeline can gate on
it. **Do not continue until it says READY.**

It deliberately prints counts rather than addresses — a terminal or a CI log
is a worse place to keep them than Settings → Users. To confirm *which*
accounts exist, look there.

**5b. Read the user list yourself.** `auth:check` counts; only a person can
say whether the counts are the right ones. Open **Settings → Users** and go
down it:

- [ ] at least one **active admin** — the check enforces this
- [ ] preferably **two** active admins, so losing one person is not an
      incident. The tracker refuses to deactivate or demote the last one,
      which protects you from a mistake but not from a colleague on leave.
- [ ] every **active** user has a **real email address** they can receive
      mail at — it is the thing they will type to sign in
- [ ] every **active** user has credentials: `auth:check` reports whether a
      hash is present, and the list shows whether an address is
- [ ] **no test or leftover accounts** are active — anything created while
      trying this out is a live account the moment you switch
- [ ] the **inactive** rows are inactive on purpose. Historical
      attribution-only names belong here and should stay switched off; they
      have no email and no password and cannot sign in.
- [ ] **roles are right.** Admin is not a seniority, it is who can manage
      users, run jobs, send test mail, merge companies, change the settings
      and exchange rates every report depends on, and delete companies,
      contacts, purchase orders and payment stages. Everybody else is
      sales. The full list is in
      [issue-18-authorization.md](./issue-18-authorization.md).

**6. Take a database backup.** The cutover itself writes nothing — it reads
the users table you have just filled — so this is insurance, not a
requirement of the change. Take it anyway: it is the cheapest moment to have
one, and the migration that added `session_version` ran on this database.

This repository does not own the production database credentials or the
backup schedule — those sit with the platform work (#32/#33) and with
whoever holds server access. Until that lands, here is a procedure that
works anywhere Postgres does. **Every value in angle brackets is yours to
supply**; nothing below is a real host, user or database.

```bash
# Supply these yourself. Do not paste a password on the command line —
# read it from your password manager into the environment instead, so it
# does not reach your shell history.
export PGHOST='<host>'
export PGPORT='<port>'
export PGUSER='<user>'
export PGDATABASE='<database>'
read -rs PGPASSWORD && export PGPASSWORD      # typed, not echoed

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="<backup-directory>/cetizion-${PGDATABASE}-${STAMP}.dump"

# Custom format (-Fc): compressed, and restorable table by table.
pg_dump --format=custom --no-owner --no-privileges --file="$OUT"
```

Then verify it, because an unverified backup is a belief rather than a
backup:

```bash
# 1. pg_dump reported success
echo "pg_dump exit: $?"          # must be 0

# 2. the file is there and is not empty
test -s "$OUT" && echo "OK: $(wc -c < "$OUT") bytes" || echo "FAILED: empty or missing"

# 3. the archive is readable and contains the tables you expect
pg_restore --list "$OUT" | grep -E 'TABLE (DATA )?(public )?(users|quotations|projects)' 
```

`pg_restore --list` reads the archive without restoring anything, so it is
safe to run against the file you just took. If it errors, the dump is
corrupt and you do not have a backup.

Keep the file off the database host, and treat it as it deserves: it
contains every client record and every password hash in the tracker.

```bash
unset PGPASSWORD
```

> **Restoring is not part of this runbook.** A restore replaces live data
> and is not a step in a cutover — the rollback below is one environment
> variable and needs no database change at all. If you ever do need this
> dump, restore it to a *new* database first and look at it there.

**7. Rehearse it somewhere that is not production.** Against a staging or
local database holding a copy of the accounts:

```bash
AUTH_MODE=database npm --prefix server start
```

Then sign in as the real admin. This is the step that verifies the password
actually works — the readiness check confirms a hash is *present*, and no
command anywhere asks for or prints a plaintext password. The only honest
test of a credential is using it.

---

## The cutover

Change one variable:

```
AUTH_MODE=database
```

Leave `AUTH_USERNAME` and `AUTH_PASSWORD` exactly where they are. They do
nothing in database mode, and they are the rollback.

**Remove the bootstrap variables** — before the cutover, or as part of it:

```
BOOTSTRAP_ADMIN_NAME
BOOTSTRAP_ADMIN_EMAIL
BOOTSTRAP_ADMIN_PASSWORD
```

They exist to create or recover the *first* admin, and that account now
exists and has been signed into. They are not how anybody authenticates and
never were: bootstrapping writes a row and is not consulted at sign-in.

What is left behind if you keep them is a working admin password sitting in
the production environment, held by whoever can read the deployment
configuration, rotated by nobody, and matching a live account once the mode
is database. Leaving them set also does not create a second admin later —
the seat is filled and bootstrapping will not touch it — so they buy nothing
and cost that.

Keep them somewhere you keep secrets, not in the environment. If you ever
need to recreate a first admin — a restored-from-scratch database, every
admin locked out — set them again for that one start and remove them after.

Restart / redeploy.

The container runs `migrations → bootstrap → readiness → API`. If no active
admin exists, **the API does not start** — it says so and exits, rather than
serving a tracker nobody can sign in to. It will not fall back to the shared
password to get past itself.

---

## Verifying

The quickest check needs no browser:

```bash
curl -s https://tracker.cetizionverifica.com/api/health
{"status":"ok","time":"...","started_at":"...","auth_mode":"database"}
```

The startup log says the same thing:

```
[auth] mode: database
```

Then, in the app:

- [ ] the sign-in form asks for **Email**, not Username
- [ ] the real admin signs in
- [ ] the sidebar shows their name
- [ ] Settings loads, and **Settings → Users** lists the accounts
- [ ] the main screens load — Dashboard, Quotations, Projects, Payment schedule
- [ ] sign out, sign in again
- [ ] a **sales** user signs in
- [ ] that sales user gets "no access" on Settings → Users (403)
- [ ] an **admin** user reaches Settings → Users

If every box is ticked, the cutover is done. Shared credentials stay in the
environment as the rollback until a later phase removes that code.

---

## Rolling back

If anything on that list fails, do not debug it in production. Put the old
lock back:

```
AUTH_MODE=shared
```

Restart / redeploy. Then confirm:

- [ ] `/api/health` reports `"auth_mode":"shared"`
- [ ] the form asks for **Username**
- [ ] `AUTH_USERNAME` / `AUTH_PASSWORD` sign in as before

**The rollback changes nothing in the database.** No migration, no undo, no
data touched — the accounts you created simply stop being the way in and sit
there until you try again. Everybody is signed out across the switch, in
both directions.

---

## If the API will not start

```
[auth] AUTH_MODE=database, but no active admin exists in the users table.
```

Either there was never an active admin, or the last one was deactivated or
demoted since. Two ways out:

- **Roll back** to `AUTH_MODE=shared`, restart, fix it in Settings → Users,
  and try again. This is the one to prefer.
- Or set `BOOTSTRAP_ADMIN_NAME` / `BOOTSTRAP_ADMIN_EMAIL` /
  `BOOTSTRAP_ADMIN_PASSWORD` and redeploy. Bootstrapping creates the
  **first** admin and only ever the first: if an active admin already
  exists, it does nothing at all, and it never reactivates, promotes or
  re-passwords an account that already holds that address. Setting those
  three is not a way to overwrite somebody.

```
[auth] AUTH_MODE=database, but the users table could not be read: ...
```

A database problem, not an auth one. The API is failing closed on purpose.

```
AUTH_MODE must be one of: shared, database.
```

A typo. Fix the variable; it is fatal rather than falling back, so that a
misspelling can never silently choose who may sign in.

---

## What has not happened yet

Shared sign-in is still in the code and still selectable. A later phase
removes it, along with `AUTH_USERNAME`, `AUTH_PASSWORD` and the shared
session shape. Until then this document's rollback works.

---

## Cutting somebody off

Both of these take effect on that person's **very next request**, not when
their cookie expires:

- **Reset their password** (Settings → Users → set password). Every session
  they already hold ends, and they come back with the new password.
- **Deactivate them.** Every session ends, and they cannot sign in at all.
  Reactivating them later does **not** revive the old sessions — the
  sessions revoked then stay revoked, and they sign in afresh.

Both work by raising a counter on the user's row that every signed cookie
carries a copy of; a cookie is only honoured while the two still agree. The
counter only ever goes up.

A change of *role* is immediate too, by a different route: the role is never
in the cookie, it is read from the database on every request.
