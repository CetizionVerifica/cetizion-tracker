# TypeScript, one file at a time

The tracker is moving to TypeScript without stopping to do it. There is no
big branch, no freeze, and no day where everything changes.

## How it runs

Node 24 runs `.ts` files directly: it strips the types and runs the
JavaScript underneath. **There is no build step for the server**, and
nothing to configure — `node src/start.js` and `npm test` work exactly as
before, whatever mix of `.js` and `.ts` the tree holds. Vite has always
compiled `.ts` and `.tsx` for the web app.

Because Node only removes types rather than generating code, four things
cannot be used, and `erasableSyntaxOnly` in both tsconfigs refuses them at
check time rather than at deploy time:

- `enum` — use a union of string literals, which is what `Role` does
- `namespace` holding values (a namespace of types is fine)
- parameter properties (`constructor(private x: string)`)
- decorators

Nothing in this codebase used any of them.

## What is checked, and what is not

`npm run typecheck` in `server/` and in `web/` runs the compiler with
`--noEmit`. CI runs both as the **Types** job, and the deploy waits on it.

`checkJs` is off. JavaScript files are read so a `.ts` file can import
them, but their own mistakes are not reported. Turning it on across 27,000
lines would produce a wall of errors nobody reads, and the useful ones would
be in it somewhere. **A file starts being checked when somebody converts
it**, which is the whole point of going one at a time.

## Converting a file

1. Rename `thing.js` to `thing.ts`.
2. Update the imports that name it. ESM imports carry the extension, so
   `from './thing.js'` becomes `from './thing.ts'`. `rg "thing\.js"` finds
   them.
3. Add types where the compiler asks, and only there. Resist typing the
   whole module in one go — a parameter and a return type is usually
   enough to make the next reader's editor useful.
4. `npm run typecheck`, then the tests. Nothing else changes: no build, no
   config, no import rewriting beyond step 2.

`server/src/lib/reportMath.ts`, `names.ts` and `businessDate.ts` are the
first three, kept deliberately small so the diff shows the whole shape of
a conversion.

## What to convert next

Follow the work. A module being edited for a feature or a fix is the one to
convert, because the person editing it already knows what the values are.

If you want a list anyway, these are where a wrong shape has actually cost
us something:

- `src/lib/resources.js` — the resource definitions, and the access flags
  on them. The biggest single win and the most central file, so it wants
  its own PR and a careful reviewer.
- `src/auth/*` — `req.user`, the two session shapes, and the modes.
- `src/lib/mcp/data.js` — the scoping, where a missed filter is a leak.
- The money paths: `salesReport`, `revenueReport`, `profitability`.

## The shared types

`server/src/types.ts` holds the shapes the whole server agrees on: `Role`,
`AuthMode`, `CurrentUser`, `Money`, the response envelopes and
`ResourceAccess`. Import from there rather than redeclaring, and add to it
when a shape is genuinely shared — not when it is used twice.

`CurrentUser` is worth reading before you touch anything that identifies a
person. `username` and `name` are two different spellings of somebody: the
address they sign in with, and the name the tracker records on records. A
notification addressed to one and read by the other is invisible, which is
exactly what happened in #59.
