# Asking Claude about the tracker (MCP)

The tracker runs an MCP server at `/api/mcp`, so Claude Code, Claude Desktop
and other MCP clients can answer questions from live data: this quarter's
pipeline, a client's history, overdue invoices, a sales person's numbers.

## Get a token

**Settings → Assistant access (MCP) → + Token.** Choose whose records it may
see: one sales person's (matched on the sales-person name on quotations,
enquiries and projects), or everything for an admin. The token is shown once.
Revoking it stops it at once. Every call is listed with the token's name.

## Connect

Claude Code:

```bash
claude mcp add --transport http cetizion https://tracker.cetizionverifica.com/api/mcp --header "Authorization: Bearer ctz_…"
```

Claude Desktop (Settings → Developer → Edit config), through `mcp-remote`:

```json
{
  "mcpServers": {
    "cetizion": {
      "command": "npx",
      "args": ["mcp-remote", "https://tracker.cetizionverifica.com/api/mcp", "--header", "Authorization: Bearer ${CETIZION_TOKEN}"],
      "env": { "CETIZION_TOKEN": "ctz_…" }
    }
  }
}
```

## What it can do

| Tool | What it returns or does |
| --- | --- |
| `search_records` | companies, quotations, enquiries, projects and POs matching a word |
| `get_company` | contacts, open deals, outstanding amounts, recent activity |
| `get_quotation`, `get_project`, `get_po` | one record in full |
| `list_pipeline` | open deals with stage, owner, value, probability, weighted value, last contact — paged |
| `list_collections` | unpaid invoices, overdue first, with recent chasing — paged |
| `get_kpis` | quotations issued, value, wins, losses, win rate, pipeline, days to win, touches |
| `aggregate` | count or total anything, grouped by any column — and by month, quarter or year |
| `describe_aggregate` | what can be counted, and by which columns |
| `list_renewals` | engagements coming up for renewal, soonest first |
| `get_cashflow` | cash expected in and out by month. Admin only |
| `list_activity` | notes, tasks, logged calls and email threads on a record — paged |
| `list_inbox` | client emails nobody has answered: who wrote, about what, whose it is, how late — paged |
| `list_payables` | what we owe travel vendors, longest overdue first, with the total and every ageing bucket — paged |
| `list_data_gaps` | what is missing and what it is blocking, with the page that lists those rows |
| `list_duplicate_companies` | groups of companies that may be one client spelt more than once. Read-only |
| `list_tasks` | open tasks, soonest due first, with the record each is on — paged |
| `create_task`, `add_note`, `log_touch`, `update_next_step` | small writes, shown on the record as made "via MCP" |
| `complete_task` | marks a task done. `tasks` has no column for who did it; the trace is in the token log |
| `plan_sheet_import` | read up to 500 sheet rows and plan the import — writes nothing |
| `get_import_plan`, `update_import_plan`, `replan_sheet_import` | read the plan, tick rows off, keep or replace duplicates, change the rules |
| `commit_sheet_import` | write a planned import. Admin only, and needs `confirm: true` |
| `describe_entity` | what can be fed in, and what fields each kind of record takes |
| `import_records` | rows into any of 24 kinds of record — companies, contacts, enquiries, travel logs, vendor invoices and the rest. Admin only, `dry_run` by default |

Resources: the pipeline stages, the service catalogue, and what each KPI means.

No tool deletes anything, changes a stage or status, sends a message, or
records money. The numbers are the same queries the app uses.

`list_inbox` returns subjects and status, never message bodies. A mailbox's
owner chooses what the team may see of it, and that choice is applied once
when mail arrives — so a tool that read bodies would have to apply the rest
of that rule a second time.

