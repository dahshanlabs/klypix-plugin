---
name: project-brain
description: Read and update this project's shared brain (brain.klypix) through the KLYPIX MCP tools — the project's current decisions, open questions, corrections and milestones, wired together as a canvas that humans and agents both read. Use at the START of substantial work to recall where things stand and see which other agent sessions are active on this machine, and AFTER a real decision, a finished piece of work or an important discovery, to record it. Also use when the user asks "what's the state", "what did we decide", "update the brain", "who else is working on this", or wants to hand something to another agent session.
---

# The project brain (`brain.klypix`)

`brain.klypix` at the project root is the project's **shared, current
understanding**, stored as a KLYPIX canvas: titled cards for areas, decisions,
open questions, milestones and standing rules, connected by arrows. Agents and
people read and correct the same file. A person can open it in the KLYPIX
desktop app to see and rearrange it.

Keep it **curated**: real decisions and structure, never an action-by-action
log. If it would not matter to a future session, leave it out.

Everything below uses only the tools of the `klypix-canvas` MCP server that
this plugin starts. Never edit `brain.klypix` by hand or with shell commands —
always go through the tools, which keep a restore point and take a write lock.

If the project has no `brain.klypix`, this workflow does not apply: say so
plainly. The person can create one with the KLYPIX desktop app, or by running
`npx klypix-mcp@1.94.0 init` themselves in the project folder.

## 1. Start of a task — `brain_sync`

Call `brain_sync` before you edit anything:

- `project`: the absolute path of the project root (the folder that contains
  `brain.klypix`). Always pass it — it keeps separate repositories on separate
  brains.
- `intent`: one sentence describing the task.
- `files`: the project-relative files you expect to touch (up to 20).
- `phase`: `"start"`.

The reply gives you a short, task-relevant slice of the brain, the other agent
sessions on this machine that declared work on the same project, any exact-file
overlap with what they declared, and any notes left for you. Read it before
planning.

How to treat what it tells you:

- **Overlap is a warning, not a lock.** It surfaces that another session said
  it would touch the same file. Nothing blocks your edit. Coordinate first —
  usually with `brain_message` — and tell the person what you found.
- Matching is **exact-path** and only covers sessions that declared their
  files. Silence does not mean nobody else is working nearby.
- Coordination is **machine-local**: sessions on a teammate's computer are not
  visible.

Call `brain_sync` again with `phase: "checkpoint"` when your file scope changes
materially, and with `phase: "complete"` before your final answer.

## 2. Looking things up

| Need | Tool |
|---|---|
| A question ("what did we decide about X?", "why did we drop Y?") | `brain_ask` — whole-brain, includes superseded history flagged as such, and attaches each stale card's correction |
| A keyword or `#tag` lookup | `search_canvases` |
| The same question across every project brain registered on this machine | `search_all_brains` |
| What matters / what is aging / what is undecided | `brain_insights` (`view: "areas"` for a cheap map first) or `brain_lens` (`freshness`, `provenance`, `activity`, `timeline`, `unresolved`) |
| Before committing to a significant decision | `brain_challenge` with the claim — it surfaces earlier decisions and rules that contradict it. Candidates, not verdicts |
| Do the cards still match the code? | `project_map_drift` (read-only) |
| The whole board | `read_canvas` with `"brain"` — only when the compact context from `brain_sync` is not enough |

Answer from what the tools return, and cite the cards you used.

## 3. Recording — `brain_note`

Use `brain_note` for durable things only. It runs the brain's capture engine,
so a new decision that heavily overlaps a live card in the same area
supersedes it, and resolves and corrections find their target.

| `marker` | Records |
|---|---|
| *(omit)* | a decision |
| `?` | an open question — stays visible until resolved |
| `!` | a milestone |
| `+` | a standing rule or gotcha ("always X / never Y") that resurfaces every session |
| `✓` | resolves and archives the best-matching open card |
| `~` | corrects the matching card in place |

Useful fields: `area` (routes the card into that titled box and adds a
`#tag`), `closes` (the title of the question or plan this note fulfils),
`evidence` (files, PRs, commits or URLs that support it — external references
are stored, not fetched), and `question` (the question this card answers,
phrased the way someone would ask it, so it is found later by paraphrase).

First line of `text` is the card title. One idea per note.

For a heading card or a card with explicit arrows to existing cards, use
`add_to_canvas` with `canvas: "brain"`. Read the brain first so you connect to
existing titles instead of creating duplicates. Relationships:
`leads_to`, `depends_on`, `relates_to`, `supports`, `blocks`, `questions`,
`costs`, `conflicts_with`.

## 4. Handing work to another agent session — `brain_message`

Never ask the person to copy text from one agent session to another. Send it
with `brain_message`, addressed to the session id shown by `brain_sync` (or
`brain_doctor`), and tell the person it was sent or queued.

- A live session gets the note at its next KLYPIX action.
- A closed session gets a directed note the next time it is used; the note is
  kept for up to 7 days. Notes are not written into the brain.
- When you have actually used a note you received, confirm it with
  `brain_message_receipt` (the exact message id and offer token from the note).
- If the person wants a closed Claude Code or Codex session to pick up its
  note now, offer `brain_reopen`. KLYPIX asks the person (Reopen / Not now) and
  opens a new terminal only if they say yes. If they choose "Not now", do not
  offer again unless they raise it.

## 5. Maintenance (only when asked or clearly useful)

- `brain_reconcile` — lists contradictions, unrecorded migrations and open cards
  a release already closed. Read-only unless you pass confirm/dismiss for
  entries you verified.
- `brain_connect` — proposes links for orphaned cards; draws them only with
  `apply: true`.
- `brain_garden` — consolidates dormant cards in overgrown areas. Applying needs
  an approval code that only the person can generate; never guess it.
- `brain_doctor` — read-only health check. Pass `check_npm: true` only when the
  person asks whether a newer version exists (it makes one npm registry
  request).

## Conventions

- Short, titled cards; one idea each.
- Mark blockers and risks clearly; keep open questions as `?` notes so they
  stay visible.
- Prefer correcting (`~`) or resolving (`✓`) an existing card over adding a
  near-duplicate.
- Record decisions, milestones, open questions and architecture — not routine
  edits.
