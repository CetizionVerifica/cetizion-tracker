# Cetizion Tracker

Read [PROJECT-CONTEXT.md](PROJECT-CONTEXT.md) before changing code: what the
tracker is, the stack, and how a change reaches production. Two rules hold
everywhere:

1. **Nothing derived is stored.** If a value can be calculated, compute it in
   a view (`server/db/views.sql`) or on read; never add a column for it.
2. **Each fact is typed in exactly one place.** Point at it with a foreign key
   instead of copying it.

## How the CLAUDE.md files are layered

Instructions get more specific the deeper you go. A deeper file adds to the
ones above it and wins where they disagree, but only for its own folder.

| Layer | File | Covers |
| --- | --- | --- |
| Project | this file, `PROJECT-CONTEXT.md` | Rules for every change |
| Feature spec | `docs/specs/<feature>/CLAUDE.md` | The business process, decisions, phases, acceptance criteria, open questions |
| Module | `<folder>/CLAUDE.md` beside the code | That module's data model, contracts, rules and tests for the feature |
| UI | `web/CLAUDE.md` | Every screen; a feature's UI layer adds to it, never overrides it |

When you work on a feature that has a spec, read its spec file first, then the
module file for the folder you are changing. If code and spec disagree, stop
and say so in the PR rather than silently following either; then update
whichever is wrong in the same PR.

## Feature specs

| Feature | Spec | Module layers |
| --- | --- | --- |
| Service questionnaires → quotations (#208) | [docs/specs/service-quotations/CLAUDE.md](docs/specs/service-quotations/CLAUDE.md) | [server/src/lib/serviceQuotes/CLAUDE.md](server/src/lib/serviceQuotes/CLAUDE.md), [web/src/components/serviceQuotes/CLAUDE.md](web/src/components/serviceQuotes/CLAUDE.md) |

## Before a PR

- `npm test --prefix server`; for UI changes also `npm run build`, `npm test`
  and `npm run typecheck` in `web/` (see `web/CLAUDE.md` §8).
- A schema change is a new numbered file in `server/db/migrations/`, mirrored
  in `schema.sql` (and `views.sql` for views). Migrations are never edited
  after merge.
- Every new route is declared in `server/src/lib/authz/policy.js`; the
  authorization test fails otherwise.
- No real client data in tests, seeds or screenshots.
