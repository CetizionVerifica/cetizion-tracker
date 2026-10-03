# Session handoff (3 October 2026)

What the previous Claude Code session did and what is still open. Read this
first, then [PROJECT-CONTEXT.md](PROJECT-CONTEXT.md).

## Branch

- Working branch: `feat/test-app-command`. It contains the latest `origin/main`
  (merged on 3 October 2026, up to `df0b804`, PR #183) and is pushed.
- Nothing is uncommitted. No pull request is open from this branch.

## Done

1. **Follow-up reminders and escalation.**
   - The plan is [docs/follow-up-escalation-plan.md](docs/follow-up-escalation-plan.md)
     and the test plan is
     [docs/follow-up-escalation-test-plan.md](docs/follow-up-escalation-test-plan.md).
   - The feature was then built on main (issue #78, still open on GitHub). It
     is switched off until the lead turns it on.
   - Main's versions of both documents were kept in the merge, because they
     match what was built.
2. **Client presentation**, with a PlanetPulse-branded design system.
   - Deck: <https://claude.ai/artifact/8v5dQobbhnCnazqUFZKVMM>. It is a Claude
     Slides artifact, not a file in this repo.
   - Design system: <https://claude.ai/artifact/Qi6phg7sAmc5yTGP2nEMCy>,
     "PlanetPulse Design System". It holds the colours, fonts, logo and
     flower motifs taken from planetpulse.life.
   - Both are private. Share them from the page's Share menu.

## The deck

**Audience.** The boss presents it to a client. Keep it to 5 slides at most,
with plain words.

**Name.** The product is called **Sales Tracker**, not "Cetizion Tracker".
It is a PlanetPulse product.

**Slides:**

1. **Cover**: Sales *Tracker.*
2. **Problem and what we solve**: "Deals slip through the cracks" set against
   "One tracker for every sale". Added because the boss asked for a problem
   statement and a high-level view.
3. **How it's built**: an architecture diagram reading comes in → core → goes
   out. The boss asked for it. It is cream with pastel boxes, to match the
   other slides.
4. **Features**: 12 cards. Three carry a "new!" sticker: Auto enquiries,
   Insights, Smart reports. The boss says features matter most.
5. **It even does the chasing**: payment reminders, follow-up alerts
   ("Almost here!") and a "Let's talk." banner.

**Style:**

- Colours: PlanetPulse blue `#2572c0`, cream `#faf9f4`, ink `#262a2a`,
  orange `#d9700e`, yellow `#f9f341`.
- Fonts: Inter, with Instrument Serif italic for the last word of each
  heading, DM Mono for labels, and Caveat for handwritten notes.

**Preferences:**

- The user does not want every slide changed when they ask about one. Change
  only the slide they name. They have sometimes named the wrong number, so
  check which slide they are viewing.
- Slide 4 was made "funkier" and then reverted as too funky.

## Open

- **Issue #185.** The user asked to verify and test it ("closed"). It does
  not exist in `CetizionVerifica/cetizion-tracker`: the highest number is
  #183. Ask for the link or title. It may be in another repo, or it may be
  #78.
- **New plans from the boss for future work** (documents only):
  - [docs/inbox-outlook-plan.md](docs/inbox-outlook-plan.md): an Inbox like
    Outlook on the web, with full compose, two-way sync and personal
    mailboxes.
  - [docs/mis-reports-plan.md](docs/mis-reports-plan.md): the daily briefing
    and weekly MIS, sent from the tracker.
  - [docs/per-user-mailboxes-plan.md](docs/per-user-mailboxes-plan.md): each
    salesperson's own mailbox. It opens with decisions for the product owner.
- **Offered, not yet done:** add these plans to the deck as a "Coming next"
  strip on slide 5.
- **Built on main, not yet in the deck:** purchase orders and invoices read
  from email (`docs/email-po-plan.md`, built).
