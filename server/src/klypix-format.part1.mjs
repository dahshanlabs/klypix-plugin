// klypix-format — the single source of truth for reading & writing .klypix
// (and legacy .any) canvas files. Shared by read-klypix.mjs, write-klypix.mjs,
// and klypix-mcp-server.mjs so the format logic lives in exactly one place.
//
// .klypix v4 ZIP layout: manifest.json · canvas.json · items/<prefix>/<id>.json
// · assets/<assetId>. Legacy .any (v1–v3) keeps an inline items array in
// canvas.json at the root — handled by parseKlypix too.

// Part 1 of 4 of klypix-format.mjs, split only so each file stays under the
// plugin directory's 256 KiB per-file review limit. Code unchanged; klypix-format.mjs re-exports it.
import JSZip from 'jszip';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import zlib from 'zlib';
import { generateKeyBetween } from 'fractional-indexing';
import { capturedByValue, foldArabic, itemSignature, meaningSignature, receiptIdentity, stripArabicClitic } from './klypix-format.part2.mjs';
import { classifyDecay, normalizeWrappedProse } from './klypix-format.part3.mjs';


// ── Card author identity (team attribution, 2026-08-01) ─────────────────────
// `createdBy: 'agent'` says WHAT wrote a card; on a team brain the question is
// WHOSE agent. Identity rides the same source as the dev's commits — git
// `user.name` in the project — so brain attribution matches git attribution
// with zero configuration; `KLYPIX_AUTHOR` overrides, OS account name is the
// fallback, and on total failure the field is simply absent (additive — older
// readers and older cards are untouched; merge preserves item bytes verbatim,
// so authorship survives every sync route).
let cachedAuthor;
export function resolveAuthor() {
    if (cachedAuthor !== undefined) return cachedAuthor;
    const env = String(process.env.KLYPIX_AUTHOR || '').trim();
    if (env) return (cachedAuthor = env.slice(0, 80));
    try {
        const name = execFileSync('git', ['config', 'user.name'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 })
            .toString().trim();
        if (name) return (cachedAuthor = name.slice(0, 80));
    } catch { /* not a repo / git absent — fall through */ }
    try { cachedAuthor = String(os.userInfo().username || '').slice(0, 80) || null; }
    catch { cachedAuthor = null; }
    return cachedAuthor;
}
// Test seam: clears the per-process cache so env overrides can be exercised.
export function __resetAuthorCache() { cachedAuthor = undefined; }
const authorField = () => { const a = resolveAuthor(); return a ? { author: a } : {}; };
// Who captured a card (1.109.0, additive, ignored by older readers): session,
// optional subagent child id and type, the tool, the model the host reported
// ('unknown' when it did not) and an optional role label. Client-written and
// unverified, like createdVia: it labels a card and proves nothing.
const CAPTURED_BY_KEYS = ['session', 'agent', 'agentType', 'tool', 'model', 'role'];
const capturedByField = (c) => { const v = capturedByValue(c && c.capturedBy); return v ? { capturedBy: v } : {}; };

// Valid fractional-indexing z-keys. Hand-rolled keys (e.g. 'a0000' / 'z00013')
// are REJECTED by the fractional-indexing lib the KLYPIX app uses and crash it
// the moment you edit such a canvas — so the writer MUST emit lib-valid keys.
// makeZKeyGen() returns an increasing-key generator starting just above `after`
// (or from the bottom if `after` is null/invalid).
const isValidZKey = (k) => { try { generateKeyBetween(k, null); return true; } catch { return false; } };

