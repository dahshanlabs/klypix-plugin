---
name: write-klypix
description: Build a .klypix canvas from your output with the KLYPIX MCP tools — turn a plan, breakdown, mind-map, checklist or set of notes-and-arrows into a real KLYPIX board the user opens and sees. Use whenever the user asks you to make, build or turn something into a canvas, board, mind-map or .klypix file, or when handing structured thinking (cards plus connections) back as a spatial brief rather than plain prose. The reverse of read-klypix.
---

# Writing a `.klypix` file

`write-klypix` is the reverse of `read-klypix`: instead of reading a canvas,
you build one. You describe cards (text notes), the arrows between them and,
for anything read in order, titled boxes. The `klypix-canvas` MCP server lays
them out and saves a real `.klypix` file that the user opens in the KLYPIX
desktop app (Canvas → Open).

This skill uses only the plugin's MCP tools. Do not write the file yourself.

## When to use it

- "Turn this plan / breakdown / research into a canvas / mind-map / board."
- You have reasoned through something with clear pieces and relationships, and
  a spatial hand-off beats a wall of prose.
- You read a `.klypix`, did work, and want to return the result as a canvas.

## Create a new canvas — `create_canvas`

Arguments:

- `title` — the canvas title; also the file name unless you pass `filename`.
- `cards` — each needs `text` (first line = title). Optional: `heading: true`
  for the main goal or topic, `color` as a hex value (for example `#ef4444`
  for a risk), `group` to place the card in a titled box by name.
- `connections` — `from` / `to` reference a card by index (0-based), title or
  id. Optional `relationship`: `leads_to`, `depends_on`, `relates_to`,
  `conflicts_with`, `supports`, `questions`, `costs`, `blocks`; optional
  `label`.
- `groups` — `{ title, cards: [refs in reading order], color?, columns?, width? }`.
  Each group is a titled box whose cards stack top-to-bottom in the order
  listed; boxes run left to right. Use `columns: 2` for long lists and
  `width: 520` for long prose cards.

Example (a mind-map with arrows):

```json
{
  "title": "Launch Plan",
  "cards": [
    { "text": "Goal: ship v1", "heading": true },
    { "text": "Blocker: no second PC for the collaboration test", "color": "#ef4444" },
    { "text": "Idea: agent-brief loop #brainstorm" },
    { "text": "See [[Goal: ship v1]] for the north star" }
  ],
  "connections": [
    { "from": 1, "to": 0, "relationship": "blocks" },
    { "from": 2, "to": 0, "relationship": "supports" }
  ]
}
```

Example (a checklist read in order — use `groups`):

```json
{
  "title": "Release checklist",
  "cards": [
    { "text": "Ship the release\nOne build, every item.", "heading": true },
    { "text": "1. Merge every open PR" },
    { "text": "2. Cut the release branch" },
    { "text": "3. Build and verify the installer" },
    { "text": "4. Publish" }
  ],
  "groups": [
    { "title": "Part 1 · Prepare", "cards": [1, 2] },
    { "title": "Part 2 · Ship", "cards": [3, 4], "color": "#3b82f6" }
  ]
}
```

The tool saves the file in the canvas folder — the current project folder, or
the project you last passed to `brain_sync` — and replies with the exact path.
It never overwrites an existing canvas; it picks a free name instead. Give the
user the path from the reply.

## Add to an existing canvas — `add_to_canvas`

Pass `canvas` (title, filename or absolute path), `cards`, and optional
`connections`. Existing cards keep their positions; new cards are placed to the
right. Connections may point at new cards (by index or title) or at existing
cards (by their exact title — read the canvas first with `read_canvas`).

`add_to_canvas` refuses, and writes nothing, when the canvas is open in KLYPIX
(close its tab first; project brains are the exception), when the target box is
locked from AI tools, or when it is frozen. Pass the refusal on to the user.

For the project's own `brain.klypix`, prefer the `project-brain` skill and
`brain_note`, which handle supersession and resolution.

## Verify

Call `read_canvas` on the returned path. A clean read-back means it will open
correctly in KLYPIX; grouped cards appear under their box title.

## Good practice

- **Sequence → groups. Web of ideas → connections.** The automatic layout
  follows arrows, not reading order, so steps, phases, sections and checklists
  belong in `groups`. Keep connections for real relationships, not for "next".
- Prefer short, titled cards (one idea each) over a few giant cards; 5–12
  cards suits a mind-map, a grouped checklist can be longer.
- Mark risks and blockers with a red `color`; make the goal a `heading`.
- Use `[[Card Title]]` in text to link cards by title and `#tags` to group them.
- You do not set positions; the server lays the board out.
