---
name: read-klypix
description: "Read and understand a .klypix (or legacy .any) canvas file with the KLYPIX MCP tools — its cards and notes, the connection and [[wikilink]] graph, #tags, and embedded images. Use whenever the user references, drops, or asks about a .klypix or .any file, or wants you to act on a KLYPIX canvas (summarize it, build from it, answer questions about it, find what is missing)."
---

# Reading a `.klypix` file

A `.klypix` file (and the legacy `.any`) is KLYPIX's workspace format: one file
that holds a whole spatial board — text cards, images, embedded files, the
arrows between cards, `[[wikilinks]]` and `#tags`. Treat it as a connected
brief that a person, or another agent, wrote for you.

This skill uses only the tools of the `klypix-canvas` MCP server that this
plugin starts. Do not unzip the file or parse it with shell commands.

## How to read one

Call `read_canvas` with the canvas reference:

- the **absolute path** when the user gave you a file, or
- the canvas **title or filename** (for example `"Launch Plan"`), which is
  looked up in the canvas folder.

You get structured markdown — every card with its text, the connection graph,
links and tags — and the canvas's images attached so you can look at them
(up to the first 8 images, each under about 5 MB; larger canvases list the
rest by filename only).

Other read tools, when they fit better:

- `list_canvases` — which canvases exist in the canvas folder, with card and
  connection counts.
- `search_canvases` — find text or a `#tag` across every canvas in that folder.
- `canvas_view` — a text summary plus a structured layout of cards, boxes and
  arrows, for when the user asks about the board's layout. Do not promise the
  user a visual board in chat.

The canvas folder is the current project folder (or the project you last
passed to `brain_sync`), searched up to six folders deep. A file outside it can
always be read by absolute path.

## How to interpret the output

- **Cards** — the first line is the title, the rest is the body. File and image
  cards show a name; attached images can be inspected directly.
- **Connection graph** — `A → B`, optionally with a relationship such as
  `blocks` or `supports`, is an arrow the author drew. Follow it as intended
  structure.
- **`[[wikilinks]]`** point to another card by title; treat them as edges.
- **`#tags`** group related cards.
- **Boxes (areas)** — cards listed under a box title belong to that section.

When the user asks you to act, read the whole structure first — cards, graph
and images — and reason over it as one connected brief, not as isolated notes.

## Limits

- Embedded non-image files (for example a PDF inside the canvas) are listed by
  name; their contents are not returned by these tools.
- Reading never changes the file.

To build a canvas from your own output, use the `write-klypix` skill.