export const WIKILINK = /\[\[([^[\]]+)\]\]/g;
export const TAG = /(^|\s)(#[a-zA-Z][\w-]*)/g;
// ── Media cards: label + searchable body ─────────────────────────────────────
// A .klypix canvas holds eleven item types; only `text` and `container` carry
// prose. Every OTHER type (file, image, video, audio, code, link, canvas-link)
// used to parse to title=null AND text=null, because the reader looked for a
// field named `name` that NO item type declares — every media type spells it
// `fileName` (src/canvas/items/types.ts:297/379/522/539/562, written by
// dropHandler.ts:277). `it.name` was therefore dead code, and since ~30
// downstream sites gate on `(c.text || '').trim()`, a file or folder dropped
// into a brain was stored perfectly (real bytes, asset no-loss invariant) and
// was invisible to brain_ask, brain_sync, the session brief, search_canvases,
// search_all_brains, the semantic embedder, the gardener and insights.
// The human saw the card; every agent denied it existed.
//
// mediaLabel() is the card's human name. mediaText() is its SEARCHABLE body —
// for a dropped folder that means the manifest's relative paths, so "where is
// the auth migration?" can surface the folder card that contains
// migrations/0001_auth.sql. Truncation is announced, never silent (the v1.32.0
// "a truncated list must never render as a complete one" law).
const FOLDER_PATH_CAP = 200, FOLDER_TEXT_CAP = 4000;
// v4 shards item files by the first 2 hex chars of the id's random part.
export const shard = (id) => id.replace(/^[a-z]+[_:]/i, '').toLowerCase().slice(0, 2).padStart(2, '_');

// ── Card meaning and recycle-bin identity (Brain Sync Stage 2) ─────────────
// These lived in merge-brains.mjs and brain-graveyard.mjs. They moved here
// because every engine file already imports this module, so the merge, the
// bin tools, the git driver and the KLYPIX sync core can share ONE definition
// of "did this card change" and "which deletion is this" without a new module
// (a new module would have to join five copy lists) or an import cycle. Both
// old homes re-export them, so a caller written against 1.86 still links.
//
// VOLATILE = written by the act of saving, not by a human/agent decision:
//   updatedAt — touch timestamp        zIndex — display order derived from zKey
//   editedAt  — the desktop app's authored-edit stamp: an edit-then-undo cycle
//               leaves the content identical while the stamp differs.
// Everything else (content, colors, geometry, evidence, author…) stays load-
// bearing: a real edit to any of them is still a real conflict.
export const VOLATILE_ITEM_FIELDS = ['updatedAt', 'zIndex', 'editedAt'];

// READING = a card's saved reading: the words KLYPIX's own readers took out of
// the card's file — a document's text, a video's or a voice note's transcript
// or analysis (the app's READING_FIELD_KEYS, items/documentReadingFields.ts).
// Derived data, made again from the card's bytes whenever it is missing, so it
// is no part of what a card MEANS (meaningSignature, sameMeaning):
//   • two copies whose only difference is their reading are one card — no
//     conflict twin, no content conflict;
//   • a reading made on one side is not an edit, so it never brings back a
//     card the other side deleted: the delete wins.
// It IS part of a card's identity, exactly as in every engine up to 1.94:
// itemSignature — and with it bin identities (fullEntryRid, receiptIdentity),
// conflict-twin ids and revived ids — hashes the card with its reading, so a
// receipt or a twin an older engine minted names the same bytes here. A check
// of a copy against a stored identity also accepts the copy with a reading
// KLYPIX made since (holdsEntryBytes).
// A merge keeps a reading whenever it keeps the card: of two copies that mean
// the same it writes the one with the better reading (pickReadingCopy), and
// where one side's edit wins it carries the other side's reading onto it while
// that reading is still of the bytes the card holds (carryReading).
export const READING_ITEM_FIELDS = ['derivedText', 'derivedTextKind', 'derivedTextSource', 'derivedTextSha', 'derivedTextAt', 'derivedTextVisuals'];

// Key-sorted JSON, so two writers' key orders can never fake a difference.
const stableJson = (v) => JSON.stringify(v, (_k, val) =>
    (val && typeof val === 'object' && !Array.isArray(val))
        ? Object.fromEntries(Object.keys(val).sort().map(k => [k, val[k]]))
        : val);
/** The side-independent order between two different values (as stable JSON
 *  or any strings): true when the first wins. */
export const canonicalFirst = (a, b) => a > b;

// ── Readings in a merge ──────────────────────────────────────────────────────
// Which of two readings is the better one, best first: a reading with visuals
// (a video analysis, or a transcript made with the frames), then one made by
// cloud AI (it cost money; a local transcript can be made again for free), then
// the longer text; two that tie on all three go by their key-sorted JSON. From
// the two readings alone — never the base, never the side — so every machine
// and both transports pick the same one, and a merge never trades a paid or a
// richer reading for a poorer one.
const readingRank = (f) => [
    f.derivedTextKind === 'video-analysis' || f.derivedTextVisuals === true ? 1 : 0,
    f.derivedTextSource === 'cloud' ? 1 : 0,
    typeof f.derivedText === 'string' ? f.derivedText.length : 0,
];
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const readingFieldsIn = (item) => {
    const fields = {};
    for (const f of READING_ITEM_FIELDS) if (item[f] !== undefined) fields[f] = item[f];
    return fields;
};

/** True when two item JSON strings mean the same thing (volatile and reading
 *  fields aside).
 *  The single definition of "did this card actually change": the git merge
 *  driver, the merge engine and the Brain Sync core all decide with it, so all
 *  three transports agree on what an edit is. */
export const sameMeaning = (a, b) => {
    if (a === b) return true;           // fast path: byte-identical
    if (a == null || b == null) return false;
    return meaningSignature(a) === meaningSignature(b);
};

const compactText = (value, max = 140) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

const DELETION_INITIATORS = new Set(['user', 'agent', 'system', 'peer', 'unknown']);
const DELETION_CONFIDENCE = new Set(['explicit', 'inferred', 'legacy']);
const boundedToken = (value, fallback, max = 64) => {
    const clean = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
    return clean ? clean.slice(0, max) : fallback;
};

// A bin entry is its metadata in graveyard.json plus its body under
// graveyard/<shard>/<id>.json. There are three kinds:
//   F  a full entry — the deleted card's bytes, recoverable.
//   P  a purge receipt — "Delete permanently" happened; the body is an empty
//      placeholder. It must outlive the bytes, or the next merge with a copy
//      that still holds them reads the missing entry as "never deleted".
//   R  a restore receipt — the card came back (under `restoredAs`); the bytes
//      live there, so the entry keeps none.
// P and R are both `purged:true` on purpose: a Stage-1 reader (KLYPIX core
// API 5, desktop 1.3.171) treats both as purge receipts — it hides them and
// refuses to restore them, which is right for R too.
//
// The placeholder body exists because every merge drops an entry whose body
// is missing; an empty one travels like any other entry.
export const PURGED_BODY = '{"type":"text","content":"","purged":true}';
export const entryKind = (meta) => (meta && meta.purged === true)
    ? (typeof meta.restoredAs === 'string' && meta.restoredAs ? 'R' : 'P')
    : 'F';
export const isContentFreeReceipt = (meta) => !!meta && meta.purged === true;

const sha256Hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Identity ids ("rid") name a DELETION, never order one (no clock may pick a
// winner — two machines' clocks disagree). An F entry's identity comes from its
// id and meaning, so two machines that bury the same bytes agree without
// talking. A P receipt's is random: a content-free receipt must not carry a
// hash of what it purged, because a short secret could be brute-forced from it.
// An R receipt keeps its F's identity: those bytes are live again, nothing leaks.
export const fullEntryRid = (id, json) => 'r_' + sha256Hex(`${id}\n${itemSignature(json) ?? ''}`).slice(0, 16);

/** Deterministic conflict-twin id: the same conflict merged on two machines,
 *  or through git and through Brain Sync, lands on ONE twin. `n` walks to the
 *  next slot when this one is taken by something else. */
export const twinIdFor = (id, json, n = 0) =>
    `${id}__agconf_${sha256Hex((itemSignature(json) ?? '') + (n ? `\n#${n}` : '')).slice(0, 12)}`;

const REVIVED_TAIL_RE = /(__r_[0-9a-f]{12})+$/;
/** The id a deleted card comes back under. A restore, or an edit rescued from
 *  a delete, cannot reuse the old id: that id stays deleted everywhere, so no
 *  receipt is ever contradicted and an older machine sees an ordinary add. */
export const revivedIdFor = (id, meta, json) =>
    `${String(id).replace(REVIVED_TAIL_RE, '')}__r_${sha256Hex(`${id}\n${receiptIdentity(id, meta, json)}`).slice(0, 12)}`;

const ENTRY_RANK = { F: 1, R: 2, P: 3 };
const entryKey = (id, e) => {
    const kind = entryKind(e.meta);
    return [
        ENTRY_RANK[kind],
        kind === 'F' ? (itemSignature(e.json) ?? '') : receiptIdentity(id, e.meta, e.json),
        stableJson(e.meta || {}),
        String(e.json ?? ''),
    ];
};

/**
 * Atomically persist a .klypix buffer: verify it round-trips, write a sibling
 * .tmp, then rename over the target. A concurrent reader (e.g. the shared-brain
 * watcher) therefore never parses a half-written ZIP, and a failed/garbage
 * write leaves the previous good file intact. Use this for ALL brain writes
 * instead of fs.writeFileSync.
 */
// Restore points (2026-08-07). Every agent-side brain write funnels through
// atomicWrite, so this is the one place that can keep the PREVIOUS bytes before
// they are replaced — the only thing that makes an accidental card deletion,
// a destructive edit, or a stale overwrite recoverable at all. Dynamic +
// guarded: a bundle that predates brain-history.mjs must keep writing normally,
// and a snapshot failure (full disk, locked dir) must NEVER block a save.
let _historyLib;
async function loadHistoryLib() {
    if (_historyLib !== undefined) return _historyLib;
    try { _historyLib = await import(new URL('./brain-history.mjs', import.meta.url).href); }
    catch { _historyLib = null; }
    return _historyLib;
}
// Only brains get restore points: they are co-owned and written unattended (see
// brain-history.mjs). A normal canvas is one human's observed work.
const looksLikeBrain = (p) => /^brain\.(klypix|any)$/i.test(path.basename(p || ''));

// A restore point copies the whole file. Brains are always kept; an ordinary
// canvas an AI tool writes to (add_to_canvas, opts.restorePoint) is kept up to
// this size — a media canvas of hundreds of MB would otherwise put up to ~34
// full copies (newest 20 + one a day for 14 days) in the profile.
const CANVAS_RESTORE_POINT_MAX_BYTES = 64 * 1024 * 1024;
const fileSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
const RENAME_RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_BACKOFF_MS = [40, 120, 300, 700, 1500];

// ── Marker suffix grammar ─── MIRROR BEGIN ──────────────────────────────────
// ONE grammar for the optional `closes:` / `ev:` / `verify:` / `q:` / `rule:` suffixes on
// a `🧠 BRAIN` marker line. This block is byte-identical in
// global-brain-hook.mjs (which parses markers) and klypix-format.mjs (whose
// parseVerifySuffix reads a `verify:` still sitting in card prose), and
// test/marker-suffix-grammar.mjs fails if the two copies drift. Neither file
// may import the other: the hook's --live lane must never pay the format
// import, and klypix-format.mjs is copied alone beside the git merge driver.
//
// 1.86.0 split a body at the FIRST whitespace + "Q:"/"q:" in any case, so
// "Support page gets a Q: and A: layout" became the card "Support page gets
// a", and a `~` cut the same way replaced a rich card with the stub. The older
// keys had the same hazard ("see the ev: numbers", "every agent verify: the
// tag", "treats closes: links as ..."). A suffix is now recognised only where
// it cannot be prose:
//   • keys are lowercase and written `key: value`, with whitespace before the
//     key and after the colon, so "Q:", "FAQ:", "q:auth" and `npm run
//     verify:mcp` are ordinary text. Two unambiguous exceptions: no space is
//     needed before a [[wikilink]] or an ev: reference ("closes:[[X]]",
//     "ev:src/a.ts"), and `Closes:` is accepted before a [[wikilink]];
//   • suffixes form ONE run that reaches the end of the line, and the run
//     cannot start right after a word that leaves a clause open ("the ev:",
//     "a q:", "we verify:", "Always verify:", "Rule: verify:"). A single
//     capital letter and "May" are not open words, so "option A closes:" and
//     "ships in May closes:" end a clause. Particles and copulas ("stays on",
//     "as is") block every run except one that opens with a well-formed ev:
//     reference list;
//   • every value must have its key's shape: `ev:` a comma list (`,` or `،`)
//     of file / PR / run references; `verify:` a command (a known CLI, a
//     script or path, a hyphenated probe name, or a tool given a --flag) with
//     no prose connectives outside quotes; `q:` a question (a question word,
//     or a preposition + which/what, first; `?` or `؟` last); `closes:` any
//     title — capture puts a `closes:` that names no live card back into the
//     card text; `rule:` a rule-ready lesson: repo globs, then `never "…"`,
//     `never /re/`, `must "…"`, `listed-in <file>[,…]`, `keep-eol` or `costly`;
//   • a dangling key at the very end ("shipped X ev:") is dropped; a repeated
//     ev: joins its references.
// A run whose FIRST segment breaks a rule is not a suffix run: parsing moves on
// to the next key, and when none qualifies the whole line stays the card body,
// untouched. Once a run has a well-formed ev: / verify: / q: segment it IS a
// suffix run, so a later malformed segment goes back into the card text
// (`kept`) and the well-formed ones still count — one bad value never cancels
// the rest. A `closes:` alone never proves a run (its value is free text),
// unless its whole value is one [[wikilink]].
// `closesAnchored` says the closes: is unmistakably a suffix, judged ONLY by
// what comes before it or by its own value: it follows a clause boundary,
// follows another well-formed suffix, or is exactly one [[wikilink]]. A
// well-formed ev: AFTER a prose "closes:" proves nothing about the closes:
// ("The resolver now treats closes: targets as exact titles ev: src/x.mjs"
// is still prose), and capture only lets an UNanchored one close a card it
// names by title.
const MARKER_SUFFIX_KEYS = ['closes', 'ev', 'verify', 'q', 'rule'];
const MARKER_SUFFIX_KEY_RE = new RegExp(`(?<=\\s)(${MARKER_SUFFIX_KEYS.join('|')}|Closes):`, 'g');
const MARKER_SUFFIX_OPEN_WORDS = new Set([
    'a', 'an', 'the', 'this', 'that', 'these', 'those', 'its', 'their', 'our', 'my', 'your', 'every', 'each', 'any', 'some', 'no', 'not',
    'of', 'to', 'than', 'via', 'per',
    'and', 'or', 'nor', 'but', 'if', 'whether', 'because', 'so', 'then', 'when', 'while', 'where', 'which', 'who',
    'I', 'we', 'they', 'he', 'she',
    'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
    'always', 'never', 'also', 'just', 'please',
    'في', 'من', 'على', 'إلى', 'الى', 'عن', 'مع', 'أو', 'او', 'ثم', 'هذا', 'هذه', 'ذلك', 'تلك', 'كل',
]);
const MARKER_SUFFIX_SOFT_WORDS = new Set([
    'in', 'on', 'at', 'for', 'with', 'by', 'from', 'into', 'onto', 'about', 'like', 'as', 'off', 'up', 'out', 'over',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'you', 'one',
]);
const MARKER_SUFFIX_CLI = new Set([
    'gh', 'git', 'npm', 'npx', 'node', 'pnpm', 'yarn', 'bun', 'deno', 'corepack', 'curl', 'wget', 'pwsh', 'powershell',
    'cmd', 'bash', 'sh', 'zsh', 'python', 'python3', 'py', 'pip', 'pip3', 'uv', 'cargo', 'go', 'make', 'docker',
    'kubectl', 'helm', 'az', 'aws', 'gcloud', 'vercel', 'netlify', 'supabase', 'firebase', 'dotnet', 'mvn', 'gradle',
    'swift', 'xcodebuild', 'xcrun', 'fastlane', 'jq', 'rg', 'grep', 'cat', 'ls', 'cd', 'echo', 'tsc', 'vitest',
    'jest', 'eslint', 'psql', 'sqlite3', 'ssh', 'openssl', 'wsl',
]);
// Connectives a command line never needs outside a quoted argument: a verify:
// value carrying one is a sentence ("npm view x version matches the tag").
const MARKER_SUFFIX_PROSE = new Set([
    'the', 'before', 'after', 'when', 'whenever', 'while', 'as', 'matches', 'then', 'that', 'which', 'because',
    'should', 'must', 'is', 'are', 'was', 'were', 'until', 'unless', 'instead',
]);
const MARKER_SUFFIX_QUESTION_LEAD = /^(?:(?:how|what|why|where|when|which|who|whom|whose|whether|can|could|should|would|will|shall|may|might|must|do|does|did|is|are|was|were|has|have|had|am)(?:n['’]t)?|won['’]t|(?:on|in|at|for|to|from|by|with|into|onto|of|about|under|after|before)\s+(?:which|what|whom|whose)|هل|ما|ماذا|لماذا|لما|كيف|أين|اين|متى|من|كم|أي|أية|لم|ماهي|ماهو|وين|ليش|ليه|شو|إيش|ايش|أيش|مين|منين|إمتى|امتى|إزاي|ازاي)(?![\p{L}\p{N}])/iu;
// Direction marks and Arabic vowel marks are invisible, so they never decide
// a shape: a question that ends in ؟ followed by a right-to-left mark, or one
// written with vowel marks (كَيْفَ), is still a question.
const MARKER_SUFFIX_INVISIBLE = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u064B-\u065F\u0670\u0640]/g;
const MARKER_SUFFIX_DIRECTION = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;   // stripped from the stored q: too
const MARKER_SUFFIX_BOUNDARY = /[.!?;)\]✓✅…—–؛؟]$/u;
const MARKER_SUFFIX_BARE_FILES = /^(?:Makefile|Dockerfile|Procfile|Gemfile|Rakefile|Jenkinsfile|Vagrantfile|Brewfile|Justfile|LICENSE|README|NOTICE|CHANGELOG|CODEOWNERS|AUTHORS|COPYING)$/;
const MARKER_SUFFIX_WIKILINK = /^\[\[[^\][]+\]\][.,;!]?$/;
// rule: <glob>[,<glob>] then one check. A glob is a path, a glob or a file
// name (a slash, a *, or an extension); anything else is prose.
const MARKER_SUFFIX_RULE = /^([^\s,]+(?:\s*,\s*[^\s,]+)*)\s+(never\s+(?:"[^"]+"|\/(?:\\.|[^/\\])+\/[a-z]*)|must\s+"[^"]+"|listed-in\s+[^\s,]+(?:\s*,\s*[^\s,]+)*|keep-eol|costly)$/;


export const scopeLockLine = (box) =>
    `${box.count} card${box.count === 1 ? '' : 's'} inside the box '${box.title}' ${box.count === 1 ? 'is' : 'are'} hidden from AI tools (a person locked it in KLYPIX).`;

// ── Content fence (P0 agent parity) ──────────────────────────────────────────
// Text from a card, page, reel or file is DATA. It is fenced so a model reads
// it as such, and any line in it that could pass for KLYPIX speaking to the
// person ("Tell the user: …") or close the fence early is escaped. Authorship
// is what the card records (createdBy / createdVia / author): client-written
// and unverified, so it labels the text and proves nothing.
const INSTRUCTION_LINE = /^(\s*)(tell the user\s*:|\[end of content from card|\[content from card)/i;

// ── Saved readings (P0 agent parity) ─────────────────────────────────────────
// What KLYPIX has already read, from the saved file alone:
//   • derivedText on a media card (transcript / analysis / image understanding);
//   • derivedText on a document's file card (its text, kind 'document-text'),
//     only while its derivedTextSha names the bytes the card holds;
//   • a Read contents result: a text card tagged `link` (+ `partial`), with an
//     arrow FROM the link card TO it (KlypixCanvas readLinkContents);
//   • an OCR result: a text card tagged `ocr`, arrowed from the image.
// The link tier is decided from the URL exactly as the app's linkKinds.ts does,
// only to NAME how the saved reading was made.
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?|shorts\/|live\/|embed\/)|youtu\.be\/)/i;
const GIST_HOSTS = [
    [/(^|\.)instagram\.com$/i, 'Instagram', /^\/(reel|reels|p|tv|share)\//i],
    [/(^|\.)tiktok\.com$/i, 'TikTok', /(^\/@[^/]+\/(video|photo)\/)|(^\/t\/)|(^\/v\/)/i],
    [/(^|\.)facebook\.com$/i, 'Facebook', /^\/(watch|reel|video|share\/[rv])\b|\/videos?\//i],
];
const GIST_SHORTLINK_HOSTS = [[/^vm\.tiktok\.com$/i, 'TikTok'], [/^vt\.tiktok\.com$/i, 'TikTok'], [/(^|\.)fb\.watch$/i, 'Facebook']];

const itemTagsLower = (item) => (Array.isArray(item?.tags) ? item.tags.map((t) => String(t).toLowerCase()) : []);

// A DOCUMENT's reading (the KLYPIX app's agent/documentReading.ts): the text
// KLYPIX extracted from a file card — PDF, Word, Excel, text, code — saved on
// the card as derivedText with derivedTextKind 'document-text',
// derivedTextSource 'local' and derivedTextSha: the bytes it was read from,
// named by the card's assetSha, else its assetId (an asset id's bytes change
// only through a repack, and a repack stamps assetSha). It carries no
// derivedTextAt, so two machines reading the same bytes write the same fields.
// The reading is CURRENT only while the card still holds those bytes. KLYPIX
// drops it when the bytes change, but a file written by an older KLYPIX or by
// another program can still carry one of earlier bytes, and no reader here
// serves that as what the file says. These are the app's own rules
// (items/documentReadingFields.ts), restated so this module stays standalone.
export const DOCUMENT_TEXT_KIND = 'document-text';

const SECRET_FILE_EXTENSIONS = new Set(['env', 'pem', 'key', 'p12', 'pfx', 'keystore', 'npmrc', 'netrc', 'htpasswd']);

const DERIVED_KIND_LABEL = {
    'image-understanding': 'image understanding',
    'audio-transcript': 'audio transcript',
    'video-transcript': 'video transcript',
    'video-analysis': 'video analysis',
    'document-text': 'document text',
};
const ymd = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString().slice(0, 10) : null);

// 'not_contradiction' is a DISMISSAL edge, not a topical relation: an agent draws
// it between two cards a reconcile pass flagged as a FALSE contradiction, and
// detectContradictions then treats the pair as settled forever (the persisted
// dismiss path the correction-cue false-positive previously lacked).
// 'not_fulfilled' is its twin for the claim engine — and its ABSENCE here was a
// silent critical: every fulfillment surface has told users to dismiss a wrong
// ⏳ hint with brain_connect relationship:"not_fulfilled" since 1.31.0, but this
// allowlist coerced it to 'relates_to', so the stored edge never matched any
// settled-set check. The tool reported "✓ Drew 1 connection(s)" and the
// dismissed hint came back on the very next render, forever. Every claim-engine
// test passed because the fixtures fabricate the connection object directly and
// never round-trip it through this writer (2026-07-29 review, CONFIRMED).
export const DISMISSAL_RELS = new Set(['not_contradiction', 'not_fulfilled']);
const REL = new Set(['leads_to', 'depends_on', 'relates_to', 'conflicts_with', 'supports', 'questions', 'costs', 'blocks', ...DISMISSAL_RELS]);

// ── Area-grouped layout (project brain) ──────────────────────────────────────
// Captured decisions carry an [Area]; these route cards INTO titled area
// containers (find-or-create) so the brain stays a clean areas-as-containers map
// instead of a rightward strip. Non-destructive, valid z-keys, atomic round-trip.
const BRAIN_GEOM = { TITLE_BAR: 40, PAD: 14, CARD_GAP: 10, CARD_W: 300, FONT: 12, LINE_H: 17, START: 80, COL_GAP: 44 };
BRAIN_GEOM.AREA_W = BRAIN_GEOM.CARD_W + BRAIN_GEOM.PAD * 2;

// Hard-wrap text to ~CARD_W by inserting newlines at word boundaries. KLYPIX text
// cards show a long SINGLE line as-typed (no auto-wrap until you resize), so a
// captured decision with no newlines runs off the box. Baking in line breaks
// makes brain cards render as tidy multi-line blocks regardless of that.
// The visible line a rule-ready lesson carries (the `rule:` marker suffix and
// brain_note's text suffix write it). It is a CANDIDATE only: nothing checks
// it until brain_rules adds it and a person approves it.
export const RULE_CANDIDATE_PREFIX = '⚙ rule candidate:';

// Cards written before 1.107 carry forced breaks: a line of exactly the card's
// width with no whitespace, then the rest of the same token on the next line.
// Readers that MATCH text or resolve paths rejoin them; the stored text is
// left as written. A real 37-character word that happened to end a line is
// joined to the next word too — harmless for matching, never written back —
// but never to a tag line or a lifecycle line, which start a block of their own.
const UNWRAP_BLOCK_START = /^(?:\s*(?:#[\p{L}\p{N}_-]+\s*)+$|✔|✅|↩|⤵|\(re-affirmed|\(~ amended|⚙ rule candidate:)/u;

// ── Lessons for the files a task touches (1.107) ────────────────────────────
// brain_sync used to turn declared files into WORDS only, so a lesson naming
// a test-folder glob ranked 58th for a session that declared a test file in
// that folder. This reads the paths a lesson names — a
// full path, a bare file name, a glob or placeholder (`../src/<module>.mjs`,
// `X.mjs`), a folder, the globs of its own `⚙ rule candidate:` line, its
// #file-/#dir- tags — and ranks lessons by how closely they name a declared
// file: exact path > file name > glob > folder (or a sibling file) > tag.
// Pure: no fs, no git. Callers pass a Map as `cache` to keep per-card parsing
// across calls.
const LESSON_FILE_EXT = /\.(?:[cm]?[jt]sx?|json5?|ya?ml|mdx?|css|scss|less|html?|py|rs|go|java|kts?|swift|sh|ps1|bat|cmd|toml|lock|sql|xml|gradle|cs|cpp|cc|c|h|hpp|rb|php|vue|svelte|klypix|plist|txt|ini|cfg|conf|proto|graphql|prisma|nsh)$/i;
const LESSON_GENERIC_DIRS = new Set(['src', 'app', 'lib', 'components', 'component', 'scripts', 'public', 'test', 'tests', 'electron', 'docs', 'bin', 'packages', 'admin', 'artifacts', 'api', 'server', 'client', 'web', 'tmp']);
const LESSON_TIERS = { exact: 5, name: 4, glob: 3, folder: 2, tag: 1 };
const LESSON_STOCK_NAMES = /^(?:page|layout|route|loading|error|template|default|index|mod|lib|__init__|types|utils|helpers|constants|styles|config)\.[a-z0-9]+$/i;
const LESSON_SHAPED_RE = /\b(?:must|never|always|do not|don't|avoid|gotcha|otherwise)\b|WHY THIS MATTERS/i;
const lessonSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const lessonRoot = (id) => String(id || '').replace(/(__agconf_[a-z0-9]+)+$/i, '');
// Retro-stamp: write paths that BY CONTRACT only ever run on project brains
// (tidy / arrange / capture / garden / brain_connect) mark the manifest kind,
// so an existing brain gains the explicit flag on its next touch and co-owned
// merge semantics survive a file rename. Detection everywhere is
// `manifest.kind === 'brain' OR basename brain.*` — the filename convention
// keeps working forever; the flag closes its silent-rename hole.
const stampBrainKind = (manifest) => { if (manifest && manifest.kind !== 'brain') manifest.kind = 'brain'; };

// ── Arrange: de-dup + full re-layout of an EXISTING brain ────────────────────
// The merge-on-save engine unions two copies of a brain BY ID (it never drops a
// card — correct for a co-owned brain), so a regenerated file merged over an
// open brain doubles every card AND container under disjoint random ids, and
// pre-wrap-fix files carry app-grown heights over stale stacked y's. arrangeBrain
// is the curative pass: collapse TRUE duplicates (same normalized content in the
// same normalized area — conservative by construction), re-point the losers'
// connections onto the survivor, then re-lay-out the whole map with tidyBrain's
// masonry+cluster engine (forceFull → deterministic clean grid, 📌 Focus first).
// Lossless by contract: it throws rather than return a buffer that lost a unique
// card text, a container title, the Focus container, or still overlaps.
// NEVER run it against a file the KLYPIX app currently has OPEN — the app's
// merge-on-save re-unions its in-memory copy and resurrects the duplicates.

// Normalizers: container identity ignores decorations ("MCP server ✅" ==
// "MCP server", "📌 Focus" == "Focus"); card identity collapses whitespace only
// (wrap-baked newlines don't defeat the match, distinct decisions still differ).
const normTitleKey = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const normTextKey = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
const connDupKey = (c) => `${c.fromId}|${c.toId}|${c.relationship || ''}|${c.label || ''}`;
// Merge-engine conflict twins ("<id>__agconf_<rand>") whose text is IDENTICAL
// to their original are serialization residue (the pre-1.49.0 byte-compare
// merge), never a deliberate placement — so unlike ordinary same-text cards
// they collapse ACROSS areas. The live twin of an archived/superseded original
// is exactly the zombie that outranked its own CORRECTION with no overlay
// (AgentLit, 2026-08-23: 37 such pairs; 518 twins in total). The original is
// the survivor; the twin's edges re-point onto it. Text that DIFFERS (a real
// two-sided edit) is untouched — that twin is a genuine conflict record.
const AGCONF_TWIN_RE = /^(.+?)__agconf_[a-z0-9]+$/i;
export const isAgconfTwinId = (id) => AGCONF_TWIN_RE.test(String(id || ''));
// Engine-authored RETIREMENT stamps — the exact formats the lifecycle writers
// put on a card: "↩︎ superseded <date>\n" / "⤵ consolidated <date>\n" prepended,
// "\n✅ <date>: …" / "\n✔ partial <date>: …" appended (the ✅ text itself wraps
// across lines, so the suffix runs to the end of the card; it must START a
// line — a dated ✅ cited mid-sentence is prose, not a stamp). A twin born
// BEFORE its original was retired carries the original's pre-retirement text
// exactly — the AgentLit zombie was this: "Capability Forge proposal"
// superseded on 2026-08-22, its live twin byte-identical minus the "↩︎
// superseded" line. Comparing with the stamps stripped recognizes that pair;
// the stamped copy is the survivor so the lifecycle record is never lost.
// Measured on AgentLit (518 twins): 3 live cross-area zombies of this shape,
// 34 same-area stamped twins beside their original in Archive, 481 plain
// byte-identical twins the same-area rule already folded.
const RETIRE_PREFIX_RE = /^(?:↩︎? superseded|⤵ consolidated) \d{4}-\d{2}-\d{2}[ \t]*\n?/u;
const RETIRE_SUFFIX_RE = /\n(?:✅|✔ partial) \d{4}-\d{2}-\d{2}:[\s\S]*$/u;
const stripRetirement = (t) => String(t || '').replace(RETIRE_PREFIX_RE, '').replace(RETIRE_SUFFIX_RE, '');
const hasRetirementStamp = (t) => RETIRE_PREFIX_RE.test(String(t || '')) || RETIRE_SUFFIX_RE.test(String(t || ''));
const retiredTextKey = (t) => normTextKey(stripRetirement(t));
// The ROOT a twin folds onto: strip trailing __agconf_<rand> segments to the
// deepest EXISTING ancestor. A nested twin (X__agconf_a__agconf_b) folds onto
// X, never onto the intermediate twin — grouping by the immediate parent put
// one card in two collapse groups and dropped a valid edge as "dangling"
// (review 2026-08-23).
const agconfRootOf = (id, byId) => {
    let cur = String(id || ''), root = null;
    for (let guard = 0; guard < 8; guard++) {
        const m = AGCONF_TWIN_RE.exec(cur);
        if (!m) break;
        cur = m[1];
        if (byId.has(cur)) root = cur;
    }
    return root;
};

// The receipt an arrange leaves on each duplicate it collapses (E-8). Callers
// that know better (the KLYPIX CLI, the app) pass their own `source`.
const ARRANGE_DELETION = Object.freeze({ initiator: 'unknown', cause: 'brain-arrange', source: 'klypix-mcp', confidence: 'explicit' });
const REVIVED_ID_RE = /__r_[0-9a-f]{12}$/;

// ── Lifecycle classification — ONE definition, every surface ────────────────
// A capture marker writes the lifecycle glyph into LINE 1 ("Area: ❓ text").
// PRECEDENCE: when line 1 already carries a state glyph, line 1 DECIDES — so a
// 🏁 milestone whose BODY quotes "❓/🎯" stays a milestone instead of ranking as
// an open question forever (the glyph-in-prose trap; 6 live false-positives on
// the KLYPIX brain, four of them the same shipped 1.30.0 card re-read as "still
// to do"). v1.31.1 stripped glyphs at CAPTURE time for engine-authored text —
// that could not help cards already written, nor a human card that legitimately
// quotes a glyph. This is the read-side half, and it needs no rewrite of stored
// text (a rewrite's failure mode is silent: an over-matching strip turns a real
// open card invisible with nothing to notice).
//
// Two deliberate constraints, both measured before shipping:
//   1. FALLBACK — if line 1 carries no state glyph at all we scan the whole
//      text exactly as before, so a brain that writes its marker under a title
//      line is classified identically. Zero regression by construction.
//   2. 🛠 IS EXEMPT — a skill is ADDITIVE (a milestone can also carry a standing
//      rule) and skills never age out, so 🛠 keeps whole-text matching. Applying
//      precedence to it demoted 7 live skill cards to milestones, silently
//      retiring 7 standing rules. Precedence governs the ❓/🎯-vs-🏁 STATE
//      distinction only.
// Measured on the KLYPIX brain: open 26→20 (6 false-positives, 0 lost),
// skills 97→97, milestones 303→309, 0 cards left with no lifecycle at all.
const STATE_GLYPH = /❓|🎯|🏁/;
const OPEN_GLYPH = /❓|🎯/;
const SKILL_GLYPH = /🛠/;
const MILE_GLYPH = /🏁/;
const RESOLVED_GLYPH = /↩|✅|⤵/;
// The span line 1 governs when it carries a state glyph; else the whole card.
const lifecycleScope = (text) => {
    const t = String(text || '');
    const l1 = t.split('\n', 1)[0];
    return STATE_GLYPH.test(l1) ? l1 : t;
};
// Lifecycle is a property of PROSE, so only text cards can carry it. Media
// cards gained a non-null `text` when the reader stopped dropping them, which
// means a file literally named "🏁 launch.png" would otherwise be counted as a
// milestone and a folder holding "❓ open questions.md" as an open question.
// Missing/undefined type stays eligible so legacy .any items are unaffected.
const lifecycleEligible = (c) => { const t = c?.type; return t == null || t === 'text'; };
export const isSkillCard = (c) => lifecycleEligible(c) && SKILL_GLYPH.test(String(c?.text || ''));
export const isOpenCard = (c) => lifecycleEligible(c) && !isSkillCard(c) && OPEN_GLYPH.test(lifecycleScope(c?.text));
export const isMilestoneCard = (c) => lifecycleEligible(c) && !isSkillCard(c) && !isOpenCard(c) && MILE_GLYPH.test(lifecycleScope(c?.text));
// "Open AND not already resolved in prose" — the status surfaces carry this
// extra guard so a ✅/↩/⤵-stamped card is never reported as plainly still-open.
export const isUnresolvedOpenCard = (c) => isOpenCard(c) && !RESOLVED_GLYPH.test(String(c?.text || ''));

// ── Session handoff cards (1.99.0) ───────────────────────────────────────────
// A deliberate handoff is an OPEN card ("Area: ❓ 🤝 HANDOFF — title …") that a
// session writes when it stops before the work is done; brain_handoff owns its
// lifecycle (take / done → ✅ archived). The 🤝 glyph on LINE 1 is the whole
// contract: line-1 precedence keeps a milestone that QUOTES a handoff from
// counting as one. `card.handoff` is the machine twin (state, from, taken,
// done) — stamped by brain_handoff, carried through parseKlypix like `guard`.
export const HANDOFF_RE = /🤝\s*HANDOFF\b/u;
export const isHandoffCard = (c) => lifecycleEligible(c) && HANDOFF_RE.test(String(c?.text || '').split('\n', 1)[0]);
export const isOpenHandoffCard = (c) => isHandoffCard(c) && isUnresolvedOpenCard(c) && !/^archive$/i.test(String(c?.area || ''))
    && !(c?.handoff && typeof c.handoff === 'object' && c.handoff.state === 'done');
// The title a handoff card was given (line 1 minus area prefix, glyphs and
// the HANDOFF word) — what every list prints beside its id.
// The capture engine hard-wraps a card at ~36 columns, so the title may span
// several lines: take line 1 and every following line up to the first section
// keyword (From:/Task:/…) or tag line.
const HANDOFF_SECTION_LINE_RE = /^(?:From|Drafted|Task|Done|Next|Files|Verify|Last words|Open|Taken|Finished|Continued by|Resume)\b[^\n]*:/u;

// ── DECLARED vs QUOTED lifecycle (1.85.0 field incident) ────────────────────
// The classifiers above answer "does this card CARRY a lifecycle glyph", which
// is the right question for a read-side tier: over-including a card costs a
// render, never data. The WRITE-side guards ask a different question — "may a
// ✓ archive this card?" — and there the same test is a trap. `/🏁/.test(text)`
// fires on a card that merely QUOTES the glyph, so a decision card titled
// "Brain: The 🏁-doesn't-close-❓ gap …" (txt_4ixgcxz1 on the real brain) was
// unresolvable by any ✓: the marker silently minted a junk fallback milestone
// instead and the card had to be closed with an explicit closes: target.
//
// This helper answers "which lifecycle glyph does this card DECLARE" — the one
// in PREFIX position on its headline, after an optional `Area:` prefix. A
// headline that mentions a glyph mid-sentence declares NONE (that is the fix).
// A headline with no lifecycle glyph at all falls back to the first body line
// that declares one, which is exactly lifecycleScope's documented fallback, so
// a brain that writes its marker under a title line is unaffected.
//
// It is deliberately NOT retro-fitted onto isSkillCard / isPlanCard /
// isMilestoneCard. Those are additive classifications where over-inclusion is
// the safe direction and narrowing them has a measured cost: applying headline
// precedence to 🛠 demoted 7 live skill cards to milestones, silently retiring
// 7 standing rules. Same glyphs, opposite risk — one helper would be wrong for
// one of them.
const LIFECYCLE_GLYPH_RE = /[❓🎯🏁🛠✅✔↩⤵]/u;
const AREA_PREFIX_RE = /^[^:\n]{1,40}:\s*/;
const DECLARED_GLYPH_RE = /^[\s"'“”*_>-]*([❓🎯🏁🛠✅✔↩⤵])/u;
// Areas are compared with lifecycle glyphs and punctuation stripped from BOTH
// sides: this project has an area literally titled "Canvas UX ✅", and strict
// lowercase equality meant every ✓ written with area "Canvas UX" silently
// matched nothing in it (measured 2026-09-15).
export const sameAreaKey = (a, b) => normTitleKey(a) === normTitleKey(b);
// One normalizer for BOTH sides of a `closes:` comparison — the [[wikilink]]
// brackets, the `Area:` prefix and any leading lifecycle glyph removed, then
// whitespace collapsed and lowercased. Card titles are derived from prose, so
// comparing a raw title against a raw target was comparing "canvas ux:" with a
// sentence; and the `Area:` half is why a bare stub matched everything.
export const closeTargetKey = (s) => String(s || '')
    .replace(/^\s*\[\[/, '').replace(/\]\]\s*$/, '')
    .replace(AREA_PREFIX_RE, '')
    .replace(/^[\s"'“”*_>-]*[❓🎯🏁🛠✅✔↩⤵️]+\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim().toLowerCase();

// ── Plan-shaped plain cards (2026-08-23 AgentLit incident) ──────────────────
// A proposal / plan / "design decided" card written WITHOUT a ❓/🎯 glyph sits
// outside every lifecycle mechanism above — no close-pass, no fulfillment
// pairing, no self-heal, no ⏳ hint. So when the thing it describes ships under
// a 🏁 (often RENAMED: "Capability Forge proposal" → "🏁 Capability builder
// shipped", same day), the plan keeps rendering as current intent and an agent
// answers "it's only a proposal" about a feature that is live. Measured before
// this landed (with the shipped classifier, 2026-08-23): 25 such cards in the
// KLYPIX brain, 10 distinct in AgentLit, most with a real later 🏁 (a wider
// draft regex had counted 61/9). This classifier admits them to the SAME pairing machinery as
// ❓ cards — as hedged HINTS, never as a close.
// PRECISION-FIRST like every sibling: the HEADLINE (area prefix stripped,
// wrap-normalized, first ~220 chars) must carry a future-work cue AND no ship
// pin ("Phase 1 BUILT + verified" is an event, not a plan — "not built" / "not
// yet built" stay plan cues via the negation lookbehind). Glyphed cards keep
// their own lifecycle; correction-cue cards assert present truth, never plans.
// Cue shapes (review 2026-08-23 tightened the bare nouns): "plan"/"proposal"
// fire only as the card's own intent — not inside an identifier (users.plan),
// a pipeline arrow (plan→act), a pricing tier (paid plan), a quotation, or a
// negation ("don't plan to"). "to be built" is exempt from the ship pin, and
// "Design:" may be followed by a space (both were dead alternatives before).
const PLAN_NOUN_GUARD = String.raw`(?<![.\w\/_-])(?<!\b(?:don'?t|do not|no|never|not|paid|free|pricing|subscription|beta|pro|cloud|billing|current)\s)`;
const PLAN_CUE_RE = new RegExp(String.raw`\b(?:${PLAN_NOUN_GUARD}(?:proposals?|proposed|proposes?|plan(?:ned|ning)?(?![→\/.\-]))|roadmap|next\s+steps?|to\s+be\s+(?:built|shipped|implemented|wired|added)|not\s+(?:yet\s+)?(?:built|designed|implemented|shipped|started|wired)|will\s+(?:build|ship|implement|wire|add|land)|will\s+be\s+(?:built|shipped|implemented|wired|added)|should\s+(?:be|go|default|use|become|move|live|ship|land)|design\b[^.\n]{0,30}?\b(?:decided|locked|approved|agreed|chosen)|(?:decided|approved|locked|agreed)\b[^.\n]{0,20}?\b(?:build|ship|implement|wire)|spec(?:ification)?\s+(?:written|drafted|locked))\b|\bdesign\s*:(?=\s|$)`, 'i');
const PLAN_SHIP_PIN_RE = /(?<!\bnot\s)(?<!\bnot\s+yet\s)(?<!\bto\s+be\s)(?<!\bwill\s+be\s)\b(?:shipped|merged|published|released|deployed|landed|built|implemented|went\s+live|is\s+live|now\s+live)\b/i;
// An UPPERCASE verdict that the plan is dead (the same deliberate-signal casing
// as CORRECTION): a rejected proposal is history, never a plan awaiting a ship.
const PLAN_DEAD_RE = /\b(?:REJECTED|DECLINED|DROPPED|ABANDONED|WITHDRAWN|CANCELLED|CANCELED)\b/;
const planHeadline = (text) => normalizeWrappedProse(String(text || ''))
    .replace(/^[^:\n]{1,40}:\s*/, '')
    .slice(0, 220)
    .replace(/`[^`]*`/g, ' ')                                  // code spans carry identifiers, not intent
    .replace(/["“”„][^"“”„]{0,120}["“”„]/g, ' ');              // quoted strings are someone else's words
export const isPlanCard = (c) => {
    if (!lifecycleEligible(c) || c?.type === 'container') return false;
    const t = String(c?.text || '');
    if (!t.trim() || STATE_GLYPH.test(t) || SKILL_GLYPH.test(t) || RESOLVED_GLYPH.test(t)) return false;
    if (hasCorrectionCue(t)) return false;
    const head = planHeadline(t);
    if (PLAN_DEAD_RE.test(head)) return false;
    return PLAN_CUE_RE.test(head) && !PLAN_SHIP_PIN_RE.test(head);
};

// ── Ultra brief (SessionStart stdout tier) ───────────────────────────────────
// The harness persists hook stdout to a file and shows the agent only a ~2KB
// PREVIEW — a 13.5KB brief was mostly invisible (everything after Focus/open
// questions reached the agent only if it chose to open the file; it usually
// didn't). This tier is sized to fit that preview WHOLE: Focus + conflicts +
// open questions + a pointer to the FULL brief file the hook writes alongside.
// The pointer + marker legend are reserved OUT of the budget so they always fit.
export const ULTRA_BUDGET_CHARS = 1_800;
const foldAll = (list) => list.map(foldArabic);
// 'anything' joined STOPWORDS in 1.85.0: it is the shape word of "anything
// left / anything remaining", never a subject. Arabic function words follow —
// most are two letters and never tokenize anyway; listed for the ones that do.
const STOPWORDS = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'was', 'were', 'are', 'you', 'your', 'not', 'but', 'its', 'into', 'out', 'can', 'will', 'use', 'using', 'about', 'what', 'when', 'why', 'how', 'add', 'fix', 'make', 'need', 'want', 'let', 'see', 'get', 'got', 'now', 'all', 'any', 'via', 'per', 'etc', 'should', 'could', 'would', 'does', 'did', 'still', 'just', 'like', 'also', 'then', 'than', 'them', 'they', 'anything',
    ...foldAll(['في', 'على', 'من', 'هل', 'الى', 'عن', 'مع', 'هذا', 'هذه', 'او',
        // Arabic question words — the shape of a question, never its subject (as 'what/when/why/how' above).
        'ماذا', 'ايش', 'وش', 'شو', 'كيف', 'متى', 'اين', 'وين', 'فين', 'لماذا', 'ليش'])]);
// ── Area families (1.85.0) — static alias sets a prompt can name ─────────────
// STATIC by design: splitQueryTokens has no struct, so it can only return
// family NAMES; areaHintsFromPrompt(struct, text) resolves them to exact
// container titles once a struct is loaded. Matching is WHOLE-TOKEN on folded,
// lower-cased tokens with Arabic clitic stripping — never substring (substring
// matched 'approval'→desktop, 'scenarios'→ios, 'dashboard'→canvas, 'webhook
// driver'→web+drive and container 'Chat/Window'→desktop via 'win'; measured).
// 'update'/'version' are NOT aliases: they are verbs the status phrases consume.
export const AREA_FAMILIES = Object.freeze({
    desktop: Object.freeze(foldAll(['desk', 'desktop', 'electron', 'installer', 'build', 'windows', 'win', 'ديسكتوب', 'سطح-المكتب'])),
    ios: Object.freeze(foldAll(['ios', 'iphone', 'phone', 'appstore', 'testflight', 'ايفون'])),
    web: Object.freeze(foldAll(['web', 'website', 'site', 'landing', 'viewer', 'portal', 'vercel', 'الموقع', 'ويب'])),
    canvas: Object.freeze(['canvas', 'board']),
    brain: Object.freeze(['brain', 'memory', 'mcp']),
    drive: Object.freeze(['drive']),
    release: Object.freeze(['release']),
});
// normTokens splits on EVERYTHING that is not a letter or digit (hyphens too,
// unlike queryTokens) — the alias test wants bare words.
export const normTokens = (s) => foldArabic(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// Leading Arabic clitics (definite article, prepositions, conjunctions) are
// stripped ONLY when a ≥3-letter stem remains: 'للديسكتوب' → 'ديسكتوب',
// 'الموقع' → 'موقع'. Longest prefix first; one strip per token.
const AR_CLITICS = ['وال', 'بال', 'لل', 'ال', 'ب', 'و', 'ف', 'ل', 'ك'];
// Alias sets pre-folded + pre-stripped so a token matches in either spelling.
const FAMILY_ALIAS_SETS = new Map(Object.entries(AREA_FAMILIES).map(([fam, aliases]) => {
    const set = new Set();
    for (const a of aliases) for (const part of normTokens(a)) { set.add(part); set.add(stripArabicClitic(part)); }
    // Multi-token aliases ('سطح-المكتب') also register as a joined bigram key.
    for (const a of aliases) { const parts = normTokens(a); if (parts.length > 1) set.add(parts.join(' ')); }
    return [fam, set];
}));
const ALL_ALIASES = new Set([...FAMILY_ALIAS_SETS.values()].flatMap(s => [...s]));
const isAliasToken = (t) => ALL_ALIASES.has(t) || ALL_ALIASES.has(stripArabicClitic(t)) || t === 'app';
// ── Status-vocab quarantine (2026-07-23 field incident) ──────────────────────
// Words that describe the SHAPE of a status question ("what is remaining?"),
// not its subject. As content tokens they are adversarially ANTI-correlated
// with truth: cards *saying* "remaining/pending" are exactly the stale claims,
// while the milestones that fulfilled them ("shipped the web portal") share
// zero tokens with the question — so lexical scoring structurally prefers the
// corpse. Quarantined out of QUERY scoring only (card tokenSets untouched —
// claim-matching thresholds were calibrated on them). Deliberately narrow:
// polysemous words (open, left, next, done, state) stay content tokens and are
// caught by the phrase-level shape regex instead.
// 'status'/'progress' are NOT here — "sync status indicator" / "progress bar"
// are real subjects (adversarial review 2026-07-23); the phrase regex below
// still catches "current status"-style question shapes.
// Arabic entries are stored in FOLDED spelling (foldArabic) — the tokenizer
// folds the prompt the same way, so 'تبقّى', 'تبقى' and 'تبقي' all land here.
export const STATUS_VOCAB = new Set(['remaining', 'remains', 'pending', 'outstanding', 'todo', 'todos', 'unfinished', 'awaits', 'awaiting',
    ...foldAll(['تبقى', 'بقي', 'باقي', 'المتبقي', 'متبقي', 'متبقيه', 'معلق', 'معلقه', 'ناقص', 'ينقص', 'عالق'])]);
// No bare \bto-?do\b — it matched the word "TODO" anywhere ("remove the TODO:
// refactor X" is a work request, review-caught); to-do only counts inside a
// question shape ("what's still to do").
//
// ── STRICT vs LOOSE families (1.85.0) ────────────────────────────────────────
// STRICT: today's four English families + the Arabic 'where are we' / 'current
// state' / 'what is left' shapes — strong on the phrase alone.
// LOOSE: the shapes people actually type ("do i need to update the desk? ios?
// or web?", "anything left", "what now", "are we up to date?") — strong ONLY
// under the residual rule (residualIsAreaOnly). Measured against these very
// regexes, 14 of 17 ordinary coding questions ("should we bump zod to v4?",
// "what is now the correct import path?") fired without it, and a strong hit
// REPLACES card retrieval in the hook — so a false positive costs recall.
// 'missing' is in NO family (code-review word). 'status'/'progress' stay out.
const STATUS_QUERY_RE = /\bwhat(?:'?s| is| are)\s+(?:still\s+)?(?:left|remaining|next|open|pending|outstanding|to\s*do|the status)\b|\bstill\s+(?:open|left|pending|remaining|to\s*do)\b|\bwhere (?:are we|do we stand)\b|\bcurrent (?:state|status)\b/i;
export const STATUS_FAMILIES_EN = Object.freeze({
    DO_NEED: /\b(?:do|does|should|must|need)\s+(?:i|we|you)\s+(?:still\s+)?(?:need\s+to\s+)?(?:update|upgrade|bump|rebuild|re-?release|ship|publish|deploy|push|cut)\b/i,
    IS_THERE: /\b(?:is|are)\s+(?:there\s+)?(?:anything|something|stuff|work|items?|bugs?)\s+(?:still\s+)?(?:left|remaining|pending|open|outstanding|to\s*do)\b/i,
    ANYTHING: /\banything\s+(?:else\s+)?(?:left|remaining|pending|open|outstanding|to\s*do)\b/i,
    WHAT_NOW: /\bwhat(?:'?s| is)?\s+now\b/i,
    WHAT_TODOS: /\bwhat(?:'?s| is| are)?\s+(?:the\s+)?(?:remaining|leftover|todo|to-?do)s?\b/i,
    BEHIND: /\b(?:is|are)\s+(?:we|the\s+\S+(?:\s+\S+)?)\s+(?:up[\s-]?to[\s-]?date|behind|stale|current)\s*\?/i,
    WHAT_NEED: /\bwhat\s+(?:do\s+)?(?:we|i)\s+(?:still\s+)?(?:have|need)\s+(?:left|to\s+do)\b/i,
});
// Arabic regexes use NO `\b`: JS `\b` is ASCII-\w based even under /u and never
// matches beside an Arabic letter (measured: every Arabic positive failed with
// it). Word edges are `(?<![\p{L}\p{N}])` / `(?![\p{L}\p{N}])`. Sources are
// written in natural spelling and FOLDED at construction so they match the
// folded prompt (test/status-shape.mjs asserts no `\b` in any source).
const arRe = (src) => new RegExp(foldArabic(src), 'u');
export const STATUS_FAMILIES_AR = Object.freeze({
    // STRICT — the phrase alone is a status question.
    STRICT_AR: arRe('(?<![\\p{L}\\p{N}])(?:وين|اين|فين)\\s+وصلنا(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}])(?:الوضع|الحاله)\\s+(?:الحالي|الحاليه|الان)(?![\\p{L}\\p{N}])'),
    WHAT_LEFT_AR: arRe('(?<![\\p{L}\\p{N}])(?:ما|ماذا|ايش|وش|شو)\\s*(?:الذي|اللي)?\\s*(?:تبقى|بقي|باقي|ناقص|المتبقي|متبقي)(?![\\p{L}\\p{N}])'),
    // LOOSE — a leading هل OR a trailing ؟/? is REQUIRED ('لازم ننشر النسخة
    // الجديدة' is a work statement, measured firing without it), then the
    // residual rule decides.
    NEED_AR: arRe('(?:^|\\s)هل\\s+(?:نحتاج|لازم|يلزم|ضروري)\\s+(?:ان\\s+)?(?:ن?حدث|تحديث|نرفع|ننشر|نطلق|نبني)(?![\\p{L}\\p{N}])|(?:نحتاج|لازم|يلزم|ضروري)\\s+(?:ان\\s+)?(?:ن?حدث|تحديث|نرفع|ننشر|نطلق|نبني)[^؟?]{0,40}[؟?]'),
});
// A status noun wearing a definite article ('الباقي' = 'the remainder') is the
// same vocab — checked in the stripped form too.
const isStatusVocab = (t) => STATUS_VOCAB.has(t) || STATUS_VOCAB.has(stripArabicClitic(t));
const STRICT_FAMILIES = [STATUS_QUERY_RE, STATUS_FAMILIES_AR.STRICT_AR, STATUS_FAMILIES_AR.WHAT_LEFT_AR];
const LOOSE_FAMILIES = [...Object.values(STATUS_FAMILIES_EN), STATUS_FAMILIES_AR.NEED_AR];
// Every span a loose family matches is blanked out (all occurrences, so a
// repeated shape cannot smuggle its own words into the residual).
const blankMatches = (text, re) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    return text.replace(g, ' ');
};
const wordsOf = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || []);

// ── The hook lane's two measured bars (1.86) ─────────────────────────────────
// Both were swept on 2026-09-16 with scripts/eval-hook-lane.mjs over 110 real
// founder prompts (35 capture-pairs with a gold card, 75 that should inject
// nothing) against the real 2,695-card brain. The harness reads these exports,
// so the number it measures is the number the hook ships.
//
// HOOK_LEXICAL_MIN_SCORE — scoreCardsAgainstQuery's bar for the per-prompt
// lexical lane. A title/tag hit scores 3, a body hit ≤ 1, a standing skill +1:
//   minScore 3 (pre-1.86)  real prompts: fired 97% · right card in top-5 29% · 4.6 cards
//                          junk prompts: injected nothing 27% of the time
//   minScore 4 (ships)     real prompts: fired 91% · right card in top-5 26% · 4.0 cards
//                          junk prompts: injected nothing 69% of the time
//   minScore 5             real prompts: fired 74% · 20% · 2.4 cards · junk zero 81%
// One title word is no longer enough ("do all best in class" used to inject a
// card titled "…kill stale-closure CLASS…"); a title word plus corroboration,
// or a 🛠️ skill, still is. The one-gold cost (29→26 on n=35) is inside noise.
// NOTE (1.87): the shipping hook no longer reads this bar — its recall lanes
// are rankHookWords / rankHookFused below (HOOK_WORDS_BAR / HOOK_FUSED_SHOW_BAR).
// It stays exported for the hook's version-skew fallback and for MCP consumers
// of scoreCardsAgainstQuery.
export const HOOK_LEXICAL_MIN_SCORE = 4;
// FALLBACK_MIN_CONTENT_TOKENS — the semantic fallback only runs for a prompt
// that carries at least this many content tokens (after stopwords and status
// vocabulary). Measured: every junk prompt that reached the fallback had 1–3
// ("build best in class", "continue where needed"); the real ones had 4+
// ("i pressed restart and nothing appears , why"). Terse real prompts keep the
// lexical lane and its git-diff fallback — they lose only an uncorroborated
// five-card semantic guess that the cosine data says cannot tell junk apart.
export const FALLBACK_MIN_CONTENT_TOKENS = 4;

// ── Unified hook recall (1.87) — the measured two-lane replacement ───────────
// The per-prompt hook's card recall was re-designed 2026-09-28 on a dev/held-out
// split of real founder prompts (external bench, "unified balanced" policy):
//   WORDS lane — rankHookWords: BM25-idf rarity ranking over live cards with a
//     title/tag boost, abstaining below an evidence bar measured in
//     "rare-title-word units" (a word found in exactly one card's title scores
//     the boost). Needs no model; works on every machine.
//   MODEL lane — rankHookFused: one fused score per card (cosine against the
//     warm vector cache + a small rarity term for the prompt tokens the card
//     carries) drives both the ranking and the show/stay-silent decision.
//     Identical-text merge twins collapse to ONE piece of evidence, reachable
//     through whichever copy still has a vector, shown as the NEWEST copy.
//   Routing (in the hook): strong status prompts keep the computed digest;
//     prompts with fewer than HOOK_MODEL_MIN_TOKENS unique CONTENT tokens
//     never load the model; the rest take the model lane when a query vector
//     and warm card vectors exist, else the words lane. No freshness bonus in
//     the fused score — the tuning set's gold cards were unusually recent, so
//     a recency reward would have been flattered, not validated.
// These four numbers ARE the policy: the hook reads them, the harness
// (scripts/eval-hook-lane.mjs) sweeps around them, tests import them —
// nothing restates them. HOOK_LEXICAL_MIN_SCORE above is now read only by the
// hook's version-skew fallback and the harness sweep, not the shipping lane.
export const HOOK_WORDS_BAR = 1.8;          // words lane: min evidence to show (>= shows)
export const HOOK_MODEL_MIN_TOKENS = 6;     // unique content tokens before the model lane may load
export const HOOK_FUSED_SHOW_BAR = 0.65;    // model lane: min fused evidence of the best card (>= shows)
export const HOOK_FUSED_IDF_WEIGHT = 0.006; // model lane: cosine units per unit of matched-token rarity
// Words-lane internals (bench values, not re-tunable per call): a title/tag
// hit is worth TITLE_BOOST body hits; k1/b are BM25 saturation + a softened
// length penalty; the prompt's own specificity (summed rarity of its tokens
// the brain knows) contributes at SPECIFICITY_WEIGHT.
const HOOK_WORDS_TITLE_BOOST = 2;
const HOOK_WORDS_K1 = 1.2;
const HOOK_WORDS_B = 0.5;
const HOOK_WORDS_SPECIFICITY = 0.2;
// Unicode tokenizer (2+ chars, Arabic folded, stemLight applied) — the words
// lane matches stem-vs-stem, which makes it the first Arabic-capable card
// matcher in the hook (scoreCardsAgainstQuery's wordsOf is Latin-only).
const HOOK_WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu;
const hookTermsOf = (text) => (foldArabic(String(text || '')).toLowerCase().match(HOOK_WORD_RE) || []).map(w => stemLight(w));
const hookTagSlug = (t) => String(t).toLowerCase().replace(/^#/, '').replace(/^(file|dir)-/, '');
// Per-struct index caches: the hook is a one-shot process (one build per
// prompt, ~0.7s on a 3k-card brain — the accepted latency budget of the
// measured policy), but harnesses and the MCP server rank many prompts
// against one parsed struct and must not rebuild per call.
const hookWordsIndexCache = new WeakMap();
const hookFusedIndexCache = new WeakMap();

// ── Ask-the-brain — whole-brain, correction-aware retrieval for a question ───
// The surface a human actually uses ("what did we decide about X?", "where did
// the auth work land?"). Distinct from the per-prompt recall hook (which injects
// a few RELATED cards into every prompt) and search_canvases (raw substring): this
// RANKS the whole brain against a natural-language question and assembles a
// SYNTHESIS-READY context for the calling agent to answer from — the engine stays
// model-free (mirrors brain_connect/garden: engine selects, model writes prose).
// Three things make it an ANSWER path, not a card dump:
//   1. Hybrid-ready — lexical always (the shared scorer's weights + length-norm),
//      semantic blended when the caller (core, with the on-device embedder) passes
//      a sim map; on a lexical miss the semantic floor still surfaces paraphrases.
//   2. History-aware — INCLUDES archived/superseded cards (penalized + flagged), so
//      "what did we decide" can show the arc (decided A → changed to B), and an
//      optional as_of answers "what was true then".
//   3. Truth-aware — every stale hit carries its live CORRECTION (the P1 machinery),
//      so the agent answers from the correction, never the outdated card alone.
// Pure + node-runnable. `semantic` is Map<cardId, 0..1> or null.
// THE one death-date reader (2026-07-23: three divergent regex copies had
// shipped — core's as_of missed "↩ superseded", and BOTH copies missed the
// gardener's "⤵ consolidated" stamp, so every gardened card silently vanished
// from time-travel). Accepts a struct card (machine `consolidatedAt` wins) or
// a raw text string; core imports this instead of keeping a local twin.
export const deathDateOfCard = (card) => {
    const c = card && typeof card === 'object' ? card : { text: card };
    if (Number.isFinite(c.consolidatedAt) && c.consolidatedAt > 0) return c.consolidatedAt;
    const m = /(?:↩︎ superseded|↩ superseded|✅|⤵ consolidated) (\d{4}-\d{2}-\d{2})/.exec(String(c.text || ''));
    return m ? Date.parse(m[1]) : null;
};
// THE CALLER'S WORDS (1.96.0). A question is worded the asker's way; the card
// that answers it was worded the day it was written ("magnification controls"
// vs a card that says "zoom"). The calling agent is itself a model, so brain_ask
// invites it to add one last line `Also: <words a card answering this would
// likely use>`. Those words join the MEANING query only (embedded together with
// the question, one vector); the keyword anchor test, status shape and the
// rendered question all stay the question's own. Measured 2026-10-11 on the
// real 3,829-card brain, frozen v2 set (102 answerable), production embedder +
// warm enrichment-aware vectors, model-written words: recall@5 55 → 60
// (+8 −3), @8 62 → 69, @20 69 → 78, MRR .375 → .424. Fusing a separate words
// vector by rank instead did less (+5 −2 at equal weight). Carried inside
// `question` because no existing tool's input schema may change (see
// test/tool-schema-freeze.mjs) — a new property would force every host to
// reconnect; a line in the text works the moment the worker hot-swaps.
export const ASK_WORDS_MAX = 240;
// Keyword-only mode (no meaning model), same brain and set, words as extra
// tokens, through splitAskWords: recall@5 19 → 24 of 102 at half weight with
// none lost (@10 26 → 32); full weight lost a question the question alone
// found. Measured 2026-10-11.
export const ASK_WORDS_LEXICAL_WEIGHT = 0.5;

// ── Decay-aware status assertions (2026-07-28 post-mortem, 3rd stale-status ──
// incident). The brain is a MEMORY, not a SENSOR: for fast-decay facts (what's
// on TestFlight, what's on npm, whether the rollout flipped) its job is to
// carry WHERE to look, never assert WHAT is currently true. classifyDecay
// detects texts that make such assertions so every render surface can stamp
// them ⏱️ LAST KNOWN instead of presenting them as current state. This moves
// the "verify before reporting" discipline from model judgment (fails on weak
// models, occasionally on strong ones) into the engine's output contract.
//
// PRECISION OVER RECALL — a missed stamp is the status quo; a false stamp
// erodes trust in every stamp. A text classifies ONLY when, inside one
// sentence/line segment (split on .!?\n — NOT ';', the actual incident text
// was "ready for next TestFlight build; no upload/tag triggered yet"), BOTH:
//   VERB class — completed-status forms: uploaded / published / released /
//     deployed / installed / shipped / submitted / staged / flipped /
//     triggered / rolled out|back / went|is|now live / green — or a
//     NEGATIVE-pending assertion ("no upload triggered yet", "not yet
//     published", "awaiting App Store review"), which decays just as fast.
//   NOUN class — release-shaped subjects: TestFlight / App Store / npm / CI /
//     release(s) / rollout / build N / vX.Y[.Z] and X.Y.Z version literals.
// Or the text carries an ev: run/release id ("ev: gh run 16204339183") — a
// machine receipt is by definition a point-in-time observation.
// DELIBERATE NON-MATCHES (each is a live false-positive class we tested out):
//   · bare-infinitive process/architecture prose — "releases go through OIDC
//     npm publish", "the release pipeline: build → sign → upload" (no
//     completed verb form; 'publish'/'upload' ≠ 'published'/'uploaded');
//   · "staged rollout/release/deployment" AND the hyphenated "staged-rollout"
//     as adjectives (vs "draft staged") — the hyphen form was a live FP on the
//     real brain's Capabilities card ("staged-rollout auto-updater");
//   · 'released'/'shipped' with no release noun in the segment — "shipped the
//     garden fix" is a durable milestone, not a fast-decay build status;
//   · hyphenated 'live-' adjectives ("live-verified", "live-traced");
//   · questions/plans about releasing ("should we upload nightly builds?").
export const DECAY_STALE_MS = 6 * 3_600_000;   // older than this → LAST KNOWN, never current
const DECAY_VERB_RE = /\b(?:uploaded|published|released|deployed|installed|shipped|submitted|flipped|triggered|green)\b|\bstaged\b(?![\s-]+(?:rollout|rollouts|release[sd]?|deploy\w*|migration\w*|approach))|\brolled[\s-]?(?:out|back)\b|\brolling[\s-]?out\b|\b(?:went|is|are|now|already)\s+live\b|\blive\b(?!-)/i;
const DECAY_PENDING_RE = /\b(?:not\s+yet|hasn'?t(?:\s+been)?|haven'?t(?:\s+been)?|nothing(?:\s+has)?(?:\s+been)?|never)\s+(?:been\s+)?(?:uploaded|published|released|deployed|installed|shipped|triggered|tagged|submitted|gone\s+live)\b|\bno\s+(?:\w+[\s/-]+){0,2}?(?:upload|publish|deploy|release|install|build|tag|rollout)[\w/-]*(?:\s+\S+){0,3}?\s+(?:yet|so\s+far|triggered|started|fired|happened)\b|\b(?:awaiting|waiting\s+(?:for|on)|pending)\s+(?:apple|app\s?store|testflight|review|approval|upload|release|rollout)\b/i;
const DECAY_NOUN_RE = /\btest\s?flight\b|\bapp\s?store\b|\bnpm\b|\bci\b|\brelease(?:s)?\b|\brollout(?:s)?\b|\bbuild\s*#?\s*\d+\b|\bv\d+(?:\.\d+)+\b|\b\d+\.\d+\.\d+\b/i;
const DECAY_EVRUN_RE = /\bev:\s*[^\n]{0,60}?\b(?:run|workflow|release|build|rollout|deploy)[a-z-]*\s*[#:/]?\s*\d{3,}/i;
// A struct card decays if its TEXT classifies, or its machine evidence carries
// a run/release-shaped receipt (the ev: suffix is stripped from hook-captured
// prose, so the text alone can't see it).
// Card text IS wrapped by construction (wrapText at capture), so the card path
// unwraps explicitly rather than relying on geometry detection.
export const isFastDecayCard = (c) => classifyDecay(c?.text, { wrapped: true })
    || (Array.isArray(c?.evidence) && c.evidence.some(e => DECAY_EVRUN_RE.test('ev: ' + String(e?.ref || ''))));
// Compact age for stamps ("20h", "3d") — both message renderers show minutes
// only, which reads as noise at 12h+ ("720m ago").
export const formatDecayAge = (ms) => {
    const h = Math.floor(Math.max(0, ms) / 3_600_000);
    if (h < 1) return `${Math.max(1, Math.floor(Math.max(0, ms) / 60_000))}m`;
    return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
};
// Engine-emitted stamp for a delivered inter-session message (class B of the
// post-mortem taxonomy) — EXACT wording from the brief, single-sourced here so
// the Claude-hook and agent-presence renderers can never drift apart.
export const decayMessageStamp = (ageMs) =>
    `⏱️ This message is ${formatDecayAge(ageMs)} old and contains build/deploy status — treat as LAST KNOWN, verify live before reporting it.`;

// ── Out-of-session ship observation (class-C decay, host-neutral) ────────────
// A ship that happens with NO hooked session watching — another host, a human
// terminal, CI — produced no 🏁 card and triggered no claim reconciliation: the
// brain only learned what a session narrated. The v1.3.69 desktop release
// arrived exactly that way and the ❓ it resolved stayed open for a day.
//
// This lives in the ENGINE, not in one host's hook, because the incident class
// is worst precisely where no Claude hook runs (Codex CLI, Cursor, a
// MCP-only project). Every host calls observeShipDrift at task start and
// drainPendingShips at write time; both take an explicit projectDir so nothing
// depends on a hook's CWD. Two deterministic, zero-network signals only:
// the newest local git tag and package.json's version.
export const shipObsPaths = (projectDir) => ({
    state: path.join(projectDir || '.', '.claude', 'brain-ship-obs.json'),
    queue: path.join(projectDir || '.', '.claude', 'brain-pending-ships.jsonl'),
});
// Every reader/writer below accepts an explicit `paths` ({state, queue}) so a
// caller can keep the observation outside the project. The MCP server's plugin
// mode does (mcp-auto-update.mjs pluginShipObsPaths); hooks keep the default.
const shipPaths = (projectDir, paths) => (paths && paths.state && paths.queue ? paths : shipObsPaths(projectDir));
// Tag names may carry '@' (changesets / lerna: "klypix-mcp@1.43.0"); shell
// metacharacters stay out because the tag is interpolated into a git command.
const SAFE_TAG_RE = /^[\w.@/-]+$/;
const cmpSemver3 = (a, b) => {
    const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0), pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
};
export const writeShipObsState = (projectDir, sig, paths = null) => {
    const { state } = shipPaths(projectDir, paths);
    try { fs.mkdirSync(path.dirname(state), { recursive: true }); fs.writeFileSync(state, JSON.stringify(sig)); return true; } catch { return false; }
};
export const clearPendingShips = (projectDir, { paths = null } = {}) => { try { fs.unlinkSync(shipPaths(projectDir, paths).queue); } catch { /* already gone */ } };

// ── External-state reconcile — migration omission tripwire ───────────────────
// The brain is a NARRATION-capture system: a fact exists only if someone wrote a
// 🧠 marker or a rationale-bearing commit body. Applying a DB migration to prod
// is an OBSERVED side-effect that narrates nothing, so it silently never lands —
// and the brain can't tell a *committed* migration from an *applied* one. These
// two pure functions are the portable seam that closes that blind spot WITHOUT
// making the brain omniscient: no I/O, no DB probe, no network, no credentials. A
// collector (the Claude-Code hook, or the brain_reconcile MCP tool) hands them
// the migration FILES found on disk; they return the ones NO LIVE card references,
// so the surface can PROMPT the human to confirm the rollout — never assert it.
// Recall-first by design: ANY plausible hit counts as "recorded", erring toward
// silence over a false nag.
const MIG_STOP = new Set(['migration', 'migrations', 'sql', 'create', 'alter', 'table', 'drop', 'add', 'update', 'init', 'schema', 'public', 'new', 'fix', 'set', 'col', 'column', 'index']);
// Split on EVERY non-alphanumeric (unlike the shared wordsOf, which keeps _- glued)
// so `20260620000000_canvas_blob_size_limit` and the `#file-…` tag both tokenize
// into the same words a card's prose carries — the precise match signal.
const migWords = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean));

// ── Repeat / redundancy detection ("you already did this in another session") ─
// The PRECISION-first sibling of scoreCardsAgainstQuery. Instead of "related
// context" it answers a sharper question: is the user about to REDO work that's
// already DONE? It scans COMPLETED-work cards ONLY — 🏁 shipped, ✅ resolved,
// ↩︎ superseded — and INCLUDES the Archive (resolved/superseded cards live there,
// which the relevance ranker deliberately skips). Deliberately strict: a high
// score floor + ≥2 distinct query-token hits, because for a NUDGE a false "you
// already did this" is costly (erodes trust) while a miss is cheap (the loose
// recall list still shows below). Returns each card's `kind` so the caller can
// say "reuse it" (shipped/resolved) vs "see what replaced it" (superseded).
// Pure + node-runnable; reuses the one shared tokenizer — no divergent scorer.
// Generic work-verbs establish that a prompt is WORK, not WHICH work — two of
// them shared with a 🏁 ship-card title used to clear the floor ("deploy it"
// flagged two unrelated PR-merge cards; zero true positives all session).
// Excluded from repeat scoring entirely; the loose recall list still sees them.
const REPEAT_VERB_STOP = new Set([
    'deploy', 'deployed', 'deploying', 'deploys', 'ship', 'shipped', 'shipping', 'ships',
    'merge', 'merged', 'merges', 'merging', 'release', 'released', 'releases', 'releasing',
    'publish', 'published', 'publishes', 'publishing', 'push', 'pushed', 'land', 'landed',
    'build', 'builds', 'building', 'built', 'check', 'checked', 'checking', 'checks',
    'plan', 'planned', 'planning', 'plans', 'best', 'class', 'cut', 'hand', 'handoff',
    'report', 'reports', 'live', 'latest', 'done', 'complete', 'completed', 'finish', 'finished',
    'work', 'task', 'feature',
]);
// Entity-shaped token — the kind that pins WHICH work: carries a digit (version,
// PR#), or a kebab/snake identifier. A #file-/#dir- tag-stem match counts as an
// entity at match time regardless of shape (tags are capture-stamped anchors).
const isEntityToken = (t) => /\d/.test(t) || t.includes('-') || t.includes('_');
// ── Legacy raw-bash ship cards (pre-v1.15 auto-capture residue) ──────────────
// Before the v1.15 ship-capture rewrite, auto-harvest dumped the RAW shell command
// into the card ("🏁 merged PR #850 — auto-captured (`cd /c/Users/…/8db42`)") and
// scraped stray path digits as PR numbers ("merged PR #238886"). These are dense
// with generic ship verbs + junk numbers, so the possible-repeat warner kept
// matching them and crying wolf — training agents to ignore repeat warnings. They
// are (a) excluded from detectRepeatWork below and (b) surfaced by findLegacyShip-
// Cards for a one-time cleanup. Detection is SIGNATURE-based (not just "old"), so a
// CLEAN ship card ("Ship: 🏁 merged PR #286") is never touched.
export const isLegacyRawShipCard = (text) => {
    const t = String(text || '');
    if (!/🏁|\bmerged\b|\brelease|\bpublish|\bshipped\b|\btagged\b/i.test(t)) return false;   // ship-shaped only
    return /auto-captured/i.test(t)                              // the explicit pre-v1.15 stamp
        || /`[^`]*\b(?:cd|gh|git|npm|node|npx)\b[^`]*`/i.test(t) // a raw shell command left inside the card
        || /(?:\/c\/users\/|[a-z]:[\\/]+users[\\/]|\/(?:home|users|mnt|tmp)\/)/i.test(t)   // a filesystem-path fragment
        || /\b(?:PR|pull request|#)\s*#?\d{6,}\b/i.test(t);      // a 6+ digit "PR number" = scraped path digits, not a real PR
};

// ── Conflict candidate detection ───────────────────────────────────────────
// REAL conflicts only — a conflict is two decisions that genuinely CONTRADICT
// (you can't honor both about the same thing). Topical similarity, duplication,
// and sequential supersession are explicitly NOT conflicts and must never be
// flagged (no false-conflict dump). This is a cheap LEXICAL pre-filter that
// returns CANDIDATES only — same-subject, not-already-connected pairs where at
// least one card uses explicit REVERSAL language. Candidates mean nothing on
// their own: the caller (brain-conflicts.mjs) confirms each with an LLM
// contradiction-check before anything is ever drawn or surfaced. No verifier →
// nothing surfaces. Pure + node-runnable.
// Strong reversal/contradiction terms ONLY — deliberately NOT bare "not"/"don't"
// (too common → false positives). A candidate still has to clear the LLM gate.
const OPPOSITION_RE = /\b(instead of|reverted?|no longer|dropp(?:ed|ing)?|deprecat\w*|abandon\w*|replaced?\b|supersed\w*|changed from|switch(?:ed)? (?:from|to)|rolled? back|overrod|overrides?|contradic\w*|disagree\w*|conflicts? with|reversed?\b)/i;

// ── Contradiction candidates (reconcile-proper) ──────────────────────────────
// The retroactive cleaner for stale/correction pairs that slipped past capture
// (cross-area + reworded → no supersede possible by construction). Unlike
// detectConflicts (a pre-filter for an LLM verifier), this is precision-scoped
// enough to surface DIRECTLY for human/agent confirmation: same-subject live
// pairs where (a) exactly ONE side carries an explicit correction cue
// (CORRECTION / OBSOLETE / was WRONG / stale note resolved) — that side is the
// presumed truth — or (b) the two sides use OPPOSITE polarity words about the
// same subject (deferred↔wired, broken↔fixed, dead↔live …). Pairs already
// settled by a supersede/close/conflict arrow are excluded; a plain relates_to
// arrow is NOT a settlement. Suggestion-only — never writes. Pure, node-runnable.
const POLARITY_PAIRS = [
    ['deferred', 'wired'], ['deferred', 'shipped'], ['deferred', 'live'], ['deferred', 'enabled'],
    ['broken', 'fixed'], ['broken', 'working'], ['dead', 'live'], ['dead', 'alive'],
    ['disabled', 'enabled'], ['blocked', 'unblocked'], ['wrong', 'correct'], ['removed', 'restored'],
];
// WORD-boundary matchers, precompiled — substring includes() made 'deadline'
// carry the 'dead' pole and 'delivery' carry 'live', and blocked↔unblocked
// could never fire ('unblocked' contains 'blocked').
const POLARITY_RES = POLARITY_PAIRS.map(([x, y]) => ({ x, y, rx: new RegExp(`\\b${x}\\b`), ry: new RegExp(`\\b${y}\\b`) }));

// ── Orphan gardener (1.70.0) — the CONFIDENT auto-link selector ─────────────
// Shared by capture (a new card must not land as a graph orphan) and the
// `orphans` backfill CLI. For each zero-degree live decision/milestone card
// (the brainInsights orphan definition — questions and 🌿/⤵ consolidation
// artifacts are excluded, so counts stay coherent with every other surface),
// it proposes:
//   • areaId  — the card's own area container (always known, always safe), and
//   • anchor  — AT MOST ONE lexical-anchor edge, only when the evidence is
//     unambiguous. Precision over recall, by recorded trap (a live probe once
//     attached unrelated correction overlays): never fan out, never guess
//     among multiple candidates. Confidence ladder, first hit wins:
//       1. exact [[wikilink]] whose text equals exactly ONE other card's title
//       2. exact file-slug tag (#name-ext, e.g. #brain-doctor-mjs) carried by
//          exactly ONE other live card
//       3. ≥0.6 title-token overlap AND ≥3 shared tokens, with exactly ONE
//          candidate above the bar (two qualifying candidates = ambiguous =
//          no edge; two shared words alone are never confident)
// Pure + additive: returns proposals; callers draw the edges. `connections`
// lets capture pass its in-flight (already mutated) edge list so a card linked
// earlier in the same batch is never re-proposed.
const TITLE_OVERLAP_AT = 0.6;
// Two shared words are never confident evidence. Card titles are TRUNCATED
// (~35 chars), so two 3-token titles sharing 2 brain-ubiquitous tokens
// ('klypix'+'canvas', 'open'+'canvas') hit exactly 0.67 and cleared the ratio
// bar alone — field review of the real 2,494-card brain (2026-08-14) found
// ~6 clearly-wrong pairs of 78 built exactly that way ("JSON Canvas importer"
// → "TWO colour systems", "market-sizing slide" → "MAC BUILT"). Requiring ≥3
// shared informative tokens kept 41/78 pairs with a clean spot-check; the
// dropped real pairs stay for brain_connect review (precision over recall,
// by recorded trap).
const TITLE_MIN_HITS = 3;
// No single-letter extensions ('c'/'h'): the real brain carries tags like
// #dir-c that are not file slugs, and a false slug is a guessed edge (field
// dry-run against the 2,494-card brain, 2026-08-14).
const FILE_SLUG_TAG_RE = /^[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*-(?:mjs|cjs|js|ts|tsx|jsx|py|rb|go|rs|md|json|ya?ml|toml|css|html|sql|sh|ps1|swift|kt|java|cs|cpp)$/u;
// Title-overlap tokens: the area prefix ("canvas: …") and glue words inflate
// overlap between ANY two same-area cards — a real 0.60 pair made of 'canvas',
// 'one', 'click', 'the' is a guess, not an anchor (same field dry-run).
const TITLE_STOP = new Set(['the', 'and', 'for', 'with', 'not', 'are', 'was', 'has', 'this', 'that',
    'from', 'into', 'over', 'now', 'new', 'one', 'two', 'all', 'its', 'our', 'you', 'your', 'per',
    'via', 'out', 'off', 'when', 'then', 'than', 'but', 'can', 'get', 'got', 'still', 'more']);
const anchorTitleTok = (s) => new Set(String(s || '')
    .replace(/^[^:\n]{1,40}:\s*/, '')                      // drop the "Area:" prefix
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length >= 3 && !TITLE_STOP.has(w)));

// ── Atomic brain capture: supersede + append + resolve + auto-link ──────────
// One verified write per capture batch. Beyond appendIntoContainers it adds:
//   • SUPERSEDE — a new decision that heavily overlaps an existing live card in
//     the same area archives the old one (↩︎ prefix, gray, → Archive) and draws
//     an old→new "superseded by" arrow, instead of stacking a contradiction.
//   • RESOLVE — resolutions[] (the ✓ marker) finds the best-matching live card
//     in the area, stamps "✅ <date>: <note>" onto it and archives it; if no
//     match, the note lands as a 🏁 milestone so nothing is lost.
//   • AUTO-LINK — [[Title]] in a new card's text becomes a real connection to
//     the card/container whose title matches (the graph stops being decorative).
const tokenSet = (s) => new Set(String(s || '').toLowerCase().replace(/\[\[|\]\]/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4));
const overlapScore = (a, b) => {
    if (a.size < 4 || b.size < 4) return 0;            // too short to judge
    let hit = 0; for (const w of a) if (b.has(w)) hit++;
    return hit / Math.min(a.size, b.size);
};
// A ✓ note is allowed to be terse, but lifecycle/status scaffolding is not a
// card identity. Requiring two matched subject anchors prevents generic subsets
// such as "project card current state shipped" from closing an unrelated rich
// question merely because overlapScore divides by the smaller set. Deliberate
// short targets still have the exact `closes:` mechanism.
const RESOLUTION_GENERIC = new Set([
    'project', 'projects', 'card', 'cards', 'current', 'state', 'status', 'item', 'items',
    'task', 'tasks', 'work', 'issue', 'issues', 'thing', 'things', 'change', 'changes',
    'update', 'updated', 'feature', 'features', 'support', 'supported', 'core', 'system',
    'systems', 'shipped', 'shipping', 'fixed', 'fixing', 'done', 'complete', 'completed',
    'resolved', 'resolving', 'closed', 'closing', 'implemented', 'implementing', 'added',
    'adding', 'ready', 'final',
]);
const hasResolutionIdentity = (source, target) => {
    const anchors = [...source].filter(token => !RESOLUTION_GENERIC.has(token));
    if (anchors.length < 2) return false;
    let matched = 0;
    for (const token of anchors) if (target.has(token) && ++matched >= 2) return true;
    return false;
};
// Fraction of the TARGET set present in `hay` — the right metric for "is this the
// card the user named in `closes:`?". Unlike overlapScore it has NO ≥4-token
// floor, because a close-target is a deliberate, often-short title/phrase (a
// subset of the card), not an accidental same-size similarity. (That floor was why
// a real `closes: v1.2.0 staged as a github draft` — only 3 long tokens — silently
// failed to fire.)
const coverageOf = (target, hay) => { if (!target.size) return 0; let h = 0; for (const w of target) if (hay.has(w)) h++; return h / target.size; };

// ── Truth decay (P1) — corrections must never lose to the cards they correct ─
// A correction-cue note explicitly declares an older fact stale ("CORRECTION:",
// "was WRONG", "OBSOLETE", "stale note resolved"). The same-area ≥0.6 supersede
// can miss it BY CONSTRUCTION (the correction often lands in a different area,
// reworded) — the stale card then stays live and recall serves it alone. Shared
// by: the capture-side widened supersede, the recall-side overlay below, and
// detectContradictions.
// DELIBERATE cue only: the uppercase forms are the documented convention, and
// case-sensitivity is what keeps casual prose ("the floor calc was wrong",
// "remove obsolete helper", "color-correction") from firing a cross-area
// supersede on an innocent card. "stale note resolved" is the one
// natural-language phrase, accepted in any case (it is never incidental).
export const CORRECTION_RE = /\bCORRECTIONS?\b|\bOBSOLETE\b|\bwas WRONG\b/;
const CORRECTION_PHRASE_RE = /\bstale note (?:is )?resolved\b/i;
export const hasCorrectionCue = (t) => CORRECTION_RE.test(String(t || '')) || CORRECTION_PHRASE_RE.test(String(t || ''));
export const CORRECTION_SUPERSEDE_AT = 0.4;   // widened cross-area bar (vs same-area SUPERSEDE_AT 0.6)

// NON-DESTRUCTIVE CONFIRM GUARD (2026-07-23) for ~ updates: content replacement
// is wholesale, so a terse "~ still true" against a rich card used to truncate
// it to the confirmation text — the system had no non-destructive verify verb
// at all. The guard is OPT-IN by shape: only an update that READS as a
// confirmation ("still true", "confirmed", "verified", "unchanged", "holds") is
// appended as a re-affirmed line; anything else — including same-vocabulary
// inversions, terse lowercase corrections, and negations, none of which
// token-set/length heuristics can see (adversarial review live-traced all
// three) — REPLACES, the documented ~ semantics where the new text wins. Digits
// or contrast/negation words disqualify ("still true but port now 9223" is a
// correction). No ✅/↩/⤵ glyphs in the stamp — those would drop the card out of
// liveTextCards matching forever.
const CONFIRM_CUE_RE = /^\s*(?:\(|")?\s*(?:still\b|confirmed?\b|verified\b|unchanged\b|re-?affirmed?\b|holds\b|remains true\b)/i;
const CONFIRM_DISQUALIFIER_RE = /\d|\b(?:not|no|never|but|instead|now|except|however|wrong|longer|actually)\b/i;
const isTerseConfirmUpdate = (text, targetLength) => CONFIRM_CUE_RE.test(String(text || ''))
    && !CONFIRM_DISQUALIFIER_RE.test(String(text || ''))
    && String(text || '').length < targetLength * 0.6
    && !hasCorrectionCue(text);

// UPDATE FLOOR (1.86.1). A ~ that REPLACES its card must carry at least
// UPDATE_MIN_WORDS distinct content words (4+ letters, the tokenSet unit) OR at
// least half as many as the card it replaces. Both halves matter — the absolute
// bar alone would refuse a four-word correction of a four-word card ("Dev
// server runs on port 5174 now"), the ratio alone would let a stub replace a
// card twice its size.
//
// A thinner ~ is neither dropped nor turned into a card of its own: it is
// APPENDED to the card it matched as a dated `(~ amended <date>: …)` line. The
// short correction is exactly what ~ is for, and it has to land on the card it
// corrects — a price change ("$5 monthly" vs "$4 monthly") shares every content
// word with its card, so a separate card was dropped as a near-duplicate of the
// stale one, and a separate "now run from main" card sat live beside the card it
// contradicts. Appending keeps both halves of the promise: the richer card is
// never replaced by a stub, and the correction is on the card.
export const UPDATE_MIN_WORDS = 6;
// The words a card's CONTENT carries: tag-only lines (#area #file-x) are
// routing, not content, and would pad the target's count.
const updateTargetTokens = (text) => tokenSet(String(text || '').split('\n')
    .filter((line) => !/^\s*(?:#[\p{L}\p{N}_-]+\s*)+$/u.test(line)).join('\n'));
export const isThinUpdate = (words, targetWords) => words < UPDATE_MIN_WORDS && words * 2 < targetWords;
// A catch handler that itself throws would defeat the containment it is there
// for, so the two fields a failure is reported with are read defensively: the
// thing that just failed may be exactly the thing whose property throws.
const errText = (error) => { try { return String((error && error.message) || error).slice(0, 160); } catch { return 'unknown error'; } };
const SAY_WORD_CHAR = /[\p{L}\p{N}]/u;
const codePointBefore = (s, i) => { if (i <= 0) return ''; const lo = s.charCodeAt(i - 1); return (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) ? s.slice(i - 2, i) : s[i - 1]; };
const codePointAt = (s, i) => (i >= s.length ? '' : String.fromCodePoint(s.codePointAt(i)));
// A thin ~ is appended UNDER the claim it corrects (the claim is never replaced
// by a stub), so a one-line preview that shows only a card's head showed the
// stale claim alone — prompt-time recall prints ~120 characters, and "Dev
// server port changed to 5174 now" on a 190-character card never appeared
// there (review 2026-09-18). Previews render the NEWEST amendment first; the
// stored card is untouched (its title still names the claim, which is what
// closes: and ✓ match against).
//
// Third review (2026-09-18) — what a preview may NOT reorder:
//   • a leading lifecycle stamp ("↩︎ superseded …", "⤵ consolidated …") stays
//     first, and the amendment goes right after it: the repeat nudge shows
//     superseded cards, and one that opened with the amendment read as live;
//   • a newer "(re-affirmed …)", "✔ …" or "✅ …" line after the amendment
//     means the amendment is not the newest word, so the text is left as is;
//   • the run is the amendment's own lines only: it continues across a wrap
//     join (the previous line is a full mid-word chunk, or the next line's
//     first word would not have fitted on it) while its "(" is still open —
//     a human line added under a one-line amendment is not absorbed into it.
const parenBalance = (l) => (l.match(/\(/g) || []).length - (l.match(/\)/g) || []).length;
// Cue META words describe the act of correcting, not the subject — left in, they
// dilute the overlap denominator and push real correction pairs just under the
// bar (the field fixture lands at 0.375 with them, 0.5 without). Stripped before
// every correction-overlap comparison.
const CORRECTION_META = new Set(['correction', 'corrections', 'obsolete', 'stale', 'note', 'notes', 'resolved', 'wrong']);
const stripCueMeta = (set) => { const out = new Set(); for (const w of set) if (!CORRECTION_META.has(w)) out.add(w); return out; };
// Long-card reality: a correction's SUBJECT is a fraction of each card — the
// overlap COEFFICIENT alone punishes long↔long pairs (the real field pair
// measures 0.33 with 17 shared subject tokens, under every per-ratio bar). A
// cue-gated match therefore also fires on ABSOLUTE subject mass: ≥10 shared
// meaningful tokens at ≥0.25 coefficient. Cue-gated ONLY — plain supersede and
// polarity pairs keep their strict ratio bars (no cue prior to lean on).
const CUE_STRONG_SHARED = 10, CUE_RELAXED_COEF = 0.25;
// Floor 3 (not overlapScore's 4): after stripCueMeta a terse deliberate
// correction ("CORRECTION: the vault default was WRONG — use cwd") keeps only
// 3-ish subject tokens; at 4 it silently no-oped. ≤2-token corrections still
// no-op (too little signal to archive on) — they land as a new card; use ~ to
// edit a card in place instead.
const cueMatch = (a, b, bar) => {
    if (a.size < 3 || b.size < 3) return 0;
    let inter = 0; for (const w of a) if (b.has(w)) inter++;
    const coef = inter / Math.min(a.size, b.size);
    return (coef >= bar || (inter >= CUE_STRONG_SHARED && coef >= CUE_RELAXED_COEF)) ? coef : 0;
};

// A correction chain can make a full round trip: A→B→C, where C deliberately
// restores A's stance. The ordinary supersede path correctly preserves A→B→C,
// but C used to carry no read-alone receipt of that history. Detect only the
// high-confidence shape: B has an explicit superseded ancestor A, and C strongly
// matches A INCLUDING stance tokens that distinguish A from B. An intentional
// restore/revert cue permits a lower (still evidence-bearing) threshold; cue-less
// returns fire only when C is near-identical to A and clearly closer to A than B.
// That last condition keeps a novel D on the same subject from being mislabeled.
// Cues name a DECISION return, not merely a domain operation. Bare "restore"
// is intentionally absent: "restore backup verification; keep SQLite" must
// not claim that the Redis decision returned. `restore … to` remains available
// for explicit prose, and the similarity gap below still has to favor A over B.
const READOPT_ACTION = String.raw`(?:re-?adopt(?:s|ed|ing)?|reinstat(?:e|es|ed|ing)|revert(?:s|ed|ing)?\s+(?:back\s+)?to|return(?:s|ed|ing)?\s+(?:back\s+)?to|roll(?:s|ed|ing)?\s+back(?:\s+to)?|switch(?:es|ed|ing)?\s+back(?:\s+to)?|back\s+to|once\s+again|restor(?:e|es|ed|ing)\b(?:\s+[\p{L}\p{N}_-]+){0,12}\s+to)`;
const READOPT_CUE_RE = new RegExp(`\\b${READOPT_ACTION}\\b`, 'iu');
// Negation must bind to the return action itself. A small whitelist of nearby
// adverbs/helpers catches “not ever return”, “never go back”, and “must not
// switch back” without letting a distant negation cross subject prose or
// punctuation: “do not use B; return to A” is an affirmative re-adoption.
const READOPT_NEGATION_FILLER = String.raw`(?:ever|again|once|now|currently|actually|really|simply|merely|explicitly|deliberately|intentionally|immediately|directly|go|going|to)`;
const NEGATED_READOPT_CUE_RE = new RegExp(
    `\\b(?:do\\s+not|don'?t|never|avoid|without|not)\\s+(?:${READOPT_NEGATION_FILLER}\\s+){0,3}${READOPT_ACTION}\\b`,
    'iu',
);
const READOPT_META = new Set([
    'correction', 'corrections', 'obsolete', 'stale', 'note', 'notes', 'resolved', 'wrong',
    'supersede', 'superseded', 'supersedes', 're-adopt', 're-adopts', 'readopt', 'readopts',
    'reinstate', 'reinstates', 'reinstated', 'restore', 'restores', 'restored', 'restoring',
    'revert', 'reverts', 'reverted', 'reverting', 'return', 'returns', 'returned', 'returning',
    'reversal', 'reversed', 'again', 'back', 'earlier', 'original', 'prior', 'previous',
    'position', 'stance', 'decision', 'decisions', 'archive', 'archived', 'card', 'cards',
    'marker', 'history', 'lineage', 'graph', 'edge', 'stamp', 'today', 'dated',
]);
const readoptTokens = (text) => {
    const cleaned = String(text || '')
        // Strip engine-authored lineage dates, not authored config values: a
        // 30-day→7-day→30-day return is stance evidence just like Redis→SQLite.
        .replace(/^↩︎?\s*superseded\s+\d{4}-\d{2}-\d{2}\s*/iu, ' ')
        .replace(/\n\s*↪\s*re-adopts\s+\d{4}-\d{2}-\d{2}:[\s\S]*$/iu, ' ');
    // Unlike the general lexical gateway (currently English/ASCII), lifecycle
    // identity must survive decisions written in Arabic, Cyrillic, and other
    // scripts. Keep the same three-character floor and English stopword policy,
    // but tokenize letters/numbers with Unicode properties.
    const words = cleaned.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) || [];
    const numeric = cleaned.match(/\b\d+(?:\.\d+)*\b/g) || [];
    return new Set([...words, ...numeric].filter(t => !STOPWORDS.has(t) && !READOPT_META.has(t)));
};
// Keep the raw tokens. `stemLight()` is intentionally unsafe as a bare set key
// (state↔stats is one known collision); every suffix-tolerant comparison must
// pass through `matchesStem`, which verifies that one raw form actually strips
// onto the other. Use symmetric Dice similarity for "near-identical": the old
// overlap coefficient treated A plus an arbitrarily large novel suffix as 1.0.
const safelyMatches = (token, set) => {
    for (const candidate of set) if (matchesStem(token, candidate)) return true;
    return false;
};
// Maximum bipartite matching makes the score one-to-one. Without it, several
// variants (pack/packed/packs) could all consume the same token and inflate a
// Dice score or the ancestor-specific evidence count.
const matchedTokenCount = (a, b) => {
    const left = [...a], right = [...b];
    const rightOwner = new Array(right.length).fill(-1);
    const claim = (leftIndex, seen) => {
        for (let rightIndex = 0; rightIndex < right.length; rightIndex++) {
            if (seen.has(rightIndex) || !matchesStem(left[leftIndex], right[rightIndex])) continue;
            seen.add(rightIndex);
            if (rightOwner[rightIndex] === -1 || claim(rightOwner[rightIndex], seen)) {
                rightOwner[rightIndex] = leftIndex;
                return true;
            }
        }
        return false;
    };
    let hit = 0;
    for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
        if (claim(leftIndex, new Set())) hit++;
    }
    return hit;
};
const setSimilarity = (a, b) => {
    if (!a.size || !b.size) return 0;
    return (2 * matchedTokenCount(a, b)) / (a.size + b.size);
};
const findReadoptedAncestor = (struct, replaced, newText) => {
    const text = String(newText || '');
    if (NEGATED_READOPT_CUE_RE.test(text)) return null;
    const hasCue = READOPT_CUE_RE.test(text);
    const byId = new Map((struct.cards || []).map(c => [c.id, c]));
    const next = readoptTokens(text);
    const current = readoptTokens(replaced?.text);
    if (next.size < 3 || current.size < 3) return null;
    const currentSimilarity = setSimilarity(next, current);
    const incoming = new Map();
    for (const cn of struct.connections || []) {
        if (cn.label !== 'superseded by' || !cn.fromId || !cn.toId) continue;
        if (!incoming.has(cn.toId)) incoming.set(cn.toId, []);
        incoming.get(cn.toId).push(cn.fromId);
    }
    const candidates = [];
    const queue = (incoming.get(replaced?.id) || []).map(id => ({ id, depth: 1 }));
    const seen = new Set([replaced?.id]);
    while (queue.length) {
        const { id, depth } = queue.shift();
        if (!id || seen.has(id) || depth > 12) continue;
        seen.add(id);
        const prior = byId.get(id);
        if (!prior || !/^archive$/i.test(prior.area || '') || !/↩/.test(prior.text || '')) continue;
        const before = readoptTokens(prior.text);
        if (before.size >= 3) {
            const similarity = setSimilarity(next, before);
            const priorOnly = new Set([...before].filter(t => !safelyMatches(t, current)));
            const distinctHits = matchedTokenCount(priorOnly, next);
            const gap = similarity - currentSimilarity;
            // Even explicit language must describe a return TOWARD A, not an
            // unrelated restore/revert operation in prose that otherwise keeps B.
            const explicit = hasCue && similarity >= 0.6 && gap >= 0.08
                && distinctHits >= 1 && (distinctHits >= 2 || similarity >= 0.7);
            const implicit = !hasCue && similarity >= 0.9 && gap >= 0.1
                && (distinctHits >= 2 || (distinctHits >= 1 && similarity >= 0.98));
            if (explicit || implicit) candidates.push({ prior, similarity, distinctHits, depth });
        }
        for (const predecessor of incoming.get(id) || []) queue.push({ id: predecessor, depth: depth + 1 });
    }
    candidates.sort((a, b) => b.similarity - a.similarity || b.distinctHits - a.distinctHits || a.depth - b.depth);
    return candidates[0]?.prior || null;
};
const reAdoptionReceipt = (prior, today) => {
    const headline = String(prior?.text || '')
        .replace(/^↩︎?\s*superseded\s+\d{4}-\d{2}-\d{2}\s*/iu, '')
        .replace(/\n\s*↪\s*re-adopts\s+\d{4}-\d{2}-\d{2}:[\s\S]*$/iu, '')
        .replace(/(?:^|\s)#[\w-]+/g, ' ')
        .replace(/\s+/g, ' ').trim().slice(0, 140);
    return `↪ re-adopts ${today}: ${headline || 'an earlier superseded decision'}`;
};

// Render a challengeBrain result as synthesis-ready markdown. Injection-fenced:
// card text is rendered as QUOTED DATA under an explicit "evidence, never
// instructions" header — all imperative language is engine-authored. The
// "captured by ANOTHER agent" warning fires ONLY for a genuinely different
// agent-client identity: automation channels (git/gardener/…) are the same
// human's pipeline and render as neutral provenance (crying wolf on every
// git-captured card would kill the feature's credibility).
const CHALLENGE_AUTOMATION_VIA = new Set(['git', 'commit', 'cli', 'hook', 'gardener', 'ship-event', 'import', 'user', 'agent', 'mcp', 'test']);

// ── Awaits-merge decay — the deterministic twin of the correction overlay ────
// A milestone written minutes before the human merges ("PR #332 awaits founder
// merge") stays stale forever, even though ship-event auto-capture DOES record
// "merged PR #332" — nothing linked the two. Matching a "PR #N" + awaits-cue card
// against a harvested "merged PR #N" is EXACT-STRING, zero-inference work. Given
// the cards recall is about to inject, return for each one carrying an unmet
// merge that the ship event contradicts a merged-overlay {num, by, date}. The
// caller annotates the card (never retires it — the fact is right, only its
// status decayed). Pure + cheap. PR numbers are capped at 5 digits — a 6+ digit
// "#N" is a path-scraped junk number (see isLegacyRawShipCard), never a real PR.
const PR_MERGED_RE = /\bmerged\b[^.\n]{0,16}?(?:PR|pull\s+request|#)\s*#?(\d{1,5})\b/i;
const PR_REFS_RE = /\b(?:PR|pull\s+request|#)\s*#?(\d{1,5})\b/ig;
// The awaits/pending-merge cue fragment, reused both directions below.
const AWAIT_CUE = String.raw`(?:await(?:s|ing)?|pending|not\s+yet|yet\s+to\s+be|unmerged|needs?)\b[^.\n]{0,20}?merg`;

// ── Auto-skill classifier (skills emerge from the flow, not just the '+' marker) ─
// A REUSABLE skill (how-to / gotcha / convention) reads as a GENERAL RULE that
// applies next time — distinct from a one-time decision ("we shipped X"). This is
// the high-precision signal the capture path uses to AUTO-promote a plain decision
// or a rationale-bearing commit into a 🛠️ skill, so the brain learns "how we work
// here" without anyone remembering to type '+'. Deliberately conservative: STRONG
// rule cues only, and NOT pinned to a one-time event (a version/PR#/date/ship verb
// makes it "what happened", not "how to do it"). The explicit '+' marker always
// wins and covers everything this misses; a false miss is cheap, a false skill is
// noisy — so this errs toward silence.
const STRONG_SKILL_CUES = /(\balways\b|\bnever\b|\bmust\s+(?:not|always)\b|\bdon'?t\s+(?:ever|forget)\b|\bgotcha\b|\bwatch\s+out\b|\bthe\s+trick\s+is\b|\brule\s+of\s+thumb\b|\bby\s+convention\b|\bpitfall\b|\bfootgun\b|\bremember\s+to\b|\bbe\s+sure\s+to\b)/i;
const SKILL_EVENT_PINS = /(\bv?\d+\.\d+\.\d+\b|\bPR\s*#?\d+\b|#\d{2,}\b|\b20\d{2}-\d{2}-\d{2}\b|\bshipped\b|\breleased\b|\bpublished\b|\bmerged\b|\bdeployed\b)/i;

// ── Trap classifier — the draft-a-rule signal (capture-coverage, 2026-07-17) ──
// A "trap" is a finding that WILL RECUR: a failure mode or a corrective "do X, not
// Y" rule — as opposed to a one-time event ("we shipped X"). looksLikeSkill above
// only fires on STRONG imperative cues (always / never / must not / gotcha) and
// AUTO-promotes those to 🛠️ skills at capture. But most hard-won fixes read as
// FAILURE shapes WITHOUT an imperative verb — "root cause was a race in the lock",
// "the fix was to project the diagonal instead of max(scaleX,scaleY)", "it silently
// threw on an empty list" — so they land as PLAIN decision cards that only resurface
// on a lexical phrasing match. That's the founder-surfaced capture-coverage gap: the
// fix is effectively un-recallable unless someone remembered the exact words. This
// classifier detects that broader trap surface. It is DELIBERATELY never used to
// auto-write a card (that is the blind-auto-capture noise the brain refuses) — it
// only gates a DRAFT the human/agent must approve, so it can afford to be broader
// than looksLikeSkill while the draft's verify-gate + per-session cap keep the
// surfaced volume tight. Precision-first all the same: a false miss is cheap (emit
// a `+` marker by hand), a false draft is mild noise in one footer line.
const TRAP_CONTRAST = /(\bnever\b|\bmust(?:\s+not)?\b|\bdon'?t\b|\binstead\s+of\b|\brather\s+than\b|,\s*not\b|\bnot\s+\w+\s+but\b|\bavoid\b|\bbeware\b|\bwatch\s+out\b)/i;
// NOTE: no bare `\bstale\b` — it's domain vocabulary in a memory tool (stale card /
// stale install), a systematic false-positive with near-zero true-trap value (a real
// staleness trap always carries another cue). Fixtures wouldn't catch that; the real
// 790-card brain did (29 plain cards matched it, ~all noise). Precision > recall here.
// broke/breaks/broken carry a negative lookahead for the DECOMPOSITION idiom ("broke
// App.tsx into 13 hooks", "broke out the retry logic") — that's a refactor milestone,
// not a failure trap. A real breakage ("broke Alt+Space", "the exporter breaks on
// rotated strokes") has no into/apart/up/out/down after it, so it still fires.
const TRAP_FAILURE = /(\bgotcha\b|\bpitfall\b|\bfootgun\b|\broot\s+cause\b|\bregress\w*|\bsilently\b|\brace\s+condition\b|\bdead\s?locks?\b|\bmemory\s+leaks?\b|\bleaks?\b|\boff[-\s]?by[-\s]?one\b|\bTDZ\b|\bzombies?\b|\bhangs?\b|\bwedges?\b|\bthe\s+(?:real\s+)?(?:fix|bug|culprit|cause|problem|issue)\s+(?:was|is|turned)\b|\bturns?\s+out\b|\bculprit\b|\b(?:broke|breaks?|broken)\b(?!\s+(?:\w[\w.]*\s+)?(?:into|apart|up|out|down)\b)|\bcrash\w*|\bthrows?\b|\bthrew\b|\bcorrupt\w*|\bflak\w*|\bnull\s+(?:pointer|deref|ref)\b)/i;

// ── ✔ partial notes are written ONCE (1.85.0 — live data damage) ─────────────
// A FULL resolve is idempotent: the card is archived, so the same ✓ marker
// never matches again. A PARTIAL resolve is NOT — the card deliberately stays
// live — and the Claude-Code hook re-pushes every ✓ marker still visible in the
// transcript at every Stop, on the documented promise that a resolve is
// idempotent. So the same note appended forever. Measured in the KLYPIX brain
// on 2026-09-15: one card carried 85 ✔ partial lines (5 distinct notes),
// three others 31 / 9 / 9. The promise is the ENGINE's to keep — a fix in one
// host would leave every other host still writing the damage.
//
// Two things make the comparison non-obvious:
//   · rewriteCard hard-wraps every card it touches, so a stored note is split
//     across several lines — it has to be read as a RUN, flattened.
//   · the " — still open: …" tail legitimately drifts (each appended note
//     changes what the clause scanner sees on the next pass), and the disk copy
//     truncates the body to 100 chars while the in-memory mirror keeps it whole.
//     So the identity is the note BODY, date and tail excluded.
export const PARTIAL_NOTE_PREFIX = '✔ partial ';
const PARTIAL_NOTE_TAIL = ' — still open:';
// A ~ amendment line (1.86.1) also starts its own line and ends a note run —
// without it an amendment after a ✔ partial note was read as part of that
// note, its key changed, and the partial note re-stacked on the next ✓.
const PARTIAL_RUN_END_RE = /^(?:✅|↩|⤵|\(re-affirmed|\(~ amended)/u;

// ── Brain gardener — sleep-time consolidation with a visible audit trail ─────
// The portable engine twin of the in-app /garden (so ANY agent can run it over
// MCP, not just the KLYPIX canvas). Two phases, like brain_connect: the engine
// SELECTS deterministically (the model never decides WHAT merges, only writes the
// prose), the agent writes one synthesis per area, then the engine APPLIES — each
// area gets a 🌿 synthesis card; the originals are stamped "⤵ consolidated", moved
// to Archive, and arrowed → the synthesis. Nothing is deleted (archived verbatim).
const GARDEN_KEEP_NEWEST = 8;       // per area, never consolidate the newest N
const GARDEN_MIN_AGE_DAYS = 14;     // only cards older than this are candidates
const GARDEN_AUTO_MIN_AGE_DAYS = 7; // #auto ship-event cards age out sooner — the durable fact usually also exists as a hand-written milestone
const GARDEN_MIN_CANDIDATES = 3;    // don't bother merging fewer than this
const GARDEN_MAX_DEGREE = 1;        // SMART guard: protect load-bearing cards —
//   only consolidate cards with ≤ this many connections (orphans + leaves). A
//   card the graph leans on (degree ≥ 2) is signal, not noise, and is left alone.
// Areas the gardener must never touch: human steering + config + its own output.
const GARDEN_PROTECTED = /^(archive|📌?\s*focus|(🤖\s*)?(agent\s+)?instructions|open questions|pending)/i;
// Faithfulness guard: a synthesis shorter than this (after whitespace-collapse)
// is treated as degenerate (model returned a stub) and its area is skipped.
const MIN_SYNTHESIS_CHARS = 60;
// Distinct "figures" worth never losing — tokens carrying ≥2 digits (versions
// 1.3.7, dates 2026-06-24, sizes 50mb, counts 326, migration ids). Trivial single
// digits (1, 3) are ignored. Used to append any prose-dropped figure verbatim.
const figuresIn = (text) => {
    const out = new Set();
    for (const m of String(text || '').matchAll(/[0-9][0-9a-zA-Z._:-]*/g)) {
        const tok = m[0].replace(/[._:-]+$/, '').toLowerCase();
        if ((tok.match(/\d/g) || []).length >= 2) out.add(tok);
    }
    return out;
};

// ── Claim engine (2026-07-23, Week 2-3 of the truth-maintenance plan) ────────
// THE one shared claim extractor — every fulfillment surface (capture-time
// cross-check, brain_reconcile mode:'claims', findStaleOpenCards, the brief's
// ⏳ section) calls THIS, never a private regex twin (the design review killed
// four divergent implementations). A "claim" is a cue-anchored open clause
// inside ANY live card ("remaining: X + Y", "next: Z") — the incident class:
// prose claims invisible to the ❓/🎯 glyph-gated lifecycle. Multi-item clauses
// split on + / · / ; so partial fulfillment stays visible ("covers X, does NOT
// cover Y" — approving the covered half must not retire the uncovered half).
// Cue precision (adversarial review 2026-07-23): bare 'left' is GONE (CSS
// `left: 12px`, "left the meeting at 15:30" were probe-confirmed extractions),
// and 'next'/'awaits' require an IMMEDIATE colon — the 40-char bridge let
// `await client.messages.create({ model: … })` become a claim. Claim tokens
// are stopword- and URL-free: raw tokenSet keeps any ≥4-char word, so
// from/this/with/https/github cleared the 0.6 coverage bar against unrelated
// milestones (four probe-confirmed FP classes, incl. the live dogfood noise).
// Cue vocabulary is single-sourced: the clause matcher and the line-boundary
// preserver below must never drift apart (a cue the matcher knows but the
// preserver doesn't gets its line silently merged into the clause above it).
const CLAIM_CUE_WORDS = String.raw`remaining|pending|still\s+to\s+do|to-?do|outstanding|open\s+items?`;
const NEXT_CUE_WORDS = String.raw`next|awaits?`;
const CLAIM_CUE_RE = new RegExp(String.raw`\b(?:${CLAIM_CUE_WORDS})\b[^:\n]{0,40}:\s*([^\n]+)|\b(?:${NEXT_CUE_WORDS})\s*:\s*([^\n]+)`, 'gi');
const CUE_LINE_RE = new RegExp(String.raw`^\s*(?:${CLAIM_CUE_WORDS}|${NEXT_CUE_WORDS})\b[^:\n]{0,40}:`, 'i');
const claimTokens = (s) => new Set([...tokenSet(String(s || '').replace(/https?:\/\/\S+/g, ' '))].filter(t => !STOPWORDS.has(t)));
// ── Morphology + rarity (2026-07-29 incident) ────────────────────────────────
// The incident pair shared the brain's rarest tokens (binariesgithubrelease,
// node-llama-cpp) yet measured 0.21 flat coverage: the ❓ was a 42-token
// forensic narrative, the 🏁 a terse fix, and tokenSet is morphology-blind
// (excludes/excluding, packaged/packaging all count as misses). Two additions,
// both feeding the SAME suggestion-only pipeline — the generic 0.6 bar stays:
//   · stemLight — a deliberately tiny suffix stripper (ing/ed/es/s + trailing
//     double consonant + trailing e) applied at COMPARISON time only, never to
//     stored tokens, so no other consumer's token sets change;
//   · anchor tokens — a token whose stemmed form appears in ≤ANCHOR_DF_MAX live
//     cards is near-unique in the brain; an open↔milestone pair sharing ≥2 such
//     anchors (same area; ≥3 cross-area) is hint-worthy regardless of flat
//     coverage. Rare-by-construction, so the genericity guard stays meaningful.
// Suffix stripping is deliberately conservative and, crucially, only ever
// consulted through matchesStem below — a bare stem comparison collides distinct
// vocabulary (state↔stats, notes↔noting, cares↔caring all collapse), and one
// collision is enough to be the tipping anchor on an unrelated pair
// (2026-07-29 review, CONFIRMED: 'rotation state' vs 'cost stats').
export const stemLight = (w) => {
    let s = String(w);
    if (s.length >= 6 && /(?:ing|ed)$/.test(s)) s = s.replace(/(?:ing|ed)$/, '');
    else if (s.length >= 5 && /[^s]s$/.test(s)) s = s.replace(/es$|s$/, '');
    if (s.length >= 5 && /(.)\1$/.test(s)) s = s.slice(0, -1);
    if (s.length >= 5 && s.endsWith('e')) s = s.slice(0, -1);
    return s;
};
// Two RAW tokens are the same word only if one is at most one suffix-strip away
// from the other. excludes↔excluding passes (each strips to the same form AND
// one strips onto the other's stem); state↔stats does not (neither raw form is
// the other's stem). This is the guard that makes stemming safe to use as
// evidence rather than merely as a recall boost.
export const matchesStem = (a, b) => a === b || stemLight(a) === b || a === stemLight(b);
// Stem→raw-tokens index: comparison keys on the stem (cheap set intersection),
// but every accepted match is re-validated on the RAW words behind it.
export const stemIndex = (tokens) => {
    const m = new Map();
    for (const t of tokens) { const s = stemLight(t); if (!m.has(s)) m.set(s, new Set()); m.get(s).add(t); }
    return m;
};
export const stemSet = (tokens) => new Set(stemIndex(tokens).keys());
const rawMatch = (aRaws, bRaws) => { for (const x of aRaws || []) for (const y of bRaws || []) if (matchesStem(x, y)) return true; return false; };
// Rarity is RELATIVE to corpus size: an absolute df≤4 meant that in a young
// brain (or any area with ≤4 cards) EVERY token was "rare" — including the
// area-name prefix every stored card carries, which handed same-area pairs a
// free anchor (2026-07-29 review, CONFIRMED: an SSO ship "fulfilling" a
// changelog question on [releas, enterpris]).
const anchorDfMax = (liveCount) => Math.max(2, Math.ceil(0.02 * Math.max(0, liveCount)));
// Tokens a pair shares BY CONSTRUCTION are never evidence: the area name (every
// stored card is written "<Area>: …" and containers carry it too) and its #tag
// slug. Cheap per-call set — areas are short.
const structuralStems = (...areas) => {
    const out = new Set();
    for (const a of areas) for (const t of stemSet(tokenSet(String(a || '').replace(/[^\p{L}\p{N}]+/gu, ' ')))) out.add(t);
    return out;
};
// Anchors must CORROBORATE topical overlap, never substitute for it entirely:
// a small coverage floor keeps two rare words from pairing cards that share
// nothing else.
const ANCHOR_COV_FLOOR = 0.15;
const anchorsSufficient = (anchors, sameArea, cov = 1) =>
    anchors.length >= (sameArea ? 2 : 3) && cov >= ANCHOR_COV_FLOOR;
// Serve-time acceptance for a whole-card claim, mirroring the capture paths'
// size floors (it.tokens.size≥2 / oTok.size≥3 / tk.size≥4). Without one, a
// 2-token open card ("Release: ❓ npm publish?") is trivially covered by any
// milestone reusing its words, cross-area, at cov 1.0 (2026-07-29 review,
// CONFIRMED) — and a ⏳ flag instructs the reader not to treat it as open.
// Small claims must therefore earn a hint through rare anchors, never coverage.
const SERVE_COV_BAR = 0.35;
const SERVE_MIN_STEMS = 3;
export const serveTimeAccepts = (lex, sameArea) =>
    anchorsSufficient(lex.anchors, sameArea, lex.cov)
    || ((lex.size || 0) >= SERVE_MIN_STEMS && lex.cov >= SERVE_COV_BAR);
// ── Plan↔🏁 pairing (2026-08-23) — ONE scorer for every plan-card surface ───
// Two acceptance tiers, because the surfaces differ in how much the QUESTION
// already constrains the pair:
//   · 'answer' — inside one brain_ask hit set, where both cards already matched
//     the same question: the ❓ pass's own bars (embedding ≥ PLAN_PAIR_SIM_ANSWER
//     plus any lexical corroboration, or lexical alone at the serve bars).
//   · 'brain'  — against EVERY live newer 🏁 (per-prompt recall, brain_sync
//     context, SessionStart self-heal, reconcile), where nothing constrains the
//     pair but the two texts: near-duplicate similarity (PLAN_PAIR_SIM_BRAIN)
//     plus lexical corroboration, or the self-heal's strict lexical bars
//     (coverage ≥ 0.6, or rare shared anchors) without embeddings.
// MEASURED on the KLYPIX brain (2026-08-23, 61 plan-shaped cards under the
// wider draft classifier × 890 🏁, BGE-small cosines; the shipped classifier
// keeps 25 of them and reproduces 18 pairs at 0.80–0.93): true plan→ship
// pairs sat at 0.81–0.93; the false pairs
// the looser answer tier admitted brain-wide sat at 0.68–0.77 ("Marketing piece
// #2 planned" ↔ an npm publish, a lock-plan doc ↔ an image-decode fix). The
// incident pair itself — a RENAMED feature: cov 0.20, zero anchors — measures
// 0.811 against its ship card, so 0.80 is the floor this tier must keep, and
// the 0.77→0.81 gap is thin: the constant is exported for RE-MEASUREMENT
// (scripts/brain-eval in the KLYPIX repo), never tuned by feel.
// Best milestone = highest score, a near-tie (≤ 0.1) broken toward the EARLIEST
// 🏁: a plan ships once, and later 🏁s that reuse its vocabulary are follow-ups
// (the Forge feasibility card's top-score pair was a later unrelated ship
// until this rule). Bounded O(plans × milestones) with milestones tokenized
// once; returns Map<planId, { kind:'plan', by, byId, cov, sim, via, unconfirmed }>.
// Suggestion-only by construction — nothing here writes or retires.
export const PLAN_PAIR_SIM_ANSWER = 0.55;
export const PLAN_PAIR_SIM_BRAIN = 0.80;
// Imperative-ask cue (2026-07-29): a narrative ❓ card often carries no
// colon-anchored "remaining:" clause — its ask is an imperative sentence
// ("Narrow the prune … and verify a packaged answer E2E"). For OPEN-shaped
// cards only (❓/🎯 in text — a milestone's prose stays exempt), such sentences
// become claim clauses, so the ASK is the coverage denominator instead of the
// whole diagnosis. Curated base-form verbs, sentence-initial, ≥8 chars of
// payload — commit-style "fix:" prefixes never reach here (no ❓/🎯).
const IMPERATIVE_ASK_RE = /(?:^|[.!?]\s+)((?:narrow|fix|verify|ship|wire|apply|investigate|add|restore|re-?run|prove|close|migrate|land|publish|deploy|implement|rotate|upgrade|remove|rename|extend|measure|benchmark|audit|rehydrate|persist|surface)\b[^\n.!?]{8,160})/gi;

// ── 🛠️↔🏁 obsolescence (2026-08-01 field incident) ──────────────────────────
// A 🛠️ skill that encodes a TEMPORARY limitation is more dangerous stale than
// an open ❓: skills are BUILT to resurface every session, never age out, and
// carry a ranking boost — so when a later 🏁 removes the limitation, the wrong
// half keeps outranking the fix for any question phrased around the limitation.
// Field case: an agent told the founder "Chat can talk but not act" off skill
// 32d1c2a ("Chat (Gemini Flash) has no tools…") while milestone 2440361 — SAME
// DAY — had shipped native tool-use in chat. An open ❓ at least reads as
// unsettled; a 🛠️ reads as settled law. The ❓↔🏁 machinery cannot see this
// class (skills are excluded from claim sources BY DESIGN, and must stay
// excluded — a milestone must never archive advice), so this is its sibling:
// detect and HEDGE, never retire. Retiring a rule stays a human act.
//
// The extractor is the precision gate. It matches STATE claims — sentences
// asserting what the system currently does or lacks ("has no tools", "returns
// mock streams", "not implemented") — and refuses IMPERATIVE advice ("never
// set backgroundThrottling:false", "always dedup zKeys"), which is the
// evergreen content skills exist for. A skill with no state claim can never be
// flagged, so the failure mode of an over-eager cue is a missed hint, not a
// slandered rule.
const LIMITATION_CUE_RE = new RegExp([
    /\b(?:has|have|had) no \p{L}/u.source,
    /\bno \p{L}+ (?:yet|at all|anywhere)\b/u.source,
    /\bcan(?:not|['’]t) \p{L}/u.source,
    /\b(?:does|do)(?:es)?(?: not|n['’]t) (?:support|have|act|work|exist|persist|stream|fire|write|read|speak|run|apply|reach|see|know|check|enforce)\b/u.source,
    /\bnot (?:implemented|wired|supported|available|built|shipped|published|deployed|enforced|persisted|possible|reachable|exposed|functional)\b/u.source,
    /\breturns? (?:a )?(?:mock|stub|null|nothing)\b/u.source,
    /\bis (?:dead|unused|missing|absent|unreachable|unwired|talk[- ]?only)\b/u.source,
    /\bonly (?:works|runs|streams|answers|covers|supports|reads|checks|compares|matches|lowercases|normalizes)\b/u.source,
    /\bstill (?:missing|absent|manual|unwired|blocked|mocked?)\b/u.source,
    // 2026-08-01, first real-world miss (the day after shipping): the presence-
    // bugs skill card asserted "compares hostPid ALONE", "only lowercases+slash-
    // normalizes" and "indistinguishable from success" — all state claims, none
    // matched a cue, so the card kept reading as settled law for a full session
    // after ab10688 had fixed every one of them. Cues grow ON-DEMAND from real
    // misses, never speculatively — each addition below names its incident.
    /\b(?:compares?|keys?|keyed|matches?) [\p{L}\p{N}_-]+ alone\b/u.source,
    /\bindistinguishable from\b/u.source,
    /\bsilently (?:miss(?:es|ed)?|fail(?:s|ed)?|drop(?:s|ped)?)\b/u.source,
].join('|'), 'iu');
// Imperative openers = advice, not state. Anchored to the CLAUSE start so
// "Chat has no tools" (subject-first) passes while "never set X" is refused.
const ADVICE_OPENER_RE = /^(?:never|always|do not|don['’]t|avoid|prefer|remember|must|treat|use|keep|before|when|if)\b/i;

// ── Open-question deadline awareness ─────────────────────────────────────────
// An open card can carry a self-declared deadline ("Rotate NPM_TOKEN before
// ~2026-07-03"). Once that day passes the card is OVERDUE — but nothing surfaced
// it, so it decayed silently and served the same stale reminder a day late. This
// parses an EXPLICIT, cue-anchored ISO date only (a bare date elsewhere in the
// card — "shipped 2026-06-30" — is NOT a deadline), so a false overdue flag can't
// fire. Deadline = end of the named UTC day. Used to badge overdue opens in both
// brief tiers (the "flag it in the next session's brief" acceptance criterion).
const DEADLINE_RE = /\b(?:before|by|due(?:\s+(?:date|by|on))?|deadline|until|no\s+later\s+than|not\s+later\s+than|eod|end\s+of(?:\s+day)?)\b[^\n.]{0,32}?~?\s*(\d{4}-\d{2}-\d{2})\b/i;

// ── One honest open count (1.85.0) ───────────────────────────────────────────
// Every number a human sees about open work — the status digest header, the
// per-item ⏳/⏰ flags, the brief and ultra-brief headers, the insights status
// view, the SessionStart self-heal line, the Codex lane — comes from THIS one
// pure function. Before it, the header said "Open (67)", the SessionStart heal
// line said "34 look already done", the digest flagged 7 bullets and the brief
// listed 5 hints: four surfaces, four detectors, four numbers for one brain.
//
//   open        = live ∧ !archived ∧ isUnresolvedOpenCard (✅/↩/⤵ never count)
//   likelyDone  = (persisted 'likely closed by' edges ∪ findStaleOpenCards gaps)
//                 ∩ openIds — the intersection is MANDATORY: findStaleOpenCards
//                 filters ↩|✅ only, so without it a ⤵-deferred card could make
//                 the header count exceed the flagged bullets.
//   overdue     = findOverdueOpenCards ∩ openIds
//   untouched   = open ∧ age(createdAt) > untouchedDays ∧ !likelyDone ∧ !overdue
//                 Struct cards carry createdAt only, so the wording is
//                 "created >45 d ago" — never "untouched" in prose.
//
// Pure, no model load, no I/O. Maps serialize to arrays for the disk cache
// (serialize/deserialize below) because the hook is a fresh process per prompt
// and findStaleOpenCards is the expensive half (~0.5 s on the real brain).
export const STATUS_UNTOUCHED_DAYS = 45;

// ── Release-cut reconcile (1.85.0) ───────────────────────────────────────────
// Conventional-commit subjects worth carding. The hook's commitToCard has used
// this exact shape since 1.15; it lives HERE now so the release advisory below
// and the capture path can never drift apart. (The hook mirrors the literal
// rather than importing it — it loads this module lazily, only when a brain
// exists, and a static import would pay the whole engine on every prompt.
// test/release-reconcile.mjs asserts the two sources are identical.)
export const CC_RE = /^(feat|fix|perf)(?:\(([^)]+)\))?!?:\s*(.+)$/i;

// Which OPEN cards look fulfilled by the commits a release ref is about to
// carry? Pure — the caller supplies the commits and the containment oracle.
//
// Three sources of evidence, strongest first:
//   commit-tag / commit-evidence  the card itself names a sha (#commit-1a2b3c4
//                                 or evidence [{kind:'commit'}]) that IS in the
//                                 ref. The card's own receipt; always confirmable.
//   edge                          a 'likely closed by' hint or a current
//                                 findStaleOpenCards gap whose MILESTONE card
//                                 carries a contained #commit- tag.
//   coverage / anchor             the shared claim extractor run against the
//                                 commits themselves as pseudo-milestones.
//
// `confirmable` is the honesty flag, and it is deliberately conservative: with
// `ref` defaulting to the branch being cut, "contained" is TRUE BY CONSTRUCTION
// for every commit in the range, so containment alone proves nothing about a
// coverage match. A coverage candidate earns confirmable only at cov ≥ 0.6 from
// a commit with a real body (≥12 chars — the same bar commitToCard uses);
// anchor-grade pairs never do. Measured expectation: the commits that never
// became cards are the body-less ones, and a 5–8-token subject rarely covers a
// card clause, so recall on that class is LOW. This advisory names what it can
// prove and says nothing about the rest.
export const RELEASE_RECONCILE_MAX = 40;
const COMMIT_TAG_RE = /#commit-([0-9a-f]{7,40})\b/gi;
// The confirm call the advisory hands back — PLACEHOLDERS, never the candidate
// ids. Prefilling them turns "paste this" into a one-keystroke mass close of
// text-matched cards with nothing read; an agent has to name each pair it
// actually verified. Lives here (not inline in the worker) so the placeholder
// contract is test-locked rather than a convention.
export const releaseReconcileConfirmTemplate = (ref) => ({
    tool: 'brain_reconcile',
    args: { mode: 'release', ref: String(ref || ''), confirm: [{ id: '<openId>', sha: '<sha>' }] },
});

// ── Deliberate note → capture input ──────────────────────────────────────────
// Turn ONE structured note into captureIntoBrain's input shape — the deliberate
// twin of the Stop hook's transcript marker parser. This is what lets an ON-DEMAND
// write (the brain_note MCP tool, the brain-note CLI — any agent, not just the
// Claude-Code hook) get IDENTICAL supersede / resolve / close / dedup semantics as
// a harvested 🧠 marker. marker ∈ '' (decision) | '?' (open question) | '!'
// (milestone) | '✓' (resolve+archive a match) | '~' (update a match in place) |
// '+' (skill — a REUSABLE how-to/gotcha/procedure, standing reference that always
// surfaces and never ages out, distinct from a point-in-time decision).
// ── Guard cards (2026-08-24, founder go after the 13-agent audit) ────────────
// A guard is a standing 🛠️ card that also declares WHEN it should interrupt a
// tool call: { when: {tool?, command?, paths?, multiWorktree?}, severity, message }.
// The card's prose is the human render; this structured field is the machine
// half. Everything here is PURE — validation, compilation from a parsed
// struct, and evaluation against one tool event — so the PreToolUse hook can
// stay a stat+sidecar+regex fast path (never parses the brain, never spawns
// git; measured brain parse is ~1s on the live brain, far over any hook budget).
//
// Trigger grammar is DELIBERATELY the honest expressible surface only
// (audit §5): tool/command regexes, path PREFIXES, and one cached repo
// predicate (multiWorktree). Staleness detection, response-shape checks and
// semantic intent are NOT expressible here and must not be pretended in.
//
// Severity contract: 'warn' injects context; 'block' denies the call with the
// card's message. Authoring 'block' is a deliberate human-directed act — an
// agent must never author severity 'block' without explicit user instruction
// (the deny names the card id, so a wrong block is corrected by ✓-resolving
// or ~-amending that card).
const GUARD_RE_MAX = 200;
const GUARD_MSG_MAX = 500;
const GUARD_PATHS_MAX = 20;
const compileGuardRegex = (source) => {
    const s = String(source || '').trim();
    if (!s || s.length > GUARD_RE_MAX) return null;
    try { return new RegExp(s, 'i'); } catch { return null; }
};

// The marker written AFTER the colon — "🧠 BRAIN [Drive]: ! Drive storage …",
// or brain_note text "! …" with no marker — was stored as a plain decision
// carrying a literal "! " (166 such cards on the KLYPIX brain by 2026-10-12, so
// milestones read as decisions and questions never counted as open). A bare
// marker glyph followed by a space at the very start of the text IS the
// marker; an explicit marker always wins.
const LEADING_MARKER_RE = /^([?!✓~+])\s+(?=\S)/u;

// Cards captured that way BEFORE the fix read "Area: ! text". Restore the glyph
// the capture meant for the kinds whose intent is unambiguous on the card
// itself — ! → 🏁, + → 🛠️, ? → ❓. A ✓ or ~ asked for an action on ANOTHER card
// at the time; replaying a months-old resolve or amend is guesswork, so those
// stay as written. tidyBrain runs this on every capture, so a brain heals on
// its next write. The card is stored hard-wrapped and the glyph is longer than
// the marker, so the first paragraph is rejoined (wrapText's own soft-break
// rule, as in parseVerifySuffix) and wrapped again rather than left with a
// one-word orphan line. Returns the text unchanged when there is nothing to do.
const RAW_MARKER_CARD_RE = /^([^:\n]{1,30}):\s+([!+?])\s+(?=\S)/u;
const RAW_MARKER_GLYPH = { '!': '🏁 ', '+': '🛠️ ', '?': '❓ ' };

// ── Brain Lens data (the machine-readable twin of the app's Brain Lenses) ────
// One source of truth for every product surface (desktop lenses, web viewer,
// iOS, agents): freshness buckets, provenance channels, 7-day activity,
// birth-order timeline, orrery (focus+context neighborhood), and the open-❓
// triage. Pure over a parsed struct — read-only by construction.

const LENS_DAY = 86_400_000;
const lensIsArchived = (c) => /^archive$/i.test(String(c.area || '').trim());
const lensTitle = (c) => String(c.title || c.text || c.id).split('\n').map(s => s.trim()).find(Boolean)?.slice(0, 80) || c.id;
const LENS_VIA = [
    [/claude/i, 'claude'], [/cursor/i, 'cursor'], [/cline|windsurf|copilot/i, 'other-agent'],
    [/git|commit/i, 'git'], [/gardener/i, 'gardener'], [/ship|release/i, 'ship-event'],
    [/mcp|hook|agent/i, 'agent'],
];
const lensChannel = (c) => {
    const via = String(c.createdVia || '');
    if (via) { for (const [re, k] of LENS_VIA) if (re.test(via)) return k; return via.slice(0, 16).toLowerCase(); }
    if (c.createdBy === 'user') return 'you';
    if (c.createdBy === 'agent') return 'agent';
    return 'unknown';
};

// What read_card_contents hands an MCP caller for a card that carries a file
// (src/card-files.mjs), in a few words — so a reader of read_canvas never
// concludes the contents of photos, PDFs, documents or folders are out of reach.
// Self-contained on purpose: this module is bundled alone into the app.
const TEXT_FILE_EXT_RE = /^(txt|text|md|markdown|csv|tsv|json|jsonl|xml|html?|ya?ml|toml|ini|cfg|conf|log|srt|vtt|sql|sh|bash|ps1|bat|cmd|py|js|mjs|cjs|jsx|ts|tsx|java|kt|go|rs|rb|php|c|h|cc|cpp|hpp|cs|swift|css|scss|less|vue|svelte|tex|rtf)$/i;
const OFFICE_FILE_EXT_RE = /^(docx?|dotx|xlsx?|xlsm|pptx?|odt|ods|odp|pages|numbers|key)$/i;
const IMAGE_FILE_EXT_RE = /^(png|jpe?g|gif|webp|bmp|heic|heif|tiff?|avif)$/i;
export { ADVICE_OPENER_RE, AGCONF_TWIN_RE, ALL_ALIASES, ANCHOR_COV_FLOOR, AREA_PREFIX_RE, ARRANGE_DELETION, AR_CLITICS, AWAIT_CUE, BRAIN_GEOM, CANVAS_RESTORE_POINT_MAX_BYTES, CAPTURED_BY_KEYS, CHALLENGE_AUTOMATION_VIA, CLAIM_CUE_RE, CLAIM_CUE_WORDS, COMMIT_TAG_RE, CONFIRM_CUE_RE, CONFIRM_DISQUALIFIER_RE, CORRECTION_META, CORRECTION_PHRASE_RE, CUE_LINE_RE, CUE_RELAXED_COEF, CUE_STRONG_SHARED, DEADLINE_RE, DECAY_EVRUN_RE, DECAY_NOUN_RE, DECAY_PENDING_RE, DECAY_VERB_RE, DECLARED_GLYPH_RE, DELETION_CONFIDENCE, DELETION_INITIATORS, DERIVED_KIND_LABEL, ENTRY_RANK, FAMILY_ALIAS_SETS, FILE_SLUG_TAG_RE, FOLDER_PATH_CAP, FOLDER_TEXT_CAP, GARDEN_AUTO_MIN_AGE_DAYS, GARDEN_KEEP_NEWEST, GARDEN_MAX_DEGREE, GARDEN_MIN_AGE_DAYS, GARDEN_MIN_CANDIDATES, GARDEN_PROTECTED, GIST_HOSTS, GIST_SHORTLINK_HOSTS, GUARD_MSG_MAX, GUARD_PATHS_MAX, GUARD_RE_MAX, HANDOFF_SECTION_LINE_RE, HOOK_WORDS_B, HOOK_WORDS_K1, HOOK_WORDS_SPECIFICITY, HOOK_WORDS_TITLE_BOOST, HOOK_WORD_RE, IMAGE_FILE_EXT_RE, IMPERATIVE_ASK_RE, INSTRUCTION_LINE, LEADING_MARKER_RE, LENS_DAY, LENS_VIA, LESSON_FILE_EXT, LESSON_GENERIC_DIRS, LESSON_SHAPED_RE, LESSON_STOCK_NAMES, LESSON_TIERS, LIFECYCLE_GLYPH_RE, LIMITATION_CUE_RE, LOOSE_FAMILIES, MARKER_SUFFIX_BARE_FILES, MARKER_SUFFIX_BOUNDARY, MARKER_SUFFIX_CLI, MARKER_SUFFIX_DIRECTION, MARKER_SUFFIX_INVISIBLE, MARKER_SUFFIX_KEYS, MARKER_SUFFIX_KEY_RE, MARKER_SUFFIX_OPEN_WORDS, MARKER_SUFFIX_PROSE, MARKER_SUFFIX_QUESTION_LEAD, MARKER_SUFFIX_RULE, MARKER_SUFFIX_SOFT_WORDS, MARKER_SUFFIX_WIKILINK, MIG_STOP, MILE_GLYPH, MIN_SYNTHESIS_CHARS, NEGATED_READOPT_CUE_RE, NEXT_CUE_WORDS, OFFICE_FILE_EXT_RE, OPEN_GLYPH, OPPOSITION_RE, PARTIAL_NOTE_TAIL, PARTIAL_RUN_END_RE, PLAN_CUE_RE, PLAN_DEAD_RE, PLAN_NOUN_GUARD, PLAN_SHIP_PIN_RE, POLARITY_PAIRS, POLARITY_RES, PR_MERGED_RE, PR_REFS_RE, RAW_MARKER_CARD_RE, RAW_MARKER_GLYPH, READOPT_ACTION, READOPT_CUE_RE, READOPT_META, READOPT_NEGATION_FILLER, REL, RENAME_BACKOFF_MS, RENAME_RETRYABLE_CODES, REPEAT_VERB_STOP, RESOLUTION_GENERIC, RESOLVED_GLYPH, RETIRE_PREFIX_RE, RETIRE_SUFFIX_RE, REVIVED_ID_RE, REVIVED_TAIL_RE, SAFE_TAG_RE, SAY_WORD_CHAR, SECRET_FILE_EXTENSIONS, SERVE_COV_BAR, SERVE_MIN_STEMS, SKILL_EVENT_PINS, SKILL_GLYPH, STATE_GLYPH, STATUS_QUERY_RE, STOPWORDS, STRICT_FAMILIES, STRONG_SKILL_CUES, TEXT_FILE_EXT_RE, TITLE_MIN_HITS, TITLE_OVERLAP_AT, TITLE_STOP, TRAP_CONTRAST, TRAP_FAILURE, UNWRAP_BLOCK_START, YOUTUBE_RE, _historyLib, agconfRootOf, anchorDfMax, anchorTitleTok, anchorsSufficient, arRe, authorField, blankMatches, boundedToken, cachedAuthor, capturedByField, claimTokens, cmpSemver3, codePointAt, codePointBefore, compactText, compileGuardRegex, connDupKey, coverageOf, cueMatch, entryKey, errText, figuresIn, fileSize, findReadoptedAncestor, foldAll, hasResolutionIdentity, hasRetirementStamp, hookFusedIndexCache, hookTagSlug, hookTermsOf, hookWordsIndexCache, isAliasToken, isEntityToken, isPlainObject, isStatusVocab, isTerseConfirmUpdate, isValidZKey, itemTagsLower, lensChannel, lensIsArchived, lensTitle, lessonRoot, lessonSlug, lifecycleEligible, lifecycleScope, loadHistoryLib, looksLikeBrain, matchedTokenCount, migWords, normTextKey, normTitleKey, overlapScore, parenBalance, planHeadline, rawMatch, reAdoptionReceipt, readingFieldsIn, readingRank, readoptTokens, retiredTextKey, safelyMatches, setSimilarity, sha256Hex, shipPaths, stableJson, stampBrainKind, stripCueMeta, stripRetirement, structuralStems, tokenSet, updateTargetTokens, wordsOf, ymd };
