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

**MCP tools** (server `klypix-canvas`, 23 tools as of klypix-mcp 1.91.0):
`brain_sync`, `brain_ask`, `brain_note`, `brain_message`,
`brain_message_receipt`, `brain_reopen`, `brain_challenge`, `brain_insights`,
`brain_lens`, `brain_connect`, `brain_reconcile`, `brain_garden`,
`brain_doctor`, `search_all_brains`, `project_map_context`, `project_map_scan`,
`project_map_drift`, `list_canvases`, `read_canvas`, `search_canvases`,
`create_canvas`, `add_to_canvas`, `canvas_view`.
*(TO CONFIRM after 1.93.0: re-count the tools for 1.93.0 and update this
list.)*

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

## What this plugin runs, reads, writes and sends

This section lists everything the plugin does. It describes klypix-mcp running
in **plugin mode**, which the plugin switches on by setting `KLYPIX_PLUGIN=1`.

### What runs

- When a Claude Code session starts, Claude Code runs
  `npx -y klypix-mcp@1.93.0`. The first time, npx downloads the `klypix-mcp`
  package, version 1.93.0 exactly, from the public npm registry; later starts
  use npm's cache. **klypix-mcp's own dependencies are resolved by npm at
  install time** within the version ranges klypix-mcp declares
  (`@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`, `jszip`,
  `zod`, `fractional-indexing`).
- The server is a small supervisor process plus one Node.js worker process. It
  talks to Claude Code over standard input and output only. **It opens no
  network port and runs no listener.**
