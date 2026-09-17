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

**6. Take a database backup**, per the project's normal deployment process.
The cutover itself writes nothing, but this is the moment you would want one.

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

One known limitation while you are here: **resetting somebody's password does
not end the sessions they already have**, because sessions carry no password
version. To cut somebody off immediately, deactivate them — that takes
effect on their very next request.
