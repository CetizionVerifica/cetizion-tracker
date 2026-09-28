# Handouts

Printable explainers for people who use the tracker rather than build it.

| File | For | Says |
| --- | --- | --- |
| `ask-the-tracker.pdf` | Everyone — sales, finance, delivery | What asking the tracker questions means, what it is good at, what it can be given to do, what it will not do, and how to get a key |

Three pages, A4, prints in black and white without losing anything.

## Rebuilding

`build-ask-the-tracker.py` generates it:

```bash
pip3 install reportlab
python3 docs/handouts/build-ask-the-tracker.py
```

The source is the script, not the PDF — edit the script and rebuild, or the
two drift apart and nobody knows which is current.

## Why it reads the way it does

It is written for somebody who has never heard of MCP and does not need to.
It does not use the words MCP, tool, token, API or schema: the thing they need
to understand is "you can ask the tracker questions", and every piece of
vocabulary between them and that idea is a reason to stop reading.

"Key" rather than "token", because that is what it behaves like. The client
names are invented, for the same reason the README screenshots are.

The page on what it *will not* do is not filler. It is the part that makes
somebody comfortable enough to try it: the honest answer to "can this thing
mess up my invoices" is no, and saying so plainly is worth more than another
example of what it can do.

"How much damage it could do" was added when importing arrived, and it exists
because the previous version said the worst it could do was add a note nobody
wanted. That stopped being true: an admin key can now import, and an import
writes many records at once. Reassurance that has quietly expired is worse
than no reassurance, so the page now separates a read-only key (can do
nothing), a writing key (can add a note), and an admin key (can import) — and
says plainly that the last is the one to be careful with.
