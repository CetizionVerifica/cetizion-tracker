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
| `list_pipeline` | open deals with stage, owner, value, probability, weighted value, last contact |
| `list_collections` | unpaid invoices, overdue first, with recent chasing |
| `get_kpis` | quotations issued, value, wins, losses, win rate, pipeline, days to win, touches |
| `list_activity` | notes, tasks, logged calls and email threads on a record |
| `create_task`, `add_note`, `log_touch`, `update_next_step` | small writes, shown on the record as made "via MCP" |

Resources: the pipeline stages, the service catalogue, and what each KPI means.

No tool deletes anything, changes a stage or status, sends a message, or
records money. The numbers are the same queries the app uses.

## Try it

- "Which deals in Negotiation have had no contact for two weeks?"
- "What does Hetero owe us, and when did we last chase them?"
- "Summarise Priya's quarter: quoted, won, lost, win rate."
- "Add a task on CTZ/QT/2026/062 to call the client on Friday."

## Keep it inside

The endpoint needs a token, is rate limited, and is meant for use from
company machines. Do not paste tokens into chats or tickets; revoke any
token that may have been seen.