- The plugin passes three settings: `KLYPIX_PLUGIN=1` (plugin mode),
  `KLYPIX_PLUGIN_DATA` (the plugin's data folder that Claude Code provides) and
  `KLYPIX_VAULT` (the current project folder, used as the canvas folder).
- In plugin mode the server **does not update itself**: it makes no automatic
  npm checks, installs nothing in the background, and never loads or switches
  to code in `~/.claude/project-brain`. New versions arrive only when this
  plugin is updated with a new pinned version. *(TO CONFIRM after 1.93.0.)*
- This plugin installs **no hooks**. Nothing runs at session start, on each
  prompt or at turn end except the server above.

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

Only when one of its tools is called:

- `.klypix` and `.any` canvas files in the project folder (searched up to six
  folders deep, at most 400 files), plus any canvas file you point it at by
  path.
- The project's `brain.klypix`.
- Git information about the project, through read-only `git` commands
  (`rev-parse`, `log`, `merge-base`, `tag --list`, `diff --name-only`), during
  `brain_sync` and the reconcile, drift and doctor tools.
- For the Project Map tools: the project's file list, and an existing
  `graphify-out/graph.json` or `klypix-map/graph.json` inside the project.
- For `brain_note` evidence: a hash of each project file you cite, so a later
  change to that file can be noticed.
- For `search_all_brains`: the `brain.klypix` files of other projects on this
  machine that are listed in KLYPIX's local registry.
- For `brain_doctor`: KLYPIX's own state files, and `~/.claude/settings.json`
  and Codex's KLYPIX hook entries, to report whether KLYPIX's hooks are wired.

It does not read Claude's memory or your chat history, and it does not use or
send any credential. (`brain_doctor` opens `~/.claude/settings.json` only to
look for KLYPIX's own hook entries.)

### What it writes in your project

Only when one of its tools is called:

- `brain.klypix` — through `brain_note`, `add_to_canvas`, and the apply,
  confirm or dismiss options of `brain_connect`, `brain_reconcile` and
  `brain_garden`. Each write replaces the file atomically (write to a temporary
  file, then rename), and KLYPIX keeps recent restore points of the brain.
- New `.klypix` canvases from `create_canvas` (it picks a free name and never
  overwrites a canvas), and cards added to a canvas you name with
  `add_to_canvas`.
- `.claude/brain-capture.lock`, a short-lived lock file held while the brain is
  written.
- `.claude/brain-ship-obs.json` and `.claude/brain-pending-ships.jsonl`, which
  `brain_sync` uses at the start of a task to notice releases that nobody
  recorded. *(TO CONFIRM after 1.93.0: whether plugin mode keeps these in the
  project or moves them to the plugin data folder.)*
- `klypix-map/graph.json`, only when you run `project_map_scan`.
- `.klypix/claims/<owner>.json`, only when a release claim is made with
  `publish: true` in `brain_sync`.

In plugin mode it **never writes** agent instruction or configuration files —
`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, editor rule files for Cursor, Cline,
Windsurf or Copilot, `.mcp.json`, `.codex/config.toml` and similar — not from
`brain_sync` and not from any daily maintenance pass. *(TO CONFIRM after 1.93.0.)*

### What it keeps on this machine

KLYPIX keeps machine-local coordination state so that sessions on this computer
can see each other: which sessions are active on which project and what they
declared, the notes waiting for each session, a registry of the projects that
have a brain, restore points taken before each brain write, a record of
dismissed or confirmed reconcile hints, retrieval hints recorded by
`brain_note`, and small caches.

Today this state lives in `~/.claude/project-brain/`. In plugin mode, the
plugin's own state is kept in the plugin data folder that Claude Code manages
(`~/.claude/plugins/data/…`, removed when you uninstall the plugin). The shared
session and message files stay in `~/.claude/project-brain/` so that plugin
sessions and sessions in other tools (for example Codex) on the same machine
can see each other. *(TO CONFIRM after 1.93.0: the exact split between the
plugin data folder and `~/.claude/project-brain/`.)*

### Windows, terminals and dialogs

- `brain_reopen` first asks you — with a Reopen / Not now prompt in chat where
  Claude Code supports it, otherwise a native system dialog (PowerShell on
  Windows, `osascript` on macOS, `zenity` or `kdialog` on Linux). Only if you
  say yes does it open a new, visible terminal window in that session's folder
  running `claude --resume <id>` or `codex resume <id>`. If you say no, or do
  not answer, nothing opens. It only reopens Claude Code and Codex sessions
  that have a note waiting.

### Network

- **Package download:** npx fetches `klypix-mcp@1.93.0` and its dependencies
  from the npm registry when the server first starts (and again only if npm's
  cache no longer has them).
- **Optional version check:** `brain_doctor` with `check_npm: true` runs
  `npm view klypix-mcp version`, one request to the npm registry, only when
  asked.
- **Nothing else.** No telemetry or usage reporting, no account, no sign-in,
  and no listener. The plugin never uploads your brain, canvases or notes. The
  only content that leaves this machine is what Claude itself reads through
  the tools as part of your conversation.
- Optional on-device semantic search uses a separately installed model runtime
  kept in `~/.claude/project-brain`; in plugin mode that runtime is not loaded,
  so retrieval is keyword-based. *(TO CONFIRM after 1.93.0. Without plugin
  mode, that runtime downloads two small models from Hugging Face on first
  use.)*

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
- **Works without the desktop app.** Everything above works from Claude alone.
  To *see* and rearrange a canvas, open it in the
  [KLYPIX desktop app](https://klypix.com) (Windows, optional).
- `canvas_view` returns a text summary and a layout description; do not expect
  a rendered board inside chat.
- Retrieval is keyword-based in plugin mode (see Network above). *(TO CONFIRM
  after 1.93.0.)*

## Uninstall

Remove the plugin from `/plugin`. Claude Code deletes the plugin's data folder.
Your `brain.klypix` and canvases stay in your projects. KLYPIX state in
`~/.claude/project-brain/` (if any) is not removed by uninstalling the plugin;
you can delete that folder yourself. *(TO CONFIRM after 1.93.0.)*

## Privacy, support and source

- Privacy policy: <https://klypix.com/privacy>
- Support and bug reports: <https://github.com/dahshanlabs/klypix-mcp/issues>
- Server source: <https://github.com/dahshanlabs/klypix-mcp>
- Publisher: Dahshan Labs — <https://klypix.com>

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
