# Bundled klypix-mcp

This folder is the KLYPIX MCP server the plugin runs. It is a copy of
**klypix-mcp 1.112.0** (MIT, see `LICENSE` and `NOTICE`), taken from the
release tag `v1.112.0`, commit `5156221d44693df9b1b45eca1898c580ecb9b2d8`, of
[github.com/dahshanlabs/klypix-mcp](https://github.com/dahshanlabs/klypix-mcp/tree/v1.112.0).
The same release is published on npm as `klypix-mcp@1.112.0`.

The plugin starts it with:

```
node ${CLAUDE_PLUGIN_ROOT}/server/bin/klypix-mcp.mjs
```

with `KLYPIX_PLUGIN=1`, which turns on plugin mode (see the plugin README for
what plugin mode does and never does).

## What was copied

The files the server loads or names, from the release's `bin/` and `src/`
folders, at the same paths. Left out, because the plugin never uses them:

- `src/global-brain-hook.mjs`: the session hook that the standalone
  `npx klypix-mcp install` deploys. The plugin installs no hooks.
- `src/release-evidence.mjs`, `index.mjs`, and the `klypix-append`,
  `klypix-read`, `klypix-write` and `klypix-project-map` command-line tools.

## The change

`src/klypix-format.mjs` is 672 KB in the release, over the plugin directory's
256 KiB per-file review limit. It is split, without changing any of its code,
into `klypix-format.part1.mjs` to `klypix-format.part4.mjs`, and
`klypix-format.mjs` now re-exports exactly the same 229 names from them, so
every file that imports it is unchanged.

- Part 1 holds everything that runs when the module loads (constants, module
  variables, classes, top-level statements), in the original order, plus any
  function that reassigns a module variable.
- Parts 2 to 4 hold the remaining function declarations, in their original
  order.

Three lists of file names that copy the file-format engine elsewhere (the
standalone installer in `bin/klypix-install.mjs`, the git merge-driver engine in
`bin/klypix-git-tools.mjs`, and the matching check in `src/brain-doctor.mjs`)
name the four part files next to `klypix-format.mjs`, so those copies stay
complete. Plugin mode does not run the installer or set up the merge driver.

The split was checked by loading both versions and comparing their exported
names (identical), and by running klypix-mcp's full test suite on the split
copy. 156 of its 158 test files pass unchanged. The other two fail only on
checks that read the source text or a printed list of file names, which a split
changes by design: in `marker-suffix-grammar`, the check that two copies of the
suffix grammar are byte-identical and a fault-injection check that patches
`klypix-format.mjs` as text (6 assertions); in `git-tools`, two checks of the
exact wording of a file list (2 assertions).

## Dependencies

Declared with exact versions in the plugin root `package.json` and locked in
`package-lock.json` (registry address and hash for every package; no install
scripts). Claude Code installs them when it installs the plugin.