`list_payables` is not scoped by salesperson, because a travel vendor's bill
belongs to the company and there is no owner on it to scope by. That matches
the Payables page, which any signed-in person can already open (#89).

Two more places where a sales token sees past "only your own records". Both
are the web app's rules, carried here on purpose rather than by accident:

- **A task is readable wherever it sits** if it is assigned to you, was
  raised by you, or is on a record you can see. So a task on a colleague's
  deal, assigned to you, comes with that deal's number on it.
- **An unassigned inbox conversation is anyone's**, in any inbox. That is
  what makes "what has nobody picked up?" answerable; it also means a
  subject from an inbox you are not a member of can reach you.

## What you can ask it

Worked examples. The client names are invented; the shapes are what the tools
really return.

### Monday morning: what needs me

> **"What's overdue, who owns it, and when did we last chase?"**

One call to `list_collections`. It comes back oldest-first with the chasing log
attached, so the answer is not a list — it is a plan:

> Three invoices are overdue, ₹4,60,000 in total.
> **Aurora Chemicals** is the old one: ₹25,000, 95 days, never chased.
> **Northwind Steel** ₹3,10,000 at 41 days — last chased 12 Sep, promised
> payment by the 30th, so that one is waiting rather than ignored.
> **Calder Metals** ₹1,25,000 at 8 days, no contact yet.
> Aurora is the one to pick up: it is the only one nobody has spoken to and
> it is three months old.

Follow it with **"log that I called Aurora and they're paying Friday"** and
`log_touch` records the call against the record. It does not contact anybody —
it writes down that you did.

### Before a call

> **"Give me everything on Northwind Steel."**

`search_records` to find them, then `get_company` for one round trip that
carries contacts, open deals, what they owe and the recent history:

> Two open deals worth ₹8,40,000 — ISO 45001 in Negotiation at 60%, and a
> PCF assessment just sent. They owe ₹3,10,000 on invoice CVPL/26-27/0041,
> 41 days over, with a promise to pay by the 30th. Last contact was 12 Sep,
> a call with R. Iyer about the revised scope. There is an unanswered email
> from the 19th.

### Chasing the pipeline

> **"Which deals in Negotiation haven't been touched in two weeks?"**

`list_pipeline` with `stage: "Negotiation"`. Every deal carries its own
`last_contacted_at`, so the filtering is arithmetic rather than a second query.
Ask for **"the next page"** and it walks — `has_more` and `total` say how much
is left.

> **"Set the next step on CTZ/QT/2026/062 to send the revised scope, closing
> mid-October."**

`update_next_step`. It sets the next step and the expected close date. It
deliberately does **not** move the stage — that is a judgement with a
probability attached to it, and it belongs to a person.

### The numbers

> **"How did this quarter go?"**

`get_kpis` returns quotations issued, value, won, lost, win rate, open and
weighted pipeline, average days to win — **and the definitions alongside the
numbers**, so the answer can say what "win rate" counts rather than assuming
you and it agree.

An admin token may name a person: *"How is Ramesh doing against last quarter?"*
A sales token cannot — it only ever sees its own.

### Anything countable

> **"How many deals are we carrying per sector, and what are they worth?"**

`aggregate` is one tool for the whole class of these. Group any records by any
of their columns, count or total them:

> Chemicals is the biggest book: 14 open deals worth ₹62,40,000. Pharma has
> 9 at ₹38,10,000. Metals 6 at ₹51,90,000 — fewer deals, bigger ones.
> 91 quotations have no sector at all, which is more than any single sector
> has, so treat the split as indicative until those are filled in.

A date column can be grouped by period — `by: "quotation_date:month"` — which
is the shape most of these questions really take. Filters are the ones the
list screens take, so a figure here and a filtered list agree.

Two things it will not do. It will not read a column it was not given: the
column, the measured field and every filter are checked against the real
table first. And it will not let a sales token count what this server cannot
say the ownership of — travel bills and expense claims have no salesperson on
them, so those are admin-only rather than open.

### The money questions

> **"What's up for renewal in the next 60 days?"**

`list_renewals`, scoped to your own engagements:

> Four. **Kreative Organics** EcoVadis is due in 11 days and no renewal
> quotation has been raised yet. **Cohance** is due in 28 days with a renewal
> already out at ₹3,40,000. Two more in the fifties.
> The Kreative one is the one to move on.

> **"When is the money actually coming in?"**

`get_cashflow` — billed and unpaid, scheduled but not yet billed, the weighted
pipeline, and what we owe travel vendors and staff, by month. Admin only: it
is the company's cash position and there is no salesperson on a forecast to
scope it by.

### The inbox nobody has answered

> **"What's in the inbox that nobody's answered?"**

`list_inbox` with `unanswered_only`, which means the client wrote last and
nothing has gone back. It is ordered by when the reply was due, so the top of
the list is the most overdue:

> Four threads are waiting on us, two of them past their reply time.
> **Aurora Chemicals** — "Revised scope for the July audit", unassigned, due
> two days ago. **Northwind Steel** — "PO query", yours, due yesterday.
> The other two came in this morning and are not late yet.
> Aurora is nobody's, which is why it has sat: pick it up or assign it.

Subjects and status only. It will not read you the email.

### What we owe travel vendors

> **"What do we owe travel vendors?"**

`list_payables`, which reads the same view as the Payables page, so the figures
match what finance sees. Rupees. Every reply carries the whole debt and the
ageing, not just the rows on the page:

> ₹6,84,000 outstanding across 19 bills. ₹1,90,000 of it is over 90 days —
> six bills, all Yatra Travels. ₹3,05,000 is not yet due. Two bills have no
> amount recorded at all, so they are not in either number; somebody has to
> enter those before the total means anything.

### What is blocking invoicing

> **"What's blocking invoicing this week?"**

`list_data_gaps` runs the Data quality checks and reports only the ones that
found something, with the page that lists exactly those rows:

> Three things. Eleven invoiced payment stages have no invoice document
> attached — those are the ones that stop a client paying. Four purchase
> orders have no quotation linked, so nothing can be reconciled against them.
> Two quotations have no value, which keeps them out of the pipeline figures.
> The eleven stages are the ones to clear first.

### Importing a sheet from a conversation

> **"Here are this week's 40 deals — what would importing them do?"**

`plan_sheet_import` takes the rows as objects keyed by the sheet's own column
headings and runs them through the same planner the Import screen uses: the
same duplicate matching, the same three-way merge, the same assumptions. It
writes nothing:

> 40 rows read, 6 left out — 4 ISO proposals and 2 with no deal stage.
> It would create 28 quotations and update 6, with 9 projects, 9 POs,
> 18 payment stages and 5 invoices under the won ones.
> Nine need you: **Aurora** — the sheet moved the value from ₹24,80,000
> to ₹26,10,000 and the tracker has not moved, so that one applies.
> **Northwind** changed in both the sheet and the tracker; the tracker's
> is kept. Three POs are already on the site and will be left alone.
> Nothing is written yet.

> **"Leave Northwind out, replace the existing POs, then do it."**

`update_import_plan` unticks the row and switches the duplicate POs from keep
to replace; `commit_sheet_import` with `confirm: true` writes it. Committing
is the only irreversible step and it is the only one that needs saying twice.

### Feeding in anything else

The sheet importer above understands one shape. `import_records` takes plain
rows into any kind of record the app has a form for — 24 of them.

> **"Here are 60 companies from the trade show list."**

`describe_entity` first, to see what a company takes; then `import_records`,
which reports and writes nothing:

> 60 rows. 54 would be new. 5 are already here and would be updated —
> Aurora Chemicals would gain a GSTIN, Northwind a city. One is refused:
> row 34 has no name, and a company must be called something.
> Nothing has been written.

Fix row 34, send it again with `dry_run: false`, and it lands. Send the whole
list again next month and it updates rather than duplicating: rows are matched
on the record's own key — a company's name, a PO's number, a project's id.

Two rules worth knowing. Every row is validated by **that record's own schema,
the one behind the form**, so an import cannot slip in a value a person could
not type. And **one bad row stops the batch** — nothing is written at all,
because half an imported client list with no record of which half is worse
than none of it.

What it will not take: quotation lines, payment stages and template lines,
which their parent writes and numbers; notes, tasks and attachments, which
have their own tools that stamp the author and check the record first; and
exchange rates, which come from the rate feed.

### Writing things down

> **"Add a task on CTZ/QT/2026/062 to call them Friday, and note that legal
> wants the indemnity clause changed."**

`create_task` and `add_note`. Both land on the record's timeline marked as
made through MCP, so a week later it is clear which were typed by a person and
which came from a conversation.

> **"What are my open tasks?"** ... **"the Aurora one is done."**

`list_tasks` then `complete_task`. Soonest due first, with the record each task
sits on, so a task raised in one conversation can be found and closed in the
next. Closing one twice is closing it once — the second call says it was
already done rather than failing.

## What it will not do

Not an oversight. These are the boundary:

| | |
| --- | --- |
| Raise an invoice, record a payment, pay a vendor | The consequence is external and this cannot undo it |
| Move a deal's stage or status | A probability and a forecast hang off it |
| Mark a project milestone reached | It makes a payment stage billable — a money action in delivery clothes |
| Delete anything | — |
| Send an email or a message | `log_touch` records a call that already happened. Nothing here contacts a client |
| Import without being asked twice | Planning writes nothing; `commit_sheet_import` is a separate, admin-only tool that refuses without `confirm: true`, and `import_records` is `dry_run` until told otherwise |
| Write a record a form would refuse | Every imported row goes through that resource's own schema and save hooks — the same two functions the form posts through |
| Import without being asked twice | Planning writes nothing; `commit_sheet_import` is a separate, admin-only tool that refuses without `confirm: true` |
| Merge two companies | Finding look-alikes is the useful half and costs nothing. A merge rewrites the client name on every record of one company and deletes it, with no undo — that belongs on the Companies screen, where whoever does it can see the records about to move |
| Read a client's email | `list_inbox` gives subjects and status. Whether the team may see more than that is the mailbox owner's decision, made once, in Settings |

Bulk import is the other way in, and it keeps the same boundary by
splitting it in two. `plan_sheet_import` reads rows and writes **nothing** to
the tracker — the plan lives in its own table until somebody commits it — so
a model may plan, re-plan and pick over the result freely. `commit_sheet_import`
is the single step that writes, it is a separate tool, it refuses without
`confirm: true`, and it is admin-only, exactly as the Import screen is. A
plan started here cannot be committed from the Import screen, and one uploaded
there cannot be committed from here: two people editing one plan from two
places is how a row gets committed that neither of them chose.

Marking a task done is the one exception, and a narrow one: `complete_task`
closes a task and changes nothing else about it. It exists because
`create_task` could add one that nothing could read back, which made the
writing half of this server write-only.

A read-only token does not merely refuse the write tools — **it is not
offered them**. An MCP client plans from the list it is given, so showing a
tool that will be refused is worse than not showing it.

## What it costs

A list returns 25 rows by default and at most 100, with `offset`, `total` and
`has_more` to walk further. That is deliberate: at the old default of 200,
pretty-printed, fifty-one open deals measured 24 KB — roughly six thousand
tokens for one question.

Ask for a filter before asking for a bigger page. `stage`, `owner`,
`close_from`/`close_to`, `min_days_overdue`, `unanswered_only`, `bucket` and
`overdue_only` all narrow the query at the database rather than in the answer.

## Keep it inside

The endpoint needs a token, is rate limited, and is meant for use from
company machines. Do not paste tokens into chats or tickets; revoke any
token that may have been seen.

## The numbers are the tracker's, not the assistant's

Every figure comes from the same query the app runs, so an answer here and the
screen agree by construction. That cuts both ways: where the data is thin the
answer is thin too, and it will say so rather than guess.

Worth knowing when reading `get_kpis`: `avg_days_to_win` is measured from the
quotation's date to its win, and a deal entered after it was won — which the
imported workbook has plenty of — makes that figure negative. It is currently
**-39 days** across the year. That is a fact about how the records were
entered, not about how fast anything sells.
