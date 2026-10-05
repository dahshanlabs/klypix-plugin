# KLYPIX for Claude

**One project. One shared understanding.**

KLYPIX is a portable project workspace with a shared brain. Every project gets a
brain: a `brain.klypix` file in the project folder that holds the project's
current decisions, open questions, corrections and milestones, connected to each
other on a canvas that people and agents both read and correct.

This plugin gives Claude that brain through the open-source
[klypix-mcp](https://github.com/dahshanlabs/klypix-mcp) server (Apache-2.0). With
it, Claude can:

- **Recall where a project stands** before it starts work, including superseded
  decisions and the corrections that replaced them.
- **Record what matters** — decisions, open questions, milestones, standing
  rules — so the next session, in any tool, starts from the same understanding.
- **Coordinate with other agent sessions on this machine.** Each session
  declares what it is doing and which files it expects to touch; KLYPIX shows
  who else is active on the project and warns when declared files overlap.
- **Hand work to another session** with a one-time note instead of asking you
  to copy and paste between agents.
- **Read and build `.klypix` canvases** — turn a plan into a board, or read a
  board someone handed you.

KLYPIX does not create, launch, supervise or route agents. The one exception is
explicit: `brain_reopen` can reopen a closed Claude Code or Codex session in a
new terminal, and only after you say yes.

## Install

**From Anthropic's plugin directory:** search for **KLYPIX** and add it.

**From this repository**, in Claude Code:

```
/plugin marketplace add dahshanlabs/klypix-plugin
/plugin install klypix@klypix
```

**Requirements:** Node.js 20 or later, with `npx` on your `PATH`. The plugin
works with or without the KLYPIX desktop app.

**Getting a brain.** The brain workflow switches on in projects that contain a
`brain.klypix` at their root. To create one, run `npx klypix-mcp@1.93.0 init` in
the project folder, or use the KLYPIX desktop app. In a project without a
`brain.klypix`, the canvas tools still work and the brain workflow stays off.

## What you get

**Skills** (Claude uses them when they fit, or you can name them):

| Skill | Use it to |
|---|---|
| `klypix:project-brain` | read the brain at the start of work, record decisions, coordinate and hand off to other sessions |
| `klypix:read-klypix` | read and reason over any `.klypix` canvas |
| `klypix:write-klypix` | turn a plan, breakdown or checklist into a `.klypix` board |

**MCP tools** (server `klypix-canvas`, 25 tools):
`brain_sync`, `brain_ask`, `brain_note`, `brain_message`,
`brain_message_receipt`, `brain_reopen`, `brain_challenge`, `brain_insights`,
`brain_lens`, `brain_connect`, `brain_reconcile`, `brain_garden`,
`brain_doctor`, `search_all_brains`, `project_map_context`, `project_map_scan`,
`project_map_drift`, `list_canvases`, `read_canvas`, `read_card_contents`,
`search_canvases`, `create_canvas`, `add_to_canvas`, `canvas_view`,
`klypix_status`.

## Examples

1. *"Before you start: what did we decide about the auth refactor, and is
   anything still open?"* — Claude calls `brain_sync` for the task, then
   `brain_ask`, and answers with the cards it used, including any corrections.
2. *"Another session is working on the API. Tell it the database schema
   changed and it should rebase before committing."* — Claude sends the note
   with `brain_message` to that session and tells you whether it was delivered
   or queued.
3. *"Record that we chose server-side sessions over JWTs because of
   revocation, and close the open question about token expiry."* — Claude
   writes a decision with `brain_note` and resolves the matching question.
4. *"Turn this release plan into a board I can open in KLYPIX."* — Claude builds
   a grouped checklist with `create_canvas` and gives you the file path.
5. *"Read the research board and summarise the PDF and the photos on it."* —
   Claude reads the board with `read_canvas`, then calls `read_card_contents`
   with the card ids to get the photos and the PDF's local path.

## What this plugin runs, reads, writes and sends

This section lists everything the plugin does. It describes klypix-mcp running
in **plugin mode**. Plugin mode is switched on only by `KLYPIX_PLUGIN=1`, which
this plugin sets; it changes how the MCP server behaves and nothing else.

### What runs

- When a Claude Code session starts, Claude Code runs
  `npx -y klypix-mcp@1.93.0`. The first time, npx downloads the `klypix-mcp`
  package, version 1.93.0 exactly, from the public npm registry; later starts
  use npm's cache. **klypix-mcp's own dependencies are resolved by npm at
  install time** within the version ranges klypix-mcp declares
  (`@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`, `jszip`,
  `jpeg-js`, `zod`, `fractional-indexing`).
- The server is a small supervisor process plus one Node.js worker process. It
  talks to Claude Code over standard input and output only. **It opens no
  network port and runs no listener.**
- The plugin passes three settings: `KLYPIX_PLUGIN=1` (plugin mode),
  `KLYPIX_PLUGIN_DATA=${CLAUDE_PLUGIN_DATA}` (the plugin's data folder) and
  `KLYPIX_VAULT=${CLAUDE_PROJECT_DIR}` (the current project folder, used as the
  canvas folder). A value that still reads `${...}` because it was never filled
  in is ignored. Claude Code also passes `CLAUDE_PLUGIN_DATA` to the server
  directly, so the data folder is found either way.
- This plugin installs **no hooks**. Nothing runs at session start, on each
  prompt or at turn end except the server above.

### What plugin mode never does

- **Update itself.** It never asks npm for a newer release and never installs
  one, whatever `KLYPIX_AUTO_UPDATE` is set to. You run the version this plugin
  pins; a newer version reaches you only in a new plugin release.
- **Run code from outside the package.** It runs only the worker inside the
  pinned package. It never starts or switches to the copy that
  `npx klypix-mcp install` puts in `~/.claude/project-brain`, and it never loads
  the optional on-device semantic model, so search is keyword-only and no model
  weights are downloaded.
- **Write project config files.** It never creates or rewrites rules files,
  editor MCP configs (`.mcp.json`, `.cursor/`, `.codex/config.toml` and the
  rest) or the `AGENTS.md` brief block, in this project or any other.
- **Change Claude's settings.** It never writes `~/.claude/settings.json`,
  hooks, permissions or any other host configuration.
- **Collect data or read credentials.** It sends no telemetry or usage data and
  reads no API keys or tokens.

### What it asks Claude to do

The server sends Claude standing instructions, as MCP servers can. They ask
Claude to:

- call `brain_sync` at the start of each task in a project that has a
  `brain.klypix` (with the project folder, a one-sentence intent and the files
  it expects to touch), again when its file scope changes, and with
  `phase: "complete"` before its final answer;
- use `brain_message` to pass notes between agent sessions on this machine,
  instead of asking you to copy text from one session to another, and to offer
  `brain_reopen` if you want a closed session to pick up a note sooner;
- record only durable decisions or milestones with `brain_note`;
- never edit `brain.klypix` by hand, and ignore this workflow in a project
  without a `brain.klypix`.

### What it reads

- **In your project:** `brain.klypix`, the `.klypix` and `.any` canvases
  (searched up to six folders deep), the `version` field of `package.json`, and
  git information through read-only `git` commands (current branch, tags, log)
  for coordination and release checks. Also any canvas file you point it at by
  path; for the Project Map tools, the project's file list and an existing
  `graphify-out/graph.json` or `klypix-map/graph.json`; and for `brain_note`
  evidence, a hash of each project file you cite.
- **Files inside a canvas:** `read_card_contents` reads the copies of files that
  a saved canvas holds (see *Reading what is inside cards* below).
- **On your computer:** the coordination files listed below; for
  `search_all_brains`, the `brain.klypix` files of the projects in this
  plugin's registry; and for `brain_doctor`, `~/.claude/settings.json` (read
  only, to check whether KLYPIX's own hooks are present).
- **The KLYPIX desktop app's data folder** (`%APPDATA%/klypix` on Windows),
  read-only and only if the app is installed: to see whether the app is
  running, which canvases it has open, and the readings it saved on cards.

It never reads chat history, transcripts or Claude's memory.

### What it writes, and where

| Where | What |
|---|---|
| Your project | Only what a tool call asks for: `brain.klypix` (`brain_note` and the other brain write tools), canvases (`create_canvas`, `add_to_canvas`), `klypix-map/graph.json` when `project_map_scan` is called, and `.klypix/claims/<owner>.json` when `brain_sync` is asked to publish a release claim. During a brain write it holds `.claude/brain-capture.lock`, creating the `.claude/` folder if the project has none; the lock file is deleted after the write and the folder stays. Creating a canvas briefly holds `.klypix-create.lock` in the folder. Brain writes replace the file atomically. `create_canvas` never overwrites an existing canvas, and `add_to_canvas` refuses a canvas that is open in KLYPIX (project brains excepted, because KLYPIX merges them). |
| The plugin's data folder | Connection receipts (`.supervisors/`), the running-server heartbeat (`.running-servers.json`), the list of projects whose brains you used (`registry.json`, which `search_all_brains` reads), the last version and git tag seen in each project (`ship-observations/`), and cached copies of card files handed to Claude (`extracted/`, at most 150 MB per file). Claude Code deletes this folder when you uninstall the plugin. |
| `~/.claude/project-brain` (shared) | Presence lanes (`sessions/`), write locks (`locks/`), restore points (`history/`), and small records built from your brain: `.capture-gap.json`, and `enrichment/`, `provenance/`, `.brief-cache-*` and `.guards-*` when the tools that use them run. These are shared **on purpose**: through them a plugin session and a session in another tool (Claude Code in a terminal, Codex, Cursor, the KLYPIX app) on the same project see each other, get overlap warnings and pass notes. Restore points stay here so a brain write can still be undone after the plugin is removed. |

### Dialogs and terminal windows

`brain_reopen` first asks you — with *Reopen* and *Not now* in chat where Claude
Code supports it, otherwise a small native dialog (on Windows
`powershell -NoProfile -NonInteractive -Command`, with no execution-policy
bypass; `osascript` on macOS; `zenity` or `kdialog` on Linux). Only if you
choose *Reopen* does it open a new, visible terminal window in that session's
folder running `claude --resume <id>` or `codex resume <id>`. If you say no, or
do not answer, nothing opens. It only reopens Claude Code and Codex sessions
that have a note waiting.

### Network

Plugin mode makes two kinds of request, and both go to the public npm registry:

- **Package download:** npx fetches `klypix-mcp@1.93.0` and its dependencies
  when the plugin starts the server (and again only if npm's cache no longer
  has them).
- **Optional version check:** one `npm view klypix-mcp version`, only when
  Claude calls `brain_doctor` with `check_npm: true`.

There are no other requests: no telemetry, no account, no sign-in, no model
downloads and no listener. The plugin never uploads your brain, canvases,
notes or card files. The only content that leaves this machine is what Claude
itself reads through the tools as part of your conversation.

## Reading what is inside cards

A canvas saved by KLYPIX keeps a copy of every file dropped on it.
`read_canvas` prints every card with its id and an `Inside:` line for cards
that hold something; `read_card_contents` (up to 5 card ids per call) hands
those files to Claude as they are, so Claude reads them with its own model and
file tools. KLYPIX extracts nothing itself here — no OCR, transcription or
document-text extraction. This works with the KLYPIX app closed.

| Card | What Claude gets |
|---|---|
| Text file | Its words, fenced as data (up to 48,000 characters per answer; a longer file is cut, marked, and also given as a local path). |
| Photo | The photo itself. A photo too large for one answer comes as a smaller JPEG copy, re-encoded on your computer by the bundled pure-JavaScript `jpeg-js`, with the full-size original as a local path. |
| PDF | A local path to a cached copy — Claude Code can open it — plus KLYPIX's saved image of page 1. |
| Word, Excel, PowerPoint, other files | A local path to a cached copy, plus the preview KLYPIX saved (opening text, first rows). |
| Folder | Its file list; pass `entry_paths` (up to 8) to get those files the same way. |
| Audio, video | Only a reading KLYPIX already saved on the card (for example a transcript); otherwise a local path and a plain note that nothing says what it contains. |

Readings KLYPIX saved on a card — transcripts, OCR results, *Read contents*
cards — come back first. Cards inside a box a person locked from AI tools in
KLYPIX are never read, copied or attached. Text from cards is fenced as data,
never instructions.

## Limits

- **Coordination is machine-local.** Presence, overlap warnings and notes cover
  agent sessions for your user account on this computer. Sessions on a
  teammate's computer are not visible to this plugin.
- **Overlap warnings are advisory.** KLYPIX warns when two sessions declared the
  same file; it does not lock files or stop an edit. Matching is exact-path and
  covers only files each session declared.
- **Recording is explicit.** This plugin has no hooks, so decisions reach the
  brain when Claude calls `brain_note` (or another write tool). For automatic
  capture at the end of each Claude Code turn, use the full
  `npx klypix-mcp install` instead of this plugin.
- **Search is keyword-only** in plugin mode; the on-device semantic model is
  never loaded.
- **Whole PDFs and Office files need a file tool.** They are handed over as a
  local path. Claude Code opens them; Claude Desktop, which has no file tool of
  its own, gets only KLYPIX's saved page-1 image or preview.
- **Audio and video** are read only through a reading KLYPIX saved on the card,
  so open the canvas in KLYPIX and use *Read contents* first. This version
  starts no new readings.
- **One answer stays under 1 MB** (Claude Desktop's limit), so large photos come
  as smaller copies and at most 4 images come back per answer.
- **Works without the desktop app.** Everything above works from Claude alone.
  To *see* and rearrange a canvas, open it in the
  [KLYPIX desktop app](https://klypix.com) (Windows, optional).
- `canvas_view` returns a text summary and a layout description; do not expect
  a rendered board inside chat.

## Uninstall

Remove the plugin from `/plugin`. Claude Code removes the plugin and deletes its
data folder (including cached card files). These stay: your brain and
canvases, which belong to you; any `.claude/` folder a brain write created in a
project; and the presence lanes, write locks and restore points in
`~/.claude/project-brain`. Other KLYPIX tools on this computer share that
folder; if you use none, you can delete it.

## Privacy, support and source

- Privacy policy: <https://klypix.com/privacy>
- Support and bug reports: <https://github.com/dahshanlabs/klypix-mcp/issues>
- Server source: <https://github.com/dahshanlabs/klypix-mcp>
- Publisher: Dahshan Labs — <https://klypix.com>

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
