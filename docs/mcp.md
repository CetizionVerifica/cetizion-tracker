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
| `list_activity` | notes, tasks, logged calls and email threads on a record — paged |
| `list_inbox` | client emails nobody has answered: who wrote, about what, whose it is, how late — paged |
| `list_payables` | what we owe travel vendors, longest overdue first, with the total and every ageing bucket — paged |
| `list_data_gaps` | what is missing and what it is blocking, with the page that lists those rows |
| `list_tasks` | open tasks, soonest due first, with the record each is on — paged |
| `create_task`, `add_note`, `log_touch`, `update_next_step` | small writes, shown on the record as made "via MCP" |
| `complete_task` | marks a task done. `tasks` has no column for who did it; the trace is in the token log |

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
| Read a client's email | `list_inbox` gives subjects and status. Whether the team may see more than that is the mailbox owner's decision, made once, in Settings |

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
