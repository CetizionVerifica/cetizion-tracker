# How we work on issues

The rules below keep three people working on one repository without treading on
each other. They follow what the CI/CD pipeline (PR #16) already enforces.

## Branches

| Branch | Meaning |
| --- | --- |
| `main` | Reviewed, tested code. Every push runs CI; a green push is deployed to production automatically. Never commit to it directly. |
| `production` | Moved by the deploy job only. Never touch it. |
| `issue/<number>-<short-name>` | One branch per issue, cut from the latest `main`. Example: `issue/20-companies-contacts`. |
| `feature/bulk-import` | The branch for issue #45 (bulk import), kept because it predates this convention. |

## Before touching an issue

1. Open the issue on GitHub. If it has an **assignee**, a linked **pull request**,
   or a branch named after it, it belongs to someone else: leave it.
2. Assign yourself and post one comment saying what you will build and roughly how.
   That is the claim; nobody else will start it.
3. Read the "Needs" line at the top of the issue. If it depends on an issue that
   is not merged yet, build against the merged state only and note the gap in
   the pull request.

## Working on it

```bash
git fetch origin
git switch -c issue/<number>-<short-name> origin/main
```

- One issue per branch, one pull request per issue. Do not bundle.
- Merge `origin/main` into the branch at the start, before opening the pull
  request, and whenever main moves while the pull request is open:

```bash
git fetch origin && git merge origin/main
```

- Commit messages follow the team's form: `feat:`, `fix:`, `ci:`, `docs:` and a
  short sentence. The pull request description ends with `Fixes #<number>`.

## Database changes

The pipeline rebuilds production's schema with the migrations and diffs it
against `schema.sql`, so both must always agree.

- Add a **new** file `server/db/migrations/<next number>_<name>.sql`. Never edit
  a migration that is already on `main`: the runner records a checksum and
  refuses to re-run a changed file.
- No `BEGIN` or `COMMIT` inside a migration; each one already runs in its own
  transaction.
- Make the same change in `server/db/schema.sql`, and in `views.sql` if a view
  is affected.
- Migrations run automatically when the container starts. Locally, run them
  with `npm run db:upgrade` in `server`.

## Checks before a pull request

Run all four locally. CI runs the same ones.

```bash
cd server && npm test
```

```bash
cd web && npm run build
```

```bash
TEST_DATABASE_URL=postgres://postgres:<password>@localhost:5432/postgres scripts/ci/check-migrations.sh origin/main
```

For anything that touches the importer, also run the graded workbooks (see
PROGRESS.md for what they cover); the rules score must stay at 100% and the AI
review must catch every planted case with no false flags.

## Batches and checkpoints

Issues are worked in batches of five, in the order in ISSUE-PLAN.md. Within a
batch, start with the issue the others depend on.

While the backlog is being worked through in one go, everything sits on the
local integration branch `work/all-issues`, one commit per issue, and every
five issues get a tag `checkpoint/batch-N` once the four checks are green.
Nothing is pushed until Sami says so; at that point the branch goes up for
one pull request per batch, or per issue if the lead prefers smaller reviews.

## Documents to keep current

| File | Audience | Update when |
| --- | --- | --- |
| `PROGRESS.md` | The boss. Plain language, no code. | Every pull request opened or merged, every decision taken. |
| `ISSUE-PLAN.md` | The team. Every open issue, its owner, batch and state. | Every claim, every pull request, every re-plan. |
| `WORKFLOW.md` | The team. These rules. | When a rule changes. |

## Decisions that are the lead's, not ours

- Whether and when to do the Next.js rewrite (#17). Until decided, all UI work
  stays in the current React/Vite app.
- Server access and credentials for the platform epic (#32): backups, the
  database port, staging, monitoring. We prepare the code and the runbooks; the
  lead applies them.
- Third-party accounts: SMTP mailbox, Microsoft 365 app registration,
  Cloudinary, accounting software.

## Local setup reminders

- API on port 4000, web on 5173; both started from the `.claude/launch.json`
  entries `api` and `web`, or with `npm run dev` at the root.
- `server/.env` holds the local database URL, the admin password, and
  `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` for the importer's AI review.
- `npm run reset` then `npm run seed:demo` in `server` restores the demo data.
