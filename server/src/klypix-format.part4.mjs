// Part 4 of 4 of klypix-format.mjs, split only so each file stays under the
// plugin directory's 256 KiB per-file review limit. Code unchanged; klypix-format.mjs re-exports it.
import JSZip from 'jszip';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import zlib from 'zlib';
import { generateKeyBetween } from 'fractional-indexing';
import { ADVICE_OPENER_RE, ANCHOR_COV_FLOOR, BRAIN_GEOM, CC_RE, CLAIM_CUE_RE, COMMIT_TAG_RE, CORRECTION_SUPERSEDE_AT, CUE_LINE_RE, DEADLINE_RE, DISMISSAL_RELS, GARDEN_AUTO_MIN_AGE_DAYS, GARDEN_KEEP_NEWEST, GARDEN_MAX_DEGREE, GARDEN_MIN_AGE_DAYS, GARDEN_MIN_CANDIDATES, GARDEN_PROTECTED, GUARD_MSG_MAX, GUARD_PATHS_MAX, GUARD_RE_MAX, HANDOFF_RE, IMAGE_FILE_EXT_RE, IMPERATIVE_ASK_RE, LEADING_MARKER_RE, LENS_DAY, LIMITATION_CUE_RE, MILE_GLYPH, MIN_SYNTHESIS_CHARS, OFFICE_FILE_EXT_RE, OPEN_GLYPH, PLAN_PAIR_SIM_ANSWER, PLAN_PAIR_SIM_BRAIN, RAW_MARKER_CARD_RE, RAW_MARKER_GLYPH, REL, RELEASE_RECONCILE_MAX, SERVE_COV_BAR, SERVE_MIN_STEMS, STATUS_UNTOUCHED_DAYS, TEXT_FILE_EXT_RE, anchorDfMax, anchorsSufficient, authorField, capturedByField, claimTokens, closeTargetKey, compileGuardRegex, coverageOf, cueMatch, errText, figuresIn, findReadoptedAncestor, hasCorrectionCue, hasResolutionIdentity, hasRetirementStamp, isAgconfTwinId, isMilestoneCard, isOpenCard, isPlanCard, isSkillCard, isTerseConfirmUpdate, isThinUpdate, isUnresolvedOpenCard, isValidZKey, lensChannel, lensIsArchived, lensTitle, normTitleKey, overlapScore, rawMatch, reAdoptionReceipt, sameAreaKey, scopeLockLine, serveTimeAccepts, shard, stampBrainKind, stemIndex, stemSet, stripCueMeta, structuralStems, tokenSet, updateTargetTokens, ymd } from './klypix-format.part1.mjs';
import { appendIntoContainers, appendToKlypix, brainCPL, capturedByValue, declaredLifecycleGlyph, derivedReading, escapeInstructionLines, fenceContent, finalizeBrainZip, frozenDrawingCount, makeZKeyGen, measureCardH, nextContainerX, notReadStep, parseKlypix, recordedAuthor, reflowBrainGeometry, resolveAreaScope, savedDocumentText, savedReadingIndex, wrapText } from './klypix-format.part2.mjs';
import { cardAlreadySays, correctionOverlaysFor, describeFailed, hasPartialNote, normalizeWrappedProse, proposeOrphanAnchorLinks, proposeStructuralConnections, rankForQuestion, settleHintEdges, supersededByNote } from './klypix-format.part3.mjs';


export async function captureIntoBrain(buffer, { cards = [], resolutions = [], updates = [] } = {}) {
    const SUPERSEDE_AT = 0.6, RESOLVE_AT = 0.3, UPDATE_AT = 0.45, CLOSE_COVER_AT = 0.6, QUESTION_MERGE_AT = 0.6;
    let work = buffer;
    // corrections[] lists cross-area/low-bar supersedes driven by a correction
    // cue, so the surface (brain_note result / capture stderr) can say WHAT was
    // archived and how to undo — the confirmation channel for the widened match.
    const stats = { added: 0, superseded: 0, reAdopted: 0, resolved: 0, linked: 0, updated: 0, closed: 0, merged: 0, corrections: [], fulfillCandidates: [], skillStale: [] };

    // Pass 1 — resolutions + supersede marking operate on EXISTING cards.
    if (resolutions.length || cards.length || updates.length) {
        const { zip, canvas, manifest, isV4, struct } = await parseKlypix(work);
        if (!isV4 || !canvas.positions) {
            // Legacy file — no surgery possible; degrade to plain append.
            return { buffer: await appendToKlypix(work, { cards }), stats };
        }
        const now = Date.now();
        const today = new Date(now).toISOString().slice(0, 10);
        const rand = () => Math.random().toString(36).slice(2, 10);
        const top = Object.values(canvas.positions).map(p => p && p.zKey).filter(k => k && isValidZKey(k)).sort().pop() || null;
        const nextZKey = makeZKeyGen(top);
        const byTitle = new Map();
        for (const c of struct.cards) if (c.type === 'container') { const t = (c.title || '').trim().toLowerCase(); if (t && !byTitle.has(t)) byTitle.set(t, c.id); }
        const ensureArchive = () => {
            let id = byTitle.get('archive');
            if (id) return id;
            id = `ctn_${rand()}`;
            const G = BRAIN_GEOM;
            zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify({ type: 'container', locked: false, createdAt: now, createdBy: 'agent', title: 'Archive', collapsed: false, scopeLocked: false, borderColor: 'rgba(120,120,135,0.6)' }));
            canvas.positions[id] = { x: nextContainerX(canvas), y: G.START, w: G.AREA_W, h: G.TITLE_BAR + G.PAD * 2, zKey: nextZKey(), zIndex: canvas.order.length, parentId: null };
            canvas.order.push(id);
            byTitle.set('archive', id);
            return id;
        };
        const liveTextCards = () => struct.cards.filter(c =>
            c.type !== 'container' && (c.text || '').trim()
            && !/^archive$/i.test(c.area || '')
            && !/↩|✅/.test(c.text));
        // Every area name this brain actually uses, normalized once. Used by the
        // CLOSE-LINK pass to tell an `Area:` prefix from an ordinary prose colon.
        let _areaKeys = null;
        const knownAreaKeys = () => (_areaKeys ||= new Set(
            struct.cards.map(c => normTitleKey(c.type === 'container' ? (c.title || c.text || '') : (c.area || ''))).filter(Boolean)));
        const rewriteCard = async (id, mutate) => {
            const ip = `items/${shard(id)}/${id}.json`;
            const f = zip.file(ip); if (!f) return false;
            const j = JSON.parse(await f.async('string'));
            mutate(j);
            j.content = wrapText(String(j.content || ''));
            zip.file(ip, JSON.stringify(j));
            const pos = canvas.positions[id];
            if (pos) canvas.positions[id] = { ...pos, h: measureCardH(j.content) };
            return true;
        };
        const archiveCard = async (id) => {
            const arc = ensureArchive();
            // The Archive is readable STORAGE, not a vector-scaled layout: un-bake
            // any group-shrink (font/width baked tiny) by restoring the frozen
            // authored baseline and dropping it, so the card sits in the Archive
            // at full readable size and re-seeds cleanly if the Archive is resized.
            let authoredW = null;
            const ip = `items/${shard(id)}/${id}.json`;
            const f = zip.file(ip);
            if (f) {
                const j = JSON.parse(await f.async('string'));
                const a = j.authoredInParent;
                if (a) {
                    if (j.type === 'text' && a.fontSize) j.fontSize = a.fontSize;
                    if (a.authoredWidth != null) j.authoredWidth = a.authoredWidth;
                    authoredW = a.w || null;
                    delete j.authoredInParent;
                    zip.file(ip, JSON.stringify(j));
                }
            }
            const pos = canvas.positions[id];
            if (pos) canvas.positions[id] = { ...pos, parentId: arc, ...(authoredW ? { w: authoredW } : {}) };
        };
        canvas.connections = Array.isArray(canvas.connections) ? canvas.connections : [];

        // Fallback-add near-dup guard (live incident 2026-07-23): ✓/~ markers
        // BYPASS the hook's seen-dedup by design (self-heal re-stamps a drifted
        // fact), so a marker that stops matching — e.g. a ✓ whose target was
        // archived by its own FIRST run — re-fires on every Stop while it sits
        // in the transcript tail. Its no-match FALLBACK path must therefore
        // never re-add: 4 duplicate 🏁 fallback cards landed from one ✓ before
        // this guard. Checks live cards AND this batch's queued adds.
        const nearDupExists = (text) => {
            const t = tokenSet(text);
            if (t.size < 3) return false;
            for (const c of liveTextCards()) if (overlapScore(t, tokenSet(c.text)) >= 0.9) return true;
            for (const c of cards) if (c && c.text && overlapScore(t, tokenSet(c.text)) >= 0.9) return true;
            return false;
        };
        // Engine-authored text inserted into LIVE cards (fallback 🏁 cards, ✔
        // partial stamps) must never carry lifecycle glyphs from the marker's
        // prose — a ✓ whose text MENTIONED "❓/🎯" made its fallback card
        // classify as an open question in every brief (glyph-in-prose trap).
        const stripLifecycleGlyphs = (s) => String(s || '').replace(/[❓🎯🏁🛠✅✔↩⤵️]/gu, '').replace(/\s+/g, ' ').trim();

        // RESOLVE (✓ markers) — best live match in the area, PLUS its near-tie
        // twins: a rephrased duplicate ❓ scores within a hair of its sibling, and
        // resolving only the first left the twin open forever (it kept surfacing
        // in every brief as still-to-do). Precision-kept: the set is the best
        // match ± 0.1, never everything above the loose 0.3 floor. ❓ preferred
        // for RANKING only — its bonus must never admit a lexically ineligible
        // card (the 2026-08-11 false-close incident was 0.174 + 0.15 = 0.324).
        const milestonesFallback = [];
        // Cards the ID-ADDRESSED branch archived, reported in stats so a caller
        // that wants to mint ONE closing milestone for them (brain_reconcile
        // mode:'release') can pass those ids back as a card's `__closesIds` on a
        // second capture — the same field pass 2 uses for `closes:` targets, so
        // the arrows are identical whichever path drew them.
        const idArchived = [];
        // Per-resolution outcome, indexed by the caller's own array position, so
        // a host that kept a ledger entry per marker can say what ACTUALLY
        // happened to each one instead of implying a fresh stamp (the hook's
        // `resolve-partial-skipped` action).
        let rIdx = -1;
        const outcomeOf = (outcome, extra = {}) => { (stats.resolutionOutcomes ||= []).push({ i: rIdx, outcome, ...extra }); };
        for (const r of resolutions) {
            rIdx++;
            // ── ID-ADDRESSED RESOLVE (1.85.0) ───────────────────────────────
            // brain_reconcile confirm names the EXACT card, so there is nothing
            // to fuzzy-match and RESOLVE_AT is skipped. Everything else about a
            // ✓ is kept: the 🛠 / pure-🏁 / already-resolved refusals, and above
            // all the PARTIAL-CLAUSE rule. findStaleOpenCards is clause-keyed —
            // its best coverage may come from ONE item of a multi-item
            // "remaining: A + B + C" clause — so archiving the whole card on a
            // one-clause hit is precisely the false close this engine promises
            // never to do. `whole: true` is the explicit human override, and the
            // outcome (archived | partial) is reported per id.
            if (r && r.id) {
                const record = (outcome, extra = {}) => { (stats.idResolutions ||= []).push({ id: r.id, outcome, ...extra }); outcomeOf(extra.skipped ? 'partial-skipped' : outcome, { id: r.id }); };
                const target = struct.cards.find(c => c.id === r.id && c.type !== 'container' && (c.text || '').trim());
                if (!target) { record('refused', { reason: 'unknown-id' }); continue; }
                const guarded = /🛠/.test(target.text) || /^archive$/i.test(target.area || '') || !isUnresolvedOpenCard(target);
                if (guarded) { record('refused', { reason: 'not-open' }); continue; }
                const rTokId = tokenSet(r.text || '');
                const itemsId = extractOpenClauses(target.text).flatMap(cl => cl.items);
                const coveredId = itemsId.filter(it => coverageOf(it.tokens, rTokId) >= 0.8);
                const uncoveredId = itemsId.filter(it => coverageOf(it.tokens, rTokId) < 0.5);
                const partialId = r.whole !== true
                    && ((coveredId.length && uncoveredId.length) || (/🏁/.test(target.text) && itemsId.length > 0));
                if (partialId) {
                    const cleanR = stripLifecycleGlyphs(r.text);
                    // Already noted → say so and change nothing (see the
                    // PARTIAL_NOTE_PREFIX block above: a partial resolve is not
                    // idempotent on its own, and re-pushed markers stacked 85
                    // identical lines onto one live card).
                    if (hasPartialNote(target.text, cleanR.slice(0, 100))) {
                        stats.partialSkipped = (stats.partialSkipped || 0) + 1;
                        record('partial', { skipped: true });
                        continue;
                    }
                    const still = uncoveredId.length ? ` — still open: ${uncoveredId.map(x => x.text.slice(0, 50)).join(' + ').slice(0, 160)}` : '';
                    await rewriteCard(target.id, j => {
                        j.content = `${j.content}\n✔ partial ${today}: ${cleanR.slice(0, 100)}${still}`;
                        j.borderColor = 'rgba(16,185,129,0.45)';
                    });
                    // The in-memory mirror is the string that reached DISK, not
                    // the untruncated body: a second copy of the same marker in
                    // the same batch then matches by exact key instead of
                    // leaning on the prefix tolerance in hasPartialNote.
                    target.text += `\n✔ partial ${today}: ${cleanR.slice(0, 100)}${still}`;
                    stats.partialResolved = (stats.partialResolved || 0) + 1;
                    record('partial', { uncovered: uncoveredId.map(x => x.text.slice(0, 60)) });
                    continue;
                }
                await rewriteCard(target.id, j => {
                    j.content = `${j.content}\n✅ ${today}: ${r.text || 'confirmed done'}`;
                    j.borderColor = 'rgba(16,185,129,0.35)';
                });
                await archiveCard(target.id);
                target.text += ` ✅ ${r.text || ''}`;
                stats.resolved++;
                idArchived.push(target.id);
                stats.idArchived = idArchived;
                record('archived');
                // The evidence card becomes the CONFIRMED closer: an existing
                // dashed 'likely closed by' hint is relabeled in place (so
                // fulfillmentOverlaysFor stops rendering it as unconfirmed)
                // rather than left beside a second solid arrow. Without a
                // (valid) byId the settle still runs, in unambiguous-only mode
                // — see settleHintEdges above.
                const confirmedBy = (r.byId && struct.cards.some(c => c.id === r.byId)) ? r.byId : null;
                settleHintEdges(canvas, struct, target.id, confirmedBy, { rand, stats, resolveText: r.text || '', ri: rIdx });
                continue;
            }
            const rTok = tokenSet(r.text);
            const cands = [];
            for (const c of liveTextCards()) {
                if (r.area && !sameAreaKey(c.area, r.area)) continue;
                // Skills are standing reference — a ✓ must never archive one
                // (mirror the supersede guard). EXCEPTION (2026-08-24): a card
                // carrying a machine guard documents "✓-resolve retires the
                // guard" as its lifecycle contract, and the deny message sends
                // agents here — without this carve-out the advertised remedy
                // was impossible and the unmatched ✓ minted a junk 🏁 fallback.
                if (/🛠/.test(c.text) && !c.guard) continue;
                // An objection is closed by evidence or a decision that LINKS it
                // (closes:), never by a fuzzy ✓ that merely shares its words.
                if (/⚖️?\s*OBJECTION/u.test(c.text)) continue;
                // A ✓ closes opens/claims, never a pure milestone — without this
                // a ✓ for a fulfilled claim could near-tie the very 🏁 that
                // fulfilled it (item text ⊆ milestone) and archive the milestone
                // too (review-traced). 🏁 cards that CARRY an open clause stay
                // eligible — they resolve via the partial path below.
                // DECLARED, not quoted (2026-09-15): the old `/🏁/.test(text)`
                // also skipped a decision card that merely MENTIONS the glyph —
                // "Brain: The 🏁-doesn't-close-❓ gap" was unresolvable by any ✓
                // and the marker minted a junk fallback milestone instead.
                if (declaredLifecycleGlyph(c) === '🏁' && !extractOpenClauses(c.text).length) continue;
                const cardTokens = tokenSet(c.text);
                const lexical = overlapScore(rTok, cardTokens);
                if (lexical < RESOLVE_AT) continue;
                if (!hasResolutionIdentity(rTok, cardTokens)) continue;
                const s = lexical + (/❓|🎯/.test(c.text) ? 0.15 : 0);
                cands.push({ c, s });
            }
            cands.sort((a, b) => b.s - a.s);
            const bestScore = cands.length ? cands[0].s : 0;
            const set = bestScore >= RESOLVE_AT
                ? cands.filter(x => x.s >= Math.max(RESOLVE_AT, bestScore - 0.1)).slice(0, 3)
                : [];
            if (set.length) {
                for (const { c: best } of set) {
                    // PARTIAL-RESOLVE GUARD (critical, 2026-07-23): "close ONLY
                    // the covered part" is now mechanical, not a promise. When
                    // the ✓ text covers a strict subset of a multi-item clause,
                    // or the card is itself a 🏁 fact card with a clause tail,
                    // the card is NOT archived: a dated ✔ partial note lands and
                    // the remainder stays live. (✔ ≠ ✅ — the card remains
                    // visible to every live-lifecycle matcher.)
                    const items = extractOpenClauses(best.text).flatMap(cl => cl.items);
                    const coveredItems = items.filter(it => coverageOf(it.tokens, rTok) >= 0.8);
                    const uncoveredItems = items.filter(it => coverageOf(it.tokens, rTok) < 0.5);
                    const partial = (coveredItems.length && uncoveredItems.length) || (/🏁/.test(best.text) && items.length > 0);
                    if (partial) {
                        const cleanR = stripLifecycleGlyphs(r.text);
                        // IDEMPOTENCE, for real (2026-09-15 live incident): the
                        // hook re-pushes every ✓ marker in the transcript at
                        // every Stop because a resolve is documented as
                        // idempotent — true for a full resolve, which archives
                        // its card, and false for this branch, which leaves it
                        // live. 85 identical ✔ partial lines on one card before
                        // this guard. Skipping is the honest outcome, and it is
                        // COUNTED so the receipt can say what happened.
                        if (hasPartialNote(best.text, cleanR.slice(0, 100))) {
                            stats.partialSkipped = (stats.partialSkipped || 0) + 1;
                            outcomeOf('partial-skipped', { cardId: best.id });
                            continue;
                        }
                        const still = uncoveredItems.length ? ` — still open: ${uncoveredItems.map(x => x.text.slice(0, 50)).join(' + ').slice(0, 160)}` : '';
                        await rewriteCard(best.id, j => {
                            j.content = `${j.content}\n✔ partial ${today}: ${cleanR.slice(0, 100)}${still}`;
                            j.borderColor = 'rgba(16,185,129,0.45)';
                        });
                        // Mirror the DISK string (see the id path above).
                        best.text += `\n✔ partial ${today}: ${cleanR.slice(0, 100)}${still}`;
                        stats.partialResolved = (stats.partialResolved || 0) + 1;
                        outcomeOf('partial', { cardId: best.id });
                        continue;
                    }
                    await rewriteCard(best.id, j => {
                        j.content = `${j.content}\n✅ ${today}: ${r.text}`;
                        j.borderColor = 'rgba(16,185,129,0.35)';
                    });
                    await archiveCard(best.id);
                    best.text += ` ✅ ${r.text}`; // keep in-memory struct honest for later matching
                    stats.resolved++;
                    outcomeOf('archived', { cardId: best.id });
                    // A full text-✓ resolve settles its unambiguous hint too —
                    // the 56 dashed hints dangling from already-archived cards
                    // on the real brain are the residue of resolves that never
                    // did. Partial resolves `continue` above and never reach
                    // this (the card stays open, so its hints stay hedged).
                    settleHintEdges(canvas, struct, best.id, null, { rand, stats, resolveText: r.text || '', ri: rIdx });
                }
            } else {
                // __fromResolve: an unmatched-✓ fallback card must not seed the
                // fulfillment cross-check (it would cover its own source item at
                // cov 1.0 and self-feed a suggestion loop — review-traced).
                // Glyph-stripped + near-dup-guarded (see helpers above).
                const cleanR = stripLifecycleGlyphs(r.text);
                if (cleanR && !nearDupExists(cleanR)) {
                    milestonesFallback.push({ text: (r.area ? `${r.area}: ` : '') + `🏁 ${cleanR}`, area: r.area, borderColor: 'rgba(59,130,246,0.8)', __fromResolve: true });
                    outcomeOf('fallback-milestone');
                } else {
                    outcomeOf('no-match');
                }
            }
        }

        // UPDATE (~ markers) — rewrite a matching card IN PLACE: for small
        // corrections that don't deserve supersession history. Content is
        // replaced (area prefix + tag preserved), createdAt bumped so the
        // brief treats it as fresh. No match → falls through as a new card.
        // Too thin to stand in for the card it matched (UPDATE FLOOR below) →
        // the card is kept whole and the text is appended to it as a dated
        // `(~ amended …)` line; nothing separate is ever minted for it.
        // Each update is CONTAINED (review 2026-09-18, third round): one that
        // throws is reported in stats.captureErrors and the rest of the batch
        // still lands — a single bad marker used to throw captureIntoBrain,
        // lose every other card of its Stop and, once queued, wedge the queue.
        for (const [uIndex, u] of updates.entries()) try {
            const uTok = tokenSet(u.text);
            let best = null, bestScore = 0;
            for (const c of liveTextCards()) {
                if (u.area && !sameAreaKey(c.area, u.area)) continue;   // glyph-tolerant: the area "Canvas UX ✅" is the area "Canvas UX"
                const s = overlapScore(uTok, tokenSet(c.text));
                if (s > bestScore) { bestScore = s; best = c; }
            }
            const matched = best && bestScore >= UPDATE_AT;
            const isTerseConfirm = matched && isTerseConfirmUpdate(u.text, String(best.text || '').length);
            // UPDATE FLOOR (1.86.1): the replace is wholesale and leaves no ↩
            // trace and no Archive copy, so a handful of words must never stand
            // in for a richer card. The field case: 1.86.0 cut the marker
            // "~: Pricing page layout switches to Q: and A: FAQ blocks …" at
            // "Q:", and the four-word stub (overlap 0.75) replaced a
            // thirteen-word card. A terse confirmation appends, never replaces,
            // so it is exempt; so is a guard amendment — structured intent,
            // where a refused disarm would leave a live guard firing.
            //
            // A thin ~ is APPENDED to its card as a dated amendment line — the
            // correction lands where it belongs and nothing is destroyed. It
            // is a no-op when the card already says it word for word: that is
            // the same marker re-harvested at the next Stop (a ~ bypasses the
            // hook's dedup), or a stub whose full correction already replaced
            // the card — neither is news, and re-reporting it every Stop was
            // noise. Never a separate card: one would attract the next ~ that
            // tried to correct the original (review-traced), or be dropped as
            // a near-duplicate of the stale card it contradicts.
            if (matched && !isTerseConfirm && !(u.guard && typeof u.guard === 'object')) {
                const targetWords = updateTargetTokens(best.text).size;
                if (isThinUpdate(uTok.size, targetWords)) {
                    const body = stripLifecycleGlyphs(u.text);
                    const report = {
                        i: uIndex, id: best.id, area: best.area || null,
                        target: String(best.text || '').replace(/\s+/g, ' ').trim().slice(0, 90),
                        text: body.slice(0, 100), words: uTok.size, targetWords,
                    };
                    if (!body || cardAlreadySays(best.text, body)) {
                        // Nothing new to say — but an explicit clear (brain_note
                        // `verify: ""` / `evidence: []`) is still a deliberate act
                        // on the card's metadata, and is honoured.
                        const clearVerify = typeof u.verify === 'string' && !u.verify.trim();
                        const clearEvidence = Array.isArray(u.evidence) && !u.evidence.length;
                        if (clearVerify || clearEvidence) await rewriteCard(best.id, j => { if (clearVerify) j.verify = ''; if (clearEvidence) delete j.evidence; });
                        (stats.updateUnchanged ||= []).push({ ...report, reason: 'already-says' });
                        continue;
                    }
                    const line = `(~ amended ${today}: ${body})`;
                    await rewriteCard(best.id, j => {
                        j.content = `${j.content}\n${line}`;
                        // An amendment ADDS a line under a claim it does not
                        // replace, so everything that describes THAT claim stays
                        // as it was (review 2026-09-18): createdAt (re-dating it
                        // made the stale head claim read as fresh — the amendment
                        // line carries its own date), the border colour (a ❓ or
                        // 🏁 card is not turned into a decision), createdVia,
                        // and the card's own verify probe — only a card with no
                        // probe takes the amendment's. An explicit empty verify
                        // is a deliberate clear and is persisted as one.
                        if (typeof u.verify === 'string') {
                            if (!u.verify.trim()) j.verify = '';
                            else if (!(typeof j.verify === 'string' && j.verify.trim())) j.verify = u.verify.trim();
                        }
                        // Its evidence joins the card's, the amendment's refs FIRST
                        // (a fresher stamp wins on the same ref) so the 16-ref cap
                        // never drops the very refs the amendment brought; what the
                        // cap does drop is reported. An explicit empty list still
                        // clears, as on the replace path.
                        if (Array.isArray(u.evidence)) {
                            if (!u.evidence.length) delete j.evidence;
                            else {
                                const byRef = new Map();
                                for (const ev of u.evidence) byRef.set(ev && ev.ref, ev);
                                for (const ev of (Array.isArray(j.evidence) ? j.evidence : [])) if (!byRef.has(ev && ev.ref)) byRef.set(ev && ev.ref, ev);
                                const all = [...byRef.values()];
                                j.evidence = all.slice(0, 16);
                                if (all.length > 16) report.evidenceDropped = all.length - 16;
                            }
                        }
                    });
                    best.text = `${best.text}\n${line}`;
                    report.line = line;
                    stats.updated++;
                    (stats.updateAmended ||= []).push(report);
                    continue;
                }
            }
            if (matched) {
                const tag = u.area ? `\n#${u.area.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
                await rewriteCard(best.id, j => {
                    if (isTerseConfirm) j.content = `${j.content}\n(re-affirmed ${today}: ${u.text})`;
                    else j.content = (u.area ? `${u.area}: ` : '') + u.text + tag;
                    j.createdAt = now;
                    j.borderColor = 'rgba(16,185,129,0.6)';
                    if (u.createdVia) j.createdVia = String(u.createdVia);
                    if (capturedByValue(u.capturedBy)) j.capturedBy = capturedByValue(u.capturedBy);
                    // Omission preserves metadata; explicit empties clear stale anchors.
                    // A cleared verify is PERSISTED as '' (1.86.1): deleting the
                    // field let the reader derive a probe from the card's prose
                    // again, so an explicit clear could silently come back.
                    if (Array.isArray(u.evidence)) { if (u.evidence.length) j.evidence = u.evidence; else delete j.evidence; }
                    if (typeof u.verify === 'string') j.verify = u.verify.trim();
                    // guard: replace, DISARM ({remove:true} deletes the machine
                    // field — the only authorable off-switch), or preserve.
                    if (u.guard && typeof u.guard === 'object') {
                        if (u.guard.remove === true) delete j.guard; else j.guard = u.guard;
                    }
                    // A surviving/incoming guard must keep its 🛠 glyph — an
                    // amendment that dropped it demoted the card out of every
                    // skill-card lifecycle shield while it kept guarding
                    // (gardener consolidation would then kill it silently).
                    if (j.guard && !/🛠/.test(j.content)) j.content = `🛠️ ${j.content}`;
                });
                best.text = isTerseConfirm ? `${best.text}\n(re-affirmed ${today}: ${u.text})` : u.text;
                stats.updated++;
            } else if (!nearDupExists(u.text)) {
                // ~ fallback add is guarded like ✓'s: an unmatched ~ re-harvested
                // from the transcript tail must not stack a copy every turn.
                // A ~ fallback that carries a live guard mints a SKILL card —
                // the 🛠 glyph is what grants gardener/supersede immunity, and
                // a glyph-less guard card was silently consolidatable while
                // still enforcing (review 2026-08-24). remove-sentinels add no
                // glyph and no field: an unmatched disarm is inert by design.
                cards.push({ text: (u.area ? `${u.area}: ` : '') + (u.guard && u.guard.remove !== true && !/🛠/.test(u.text) ? '🛠️ ' : '') + u.text + (u.area ? `\n#${u.area.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''), area: u.area, createdVia: u.createdVia, ...capturedByField(u), ...(Array.isArray(u.evidence) && u.evidence.length ? { evidence: u.evidence } : {}), ...(typeof u.verify === 'string' && u.verify.trim() ? { verify: u.verify.trim() } : {}), ...(u.guard && typeof u.guard === 'object' && u.guard.remove !== true ? { guard: u.guard } : {}) });
            }
        } catch (error) {
            (stats.captureErrors ||= []).push({ kind: 'update', i: uIndex, ...describeFailed(u, 'text'), error: errText(error) });
        }
        // Report only amendments that are still ON their card after the whole
        // batch: a thin ~ appended and then replaced by a full ~ for the same
        // card in the same batch left no amendment behind, and the model was
        // told "appended, not replaced" about a line that no longer existed
        // (review 2026-09-18).
        if (stats.updateAmended) {
            const textById = new Map(struct.cards.map(c => [c.id, String(c.text || '')]));
            stats.updateAmended = stats.updateAmended.filter(f => (textById.get(f.id) || '').includes(f.line));
            if (!stats.updateAmended.length) delete stats.updateAmended;
        }

        // STUB REPAIR (1.86.1). 1.86.0 cut every marker at the first whitespace
        // + "closes:"/"ev:"/"verify:"/"q:" in any case (1.85 the same without
        // q:), so a session that ran 1.86.0 before the upgrade may already have
        // landed "Support page gets a" for "Support page gets a Q: and A: layout
        // …". The hook recognises that marker by the dedup key the old cut
        // wrote and hands the full card here with `repairStub` = the old cut
        // text. The stub is rewritten IN PLACE with the full text — never a
        // second card beside it (review 2026-09-18: 5 of 6 such markers were
        // re-captured as siblings). When no live card is exactly that stub any
        // more (archived, superseded, edited since), nothing lands: the marker
        // was captured once, and a re-add would undo whatever happened to it.
        // Glyphs, the `Area:` prefix, tag lines and wrapping are ignored in the
        // comparison (1.86.0 classified the cut, not the full text).
        const stubCore = (text, area) => {
            let t = String(text || '').split('\n').filter(l => !/^\s*(?:#[\p{L}\p{N}_-]+\s*)+$/u.test(l)).join(' ').replace(/\s+/g, ' ').trim();
            if (area && t.toLowerCase().startsWith(`${String(area).toLowerCase()}:`)) t = t.slice(String(area).length + 1);
            return stripLifecycleGlyphs(t).replace(/\s+/g, '').toLowerCase();
        };
        let repairing = null;
        for (let i = cards.length - 1; i >= 0; i--) try {
            const card = repairing = cards[i];
            if (!card || typeof card.repairStub !== 'string') continue;
            cards.splice(i, 1);
            const want = stubCore(card.repairStub, card.area);
            const stub = want && liveTextCards().find(c => (!card.area || sameAreaKey(c.area, card.area)) && stubCore(c.text, card.area) === want);
            if (!stub) { (stats.stubRepairMissing ||= []).push({ area: card.area || null, stub: String(card.repairStub).slice(0, 90) }); continue; }
            // 1.86.0 read an ev: / verify: out of the very prose it cut ("see
            // the ev: numbers in the report" → a junk ref), so a stub's value
            // that is part of THIS marker's text is dropped; the full parse is
            // the authority on what the marker's suffixes were. Anything else
            // on the card (a ref no part of this text names) is kept.
            const fullText = String(card.text).replace(/\s+/g, ' ').toLowerCase();
            const fromThisProse = (v) => { const t = String(v || '').replace(/\s+/g, ' ').trim().toLowerCase(); return Boolean(t) && fullText.includes(t); };
            // Only the TEXT is repaired. The stub's tag lines — a user's own
            // tags, the #file-/#dir- anchors it was captured with — are what
            // the match above ignored, so they are kept and merged with the
            // marker's tag line (review 2026-09-18, third round: a repair
            // rebuilt the tag line from the current transcript scan, which
            // after an upgrade is often empty, and dropped every one).
            const isTagLine = (l) => /^\s*(?:#[\p{L}\p{N}_-]+\s*)+$/u.test(l);
            const tagsOf = (t) => String(t || '').split('\n').filter(isTagLine).flatMap(l => l.trim().split(/\s+/));
            let repaired = String(card.text);
            await rewriteCard(stub.id, j => {
                const tags = new Map();
                for (const tag of [...tagsOf(j.content), ...tagsOf(card.text)]) if (!tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
                const prose = String(card.text).split('\n').filter(l => !isTagLine(l)).join('\n');
                repaired = tags.size ? `${prose}\n${[...tags.values()].join(' ')}` : prose;
                j.content = repaired;
                if (card.borderColor) j.borderColor = card.borderColor;
                const byRef = new Map();
                for (const ev of (Array.isArray(card.evidence) ? card.evidence : [])) byRef.set(ev && ev.ref, ev);
                for (const ev of (Array.isArray(j.evidence) ? j.evidence : [])) if (!fromThisProse(ev && ev.ref) && !byRef.has(ev && ev.ref)) byRef.set(ev && ev.ref, ev);
                if (byRef.size) j.evidence = [...byRef.values()].slice(0, 16); else delete j.evidence;
                if (typeof card.verify === 'string' && card.verify.trim()) j.verify = card.verify.trim();
                else if (typeof j.verify === 'string' && fromThisProse(j.verify)) delete j.verify;
            });
            (stats.stubRepairs ||= []).push({ id: stub.id, area: stub.area || null, from: String(card.repairStub).slice(0, 90), to: String(card.text).replace(/\s+/g, ' ').trim().slice(0, 120) });
            stub.text = repaired;
            stats.repaired = (stats.repaired || 0) + 1;
        } catch (error) {
            // The stub stays as it is; the marker was captured once already.
            (stats.captureErrors ||= []).push({ kind: 'repair', ...describeFailed(repairing, 'repairStub'), error: errText(error) });
        }

        // Which live cards a close-target names — shared by the unmatched-closes
        // pass below and the CLOSE-LINK pass, so both judge a target the same
        // way. Returns the tier the close would act on (> 4 = too generic).
        // strict (1.86.1): the target came from marker PROSE with nothing to
        // anchor it as a suffix (no clause boundary before `closes:`, not a
        // lone [[wikilink]], no well-formed ev:/verify:/q: BEFORE it), so it
        // may act only on a card it NAMES by title — "treats closes: as free
        // text, so …" once archived two unrelated milestones by loose token
        // coverage. Title-grade hits carry `title: true`.
        const closeTierFor = (target, { strict = false } = {}) => {
            // Both sides are normalized the SAME way (2026-09-15): strip the
            // [[wikilink]] brackets, the `Area:` prefix and any lifecycle glyph,
            // then collapse. Card titles are derived from prose, so an
            // unnormalized comparison was really comparing "canvas ux:" against
            // a full sentence.
            const wantTitle = closeTargetKey(target);
            const tTok = tokenSet(target);
            // …but naming the area must still DISAMBIGUATE (2026-09-16 review).
            // Stripping the prefix from BOTH sides meant `Collab: permanent
            // share-link` stopped being distinguishable from the same-titled
            // card in `canvas-share`: 10 stripped titles on the live brain are
            // shared across different areas, one across five, and at ≤4 matches
            // the close swept them all — over-matching, the loss direction. So
            // the target's own prefix is kept as a CONSTRAINT on the title-grade
            // paths, and ONLY when it names an area that actually exists, so an
            // ordinary prose colon ("fix: the thing") constrains nothing. A card
            // it excludes still reaches the token-coverage path below.
            const wantAreaRaw = (/^\s*(?:\[\[)?\s*([^:\n]{1,40}):\s*/.exec(target) || [])[1] || '';
            const wantArea = knownAreaKeys().has(normTitleKey(wantAreaRaw)) ? wantAreaRaw : '';
            // Collect EVERY live card the close-target covers — near-duplicate ❓
            // twins score together, and the old first-match-and-break resolved one
            // while its twin stayed "open" in every brief forever. Capped for
            // safety: a close-target is deliberate, so >4 matches means it was too
            // generic to trust at all.
            const matches = [];
            for (const c of liveTextCards()) {
                // The STRIPPED card title. The ≥10 floor on the prefix paths is
                // the fix for the worst close-link failure mode: many titles are
                // the bare area stub ("Canvas UX:"), which strips to a handful of
                // characters, and `wantTitle.startsWith(core)` then matched every
                // one of them. Simulated against the real brain, the target
                // "Brain: The 🏁-doesn't-close-❓ gap" produced 21 live matches.
                // Exact equality keeps the old ≥6 bar — naming a short title
                // exactly is a deliberate act, a shared prefix is not.
                const core = closeTargetKey(c.title);
                const longEnough = core.length >= 10;
                // A named area on the target constrains the TITLE-grade paths
                // only (see wantArea above); coverage is left alone.
                const areaOk = !wantArea || sameAreaKey(c.area, wantArea);
                // A 🛠️ retires ONLY by being NAMED: exact/prefix match of its
                // glyph-and-area-stripped title. Never the contains path (titles
                // are derived from prose, so a skill that merely MENTIONS the
                // target span mid-sentence would be swept — review-B's exact
                // trap), and never token coverage (2026-08-01: naming is a
                // deliberate human act; overlap is not).
                if (/🛠/.test(c.text)) {
                    if (areaOk && core && wantTitle.length >= 6 && core === wantTitle) matches.push({ c, cov: 1, overlap: core.length, title: true });
                    else if (areaOk && core && longEnough && wantTitle.length >= 6 && (core.startsWith(wantTitle) || wantTitle.startsWith(core))) {
                        matches.push({ c, cov: 1, overlap: Math.min(core.length, wantTitle.length), title: true });
                    }
                    continue;
                }
                // Title fast-path: exact (≥6 chars), prefix in either direction
                // (≥6 target AND ≥10 stripped card title), or the card title
                // CONTAINS the target — the contains variant needs a LONGER
                // target (≥10) because a short generic word ("sandbox") appears
                // in many unrelated titles.
                if (areaOk && core && wantTitle.length >= 6 && core === wantTitle) { matches.push({ c, cov: 1, overlap: core.length, title: true }); continue; }
                if (areaOk && core && longEnough && wantTitle.length >= 6 && (core.startsWith(wantTitle) || wantTitle.startsWith(core))) {
                    matches.push({ c, cov: 1, overlap: Math.min(core.length, wantTitle.length), title: true }); continue;
                }
                if (areaOk && core && longEnough && wantTitle.length >= 10 && core.includes(wantTitle)) { matches.push({ c, cov: 1, overlap: wantTitle.length, title: true }); continue; }
                // Else target-coverage (≥2 tokens, no floor): a short deliberate
                // close-target whose tokens are present in a card is a precise hit.
                if (tTok.size >= 2) {
                    const cov = coverageOf(tTok, tokenSet(c.text));
                    if (cov >= CLOSE_COVER_AT) matches.push({ c, cov, overlap: Math.round(cov * tTok.size) });
                }
            }
            // Ties break on the LONGER overlap and then on id — never on
            // iteration order, which is what made the old `matches[0]` fallback
            // archive an arbitrary card with cov 1.00 and no warning.
            matches.sort((a, b) => (b.cov - a.cov) || ((b.overlap || 0) - (a.overlap || 0)) || String(a.c.id).localeCompare(String(b.c.id)));
            // >4 matches means the target was too GENERIC to trust — and the old
            // fallback of archiving `matches[0]` was silent loss, the one thing
            // this engine may never do. REFUSE, keep the note as an ordinary
            // card, and hand back the top candidates so the author can name a
            // longer target or close by id.
            //
            // The cap applies to the TIER, not to the whole list (2026-09-16
            // review). A title-grade hit is an unambiguous naming; coverage hits
            // are a broad net around it, and counting them toward the cap made
            // an exact title match refuse because the target's words happened to
            // appear in five other cards. The documented example — `closes:
            // v1.2.0 staged as a github draft` — matches 18 live cards on
            // brain.klypix, exactly ONE of them title-grade (txt_kotyx0i2, rank
            // 1): the pre-1.85 code archived that right card, this branch
            // archived nothing. Simulated over all 1,890 live cards on
            // brain.klypix using each card's own headline as the close target
            // (tier cap only, no area constraint): refusals fall 45.2% → 13.2%
            // and the intended card is the one closed in 1,569 of 1,890. A
            // genuinely ambiguous target — review-G's 7-char 'sandbox', 6 hits,
            // none exact — is still refused, which is what the cap is for.
            // The tier is `cov === 1` — a title hit OR a card that carries every
            // token of the target — deliberately NOT "title-grade only". The
            // near-duplicate-twins guard depends on it: one ❓ twin usually
            // matches by title and its paraphrase only by full coverage, and
            // narrowing the tier to titles alone closed one twin and left the
            // other open in every brief forever (caught by brain-quality P4a).
            // A STRICT target acts only on the cards it NAMES by title — never
            // on one that merely carries every word of it (review 2026-09-18:
            // "The gardener pass closes: merge driver container dedup" named
            // one card and archived two more that only contained those words).
            // So the twin guard above is for an anchored close only: a prose
            // close that names one ❓ by title leaves a paraphrased twin open,
            // where it stays visible — under-closing, never the loss direction.
            if (strict) return matches.filter(m => m.title);
            // A target that names no LIVE card by title but does name a card
            // that is already closed (archived, or stamped ✅ / ↩) is a close
            // whose work is done — it must not fall through to word coverage
            // and archive whatever unrelated live card happens to carry its
            // words (review 2026-09-18, the corpus replay: "closes: PR #153
            // needs founder Merge click." archived "🏁 Overlap story CLOSED
            // 100%" because its named card was already in the Archive). The
            // empty tier carries which card it named, for the receipt.
            if (matches.length && !matches.some(m => m.title)) {
                for (const c of struct.cards) {
                    if (c.type === 'container' || !(c.text || '').trim()) continue;
                    if (!/^archive$/i.test(c.area || '') && !/↩|✅/.test(c.text)) continue;
                    const core = closeTargetKey(c.title);
                    if (!core || wantTitle.length < 6) continue;
                    const named = core === wantTitle
                        || (core.length >= 10 && (core.startsWith(wantTitle) || wantTitle.startsWith(core)))
                        || (core.length >= 10 && wantTitle.length >= 10 && core.includes(wantTitle));
                    if (named) {
                        const none = [];
                        none.alreadyClosed = { id: c.id, title: String(c.title || '').replace(/\s+/g, ' ').trim().slice(0, 90) };
                        return none;
                    }
                }
            }
            const exact = matches.filter(m => m.cov === 1);
            const tier = exact.length ? exact : matches;
            return tier;
        };
        // The receipt for a close that was too generic to trust (> 4 cards).
        const closeRefusal = (target, tier) => ({
            target: target.slice(0, 80),
            total: tier.length,
            candidates: tier.slice(0, 5).map(m => ({
                id: m.c.id, area: m.c.area || null, cov: Math.round(m.cov * 100) / 100,
                title: String(m.c.title || m.c.text || '').replace(/\s+/g, ' ').trim().slice(0, 90),
            })),
        });

        // UNMATCHED CLOSES (1.86.1) — `closes:` is the one marker suffix whose
        // value is free text, so no grammar can tell "shipped the uploader
        // closes: Upload question" from "The resolver treats closes: links as
        // exact title matches". The hook therefore hands over the card as
        // written WITH its closes segment (closesFallbackText); when the target
        // names no live card, that text is the card, so a prose "closes:" costs
        // nothing and a mistyped target stays visible instead of vanishing. It
        // runs before merge/supersede so the cut-down text never acts on
        // anything. A structured `closes` (brain_note) carries no fallback.
        //
        // The decision is made ONCE, here: a close that will act (1–4 cards)
        // keeps the cut text; anything else — nothing named, or too generic
        // to trust (> 4) — lands the sentence as written and drops the closes,
        // so CLOSE-LINK can never act on it later (supersede below may shrink
        // the tier) and the truncated text never lands. A grammar-derived
        // closes the grammar could not anchor is judged strictly (see
        // closeTierFor), and CLOSE-LINK repeats that strictness.
        for (const card of cards) {
            if (!card || typeof card.closesFallbackText !== 'string') continue;
            const fallback = card.closesFallbackText;
            const strict = card.closesAnchored !== true;
            delete card.closesFallbackText;
            delete card.closesAnchored;
            const target = (card.closes || '').toString().trim();
            if (!target || !fallback.trim()) continue;
            const tier = closeTierFor(target, { strict });
            if (tier.length >= 1 && tier.length <= 4) { if (strict) card.__closeStrict = true; continue; }
            card.text = fallback;
            delete card.closes;
            if (tier.length > 4) (stats.closeRefused ||= []).push(closeRefusal(target, tier));
            else (stats.closesKept ||= []).push({ target: target.slice(0, 80), area: card.area || null, strict, ...(tier.alreadyClosed ? { alreadyClosed: tier.alreadyClosed } : {}) });
        }

        // MERGE-ON-CAPTURE for duplicate open questions — a rephrased ❓ that
        // heavily overlaps an EXISTING live ❓ updates that card in place (fresh
        // wording + createdAt) instead of stacking a twin the close-pass would
        // later miss. (Supersede deliberately skips ? cards, so without this
        // twins could never merge at capture at all.)
        // A 🤝 HANDOFF card is one SESSION's record of its work in flight, never
        // a rephrasing of another's: two sessions handing off the same task are
        // two cards (`continues` links them). So a handoff neither merges into
        // an existing ❓ nor serves as the merge target of one — 1.103.0 field
        // case: the card KLYPIX drafted from a dead session's record (title =
        // its intent) swallowed the next session's deliberate handoff on the
        // same task, and that write came back without an id.
        let merging = null;
        for (let i = cards.length - 1; i >= 0; i--) try {
            const card = merging = cards[i];
            if (!/❓/.test(card.text) || /🏁|🛠/.test(card.text) || HANDOFF_RE.test(String(card.text).split('\n', 1)[0])) continue;
            const nTok = tokenSet(card.text);
            let best = null, bestScore = 0;
            for (const c of liveTextCards()) {
                if (!/❓/.test(c.text) || HANDOFF_RE.test(String(c.text).split('\n', 1)[0])) continue;
                const s = overlapScore(nTok, tokenSet(c.text));
                if (s > bestScore) { bestScore = s; best = c; }
            }
            if (best && bestScore >= QUESTION_MERGE_AT) {
                // The merge REWRITES the open question wholesale, so the ~
                // floor applies here too (1.86.1): a stub never replaces a
                // richer question. A thin one the card already says word for
                // word is a duplicate — counted as merged, the card untouched;
                // any other thin one lands as its own card.
                if (isThinUpdate(updateTargetTokens(card.text).size, updateTargetTokens(best.text).size)) {
                    let asked = String(card.text).split('\n')
                        .filter(line => !/^\s*(?:#[\p{L}\p{N}_-]+\s*)+$/u.test(line)).join(' ').trim();
                    if (card.area && asked.startsWith(`${card.area}:`)) asked = asked.slice(String(card.area).length + 1);
                    asked = stripLifecycleGlyphs(asked);
                    if (asked && cardAlreadySays(best.text, asked)) { cards.splice(i, 1); stats.merged++; }
                    continue;
                }
                await rewriteCard(best.id, j => {
                    j.content = String(card.text);
                    j.createdAt = now;
                    if (card.createdVia) j.createdVia = String(card.createdVia);
                    if (capturedByValue(card.capturedBy)) j.capturedBy = capturedByValue(card.capturedBy);
                    if (Array.isArray(card.evidence) && card.evidence.length) j.evidence = card.evidence;
                    if (typeof card.verify === 'string' && card.verify.trim()) j.verify = card.verify.trim();
                    if (card.guard && typeof card.guard === 'object') j.guard = card.guard;
                });
                best.text = String(card.text);
                cards.splice(i, 1);
                stats.merged++;
            }
        } catch (error) {
            // Contained like an update: the question stays in `cards` and
            // lands as its own card.
            (stats.captureErrors ||= []).push({ kind: 'question-merge', ...describeFailed(merging, 'text'), error: errText(error) });
        }

        // SUPERSEDE — pre-mark old cards that a NEW decision replaces. The arrow
        // to the new card is drawn in pass 2 (after the new ids exist), matched
        // back by remembering which old card each new card displaced.
        for (const card of cards) {
            // Objections and assessments (crowd safeguards) never supersede anything either.
            if (/❓|🎯|🏁|🛠|⚖️?\s*OBJECTION|🔎\s*ASSESSMENT/u.test(card.text)) continue; // only plain decisions supersede (not questions/goals/milestones/skills)
            const nTok = tokenSet(card.text);
            const area = (card.area || '').toLowerCase();
            // A correction-cue note ("CORRECTION: … was WRONG") declares it
            // replaces something — widen the search to ALL areas and lower the
            // bar: a cross-area reworded correction could never fire the
            // same-area 0.6 path by construction, which is exactly how stale
            // cards outlived their corrections in the field.
            const isCorrection = hasCorrectionCue(card.text);
            const nTokCmp = isCorrection ? stripCueMeta(nTok) : nTok;   // cue meta words dilute the denominator
            let best = null, bestScore = 0;
            for (const c of liveTextCards()) {
                if (!isCorrection && area && !sameAreaKey(c.area, area)) continue;
                if (/🛠/.test(c.text)) continue; // never auto-archive a 🛠️ skill via a decision's supersede — skills are standing reference (correct with ~)
                // Preserved dissent: an open objection is never outvoted by a later
                // agreeing decision, and one session's assessment never replaces
                // another's. Only an explicit closes: link or an id-addressed resolve ends one.
                if (/⚖️?\s*OBJECTION|🔎\s*ASSESSMENT/u.test(c.text)) continue;
                // cueMatch returns 0 unless it clears the widened bar (ratio OR
                // absolute subject mass) — so for corrections, any non-zero fires.
                const s = isCorrection ? cueMatch(nTokCmp, tokenSet(c.text), CORRECTION_SUPERSEDE_AT) : overlapScore(nTok, tokenSet(c.text));
                if (s > bestScore) { bestScore = s; best = c; }
            }
            if (best && (isCorrection ? bestScore > 0 : bestScore >= SUPERSEDE_AT)) {
                // Detect the round-trip BEFORE mutating B. The normal lifecycle
                // remains A→B→C; this adds a separate A→C provenance receipt and
                // a read-alone stamp without changing recall/as_of successor truth.
                const readopted = findReadoptedAncestor(struct, best, card.text);
                await rewriteCard(best.id, j => {
                    j.content = `↩︎ superseded ${today}\n${j.content}`;
                    j.borderColor = 'rgba(120,120,135,0.5)';
                });
                await archiveCard(best.id);
                const wasCross = isCorrection && (bestScore < SUPERSEDE_AT || (area && !sameAreaKey(best.area, area)));
                best.text = `↩︎ ${best.text}`;
                card.__supersedes = best.id;
                if (readopted) {
                    card.__reAdopts = readopted.id;
                    card.text = `${String(card.text || '').trimEnd()}\n${reAdoptionReceipt(readopted, today)}`;
                    stats.reAdopted++;
                }
                stats.superseded++;
                // Surface the widened match for confirmation: the caller tells the
                // agent what was archived and how to undo (restore from Archive /
                // re-run with ~) — the widened bar acts WITH a visible receipt.
                if (wasCross) stats.corrections.push({ old: (best.title || String(best.text).replace(/^↩︎\s*/, '').slice(0, 80)), area: best.area || null, overlap: Math.round(bestScore * 100) / 100 });
            }
        }

        // CLOSE-LINK — a card carrying `closes` resolves the (often cross-area)
        // strategy/question card that SPAWNED it: stamp ✅, archive it, and draw a
        // "closed by" arrow in pass 2. Unlike supersede (same-area, high lexical
        // overlap), a shipped milestone rarely echoes the strategy's prose — so
        // this matches across ALL areas, prefers an explicit [[wikilink]]/title
        // hit, and otherwise fires on only a low overlap. This is the fix for
        // "strategy cards never get closed out when their feature actually ships".
        for (const card of cards) {
            const target = (card.closes || '').toString().trim();
            if (!target) continue;
            const tier = closeTierFor(target, { strict: card.__closeStrict === true });
            if (tier.length > 4) {
                (stats.closeRefused ||= []).push(closeRefusal(target, tier));
                continue;
            }
            const chosen = tier;
            if (!chosen.length) continue;
            const ship = String(card.text).replace(/\s+/g, ' ').replace(/^[^:\n]{1,40}:\s*/, '').replace(/^🏁\s*/, '').trim().slice(0, 80);
            card.__closesIds = [];
            for (const { c: best } of chosen) {
                // Name what was archived — "N closed" alone gave the author no
                // way to see that a close grabbed the wrong card.
                const title = String(best.title || best.text || '').replace(/\s+/g, ' ').trim().slice(0, 90);
                await rewriteCard(best.id, j => {
                    j.content = `${j.content}\n✅ ${today}: closed by → ${ship}`;
                    j.borderColor = 'rgba(16,185,129,0.35)';
                });
                await archiveCard(best.id);
                best.text = `✅ ${best.text}`;
                card.__closesIds.push(best.id);
                stats.closed++;
                (stats.closedCards ||= []).push({ id: best.id, area: best.area || null, title, target: target.slice(0, 80) });
            }
        }

        cards.push(...milestonesFallback);

        // FULFILLMENT CROSS-CHECK (T6, 2026-07-23) — the write-side twin of the
        // incident fix: a new 🏁 that carries no explicit closes: still gets
        // reconciled against live open claims (prose "remaining:" clauses AND
        // ❓/🎯 cards) via the ONE shared extractor. Output is a dashed "likely
        // closed by" edge + a coverage receipt (covers / does NOT cover) that
        // the hook prints with a ready-to-emit ✓ marker. NEVER archives —
        // commit-derived milestones used to be lifecycle-INERT (the supersede
        // pass skips 🏁 by design); now they at least raise their hand.
        for (const card of cards) {
            if (!/🏁/.test(card.text) || card.__fromResolve) continue;
            const closed = new Set(card.__closesIds || []);
            const cands = findFulfillmentCandidates(struct, [{ text: card.text, createdAt: now }], { maxPerMilestone: 2 })
                .filter(c => !closed.has(c.open.id));
            if (!cands.length) continue;
            // Only COVERAGE-grade candidates earn a persisted edge; anchor-grade
            // ones ride the printed receipt (hedged) and are re-derived at serve
            // time. See the persist pass below for why.
            card.__fulfills = cands.filter(c => c.via !== 'anchor').map(c => c.open.id);
            for (const c of cands) {
                stats.fulfillCandidates.push({
                    open: String(c.open.text || '').replace(/\s+/g, ' ').slice(0, 90),
                    area: c.open.area || null,
                    item: c.item,
                    uncovered: c.uncovered,
                    cov: c.cov,
                    ...(c.via ? { via: c.via } : {}),
                    // A ✓ is suggested ONLY when the claim is FULLY covered and
                    // its tokens can actually clear the resolve matcher's ≥4
                    // floor — a partial ✓ used to archive the whole card
                    // (critical review finding), and a tiny-item ✓ resolved
                    // nothing and spawned a junk 🏁 fallback instead.
                    marker: (!c.uncovered.length && c.resolvable) ? `🧠 BRAIN [${c.open.area || 'Notes'}] ✓: ${c.item.slice(0, 80)}` : null,
                });
            }
        }

        // 🛠️↔🏁 OBSOLESCENCE CROSS-CHECK (2026-08-01 incident) — the write-side
        // twin of the serve-time skill pass, mirroring T6 exactly one class
        // over: a new 🏁 is reconciled against live SKILLS' limitation clauses
        // ("chat has no tools") the way T6 reconciles it against open claims.
        // Output is a receipt (stats.skillStale, printed by the hook with a
        // ready-to-emit ~ amendment) plus a dashed amber 'may obsolete' edge
        // for coverage-grade pairs. NEVER archives — the supersede and closes:
        // passes deliberately refuse to retire a 🛠️, and this pass inherits
        // that: a rule leaves the brain by human hand or not at all.
        for (const card of cards) {
            if (!/🏁/.test(card.text) || card.__fromResolve) continue;
            const cands = findSkillObsolescenceCandidates(struct, [{ text: card.text, createdAt: now }], { maxPerMilestone: 2 });
            if (!cands.length) continue;
            card.__obsoletes = cands.filter(c => c.via !== 'anchor').map(c => c.skill.id);
            for (const c of cands) {
                stats.skillStale.push({
                    skill: String(c.skill.text || '').replace(/\s+/g, ' ').slice(0, 90),
                    area: c.skill.area || null,
                    clause: c.clause,
                    cov: c.cov,
                    ...(c.via ? { via: c.via } : {}),
                    // The suggested act is an AMENDMENT (~), not an archive: most
                    // stale rules want the correction written into them — the
                    // trap half often survives even when the limitation half died.
                    marker: `🧠 BRAIN [${c.skill.area || 'Notes'}] ~: ${String(c.skill.title || c.skill.text).replace(/\s+/g, ' ').replace(/^🛠️?\s*/, '').slice(0, 60)} — CORRECTION: <what this ship changed>`,
                });
            }
        }
        stampBrainKind(manifest);
        work = await finalizeBrainZip(zip, canvas, manifest, now);
    }

    // Pass 2 — append the new cards (existing self-organizing path), then wire
    // connections: supersede arrows + [[wikilink]] auto-links.
    if (cards.length) {
        work = await appendIntoContainers(work, { cards });
        stats.added = cards.length;
        const { zip, canvas, manifest, struct } = await parseKlypix(work);
        const now = Date.now();
        const rand = () => Math.random().toString(36).slice(2, 10);
        canvas.connections = Array.isArray(canvas.connections) ? canvas.connections : [];
        const hasConn = (a, b) => canvas.connections.some(cn => (cn.fromId === a && cn.toId === b) || (cn.fromId === b && cn.toId === a));
        const addConn = (fromId, toId, label, relationship, opts = {}) => {
            if (!fromId || !toId || fromId === toId || hasConn(fromId, toId)) return;
            canvas.connections.push({ id: `con_${rand()}`, fromId, toId, relationship, label, arrowHead: true, width: opts.width ?? 2, color: opts.color ?? '#10b981', style: opts.style ?? 'solid' });
            stats.linked++;
        };
        // Locate each appended card by exact text match (newest first wins).
        const findNew = (text) => {
            const flatT = wrapText(String(text));
            for (let i = struct.cards.length - 1; i >= 0; i--) {
                const c = struct.cards[i];
                if (c.type !== 'container' && (c.text || '') === flatT) return c;
            }
            return null;
        };
        const titleIndex = struct.cards
            .filter(c => (c.title || '').trim())
            .map(c => ({ id: c.id, t: c.title.trim().toLowerCase() }));
        const newIds = new Set();
        for (const card of cards) {
            const created = findNew(card.text);
            if (!created) continue;
            newIds.add(created.id);
            if (card.__supersedes) addConn(card.__supersedes, created.id, 'superseded by', undefined);
            if (card.__reAdopts) addConn(card.__reAdopts, created.id, 're-adopts', undefined);
            for (const cid of (card.__closesIds || [])) addConn(cid, created.id, 'closed by', undefined);
            // Dashed, muted hint — a suggestion must never render pixel-identical
            // to a confirmed 'closed by' verdict edge on the human's canvas.
            for (const cid of (card.__fulfills || [])) addConn(cid, created.id, 'likely closed by', undefined, { style: 'dashed', width: 1.5, color: 'rgba(16,185,129,0.55)' });
            // 🛠️ staleness hints are AMBER, never the fulfilment emerald — "this
            // ship may retire that rule" and "this ship may close that task" must
            // stay visually distinct on the human's canvas.
            for (const sid of (card.__obsoletes || [])) addConn(sid, created.id, 'may obsolete', undefined, { style: 'dashed', width: 1.5, color: 'rgba(245,158,11,0.6)' });
            for (const link of (created.links || [])) {
                const want = String(link).trim().toLowerCase();
                if (!want) continue;
                const target = titleIndex.find(e => e.id !== created.id && (e.t === want || e.t.startsWith(want)));
                if (target) addConn(created.id, target.id, undefined, 'relates_to');
            }
        }
        // Structural auto-link for the NEW cards — the graph used to form only
        // when someone explicitly ran brain_connect (never, in practice: 66%
        // orphans in the field). Run the cheap tag/[[title]] proposer over the
        // post-append struct and keep only edges touching a just-added card
        // (≤2 per card via the proposer's own cap), labeled 'auto' so they're
        // distinguishable from deliberate arrows. Best-effort: an auto-link
        // failure must never fail a capture.
        if (newIds.size) {
            try {
                for (const e of proposeStructuralConnections(struct, { maxPerCard: 2 })) {
                    if (!newIds.has(e.fromId) && !newIds.has(e.toId)) continue;
                    addConn(e.fromId, e.toId, 'auto', 'relates_to');
                }
            } catch { /* auto-linking is opportunistic */ }
        }
        // PERSIST DETECTION AS EDGES (2026-07-29): staleOpenFooter printed its
        // findings as prose and wrote nothing, so a detection that fired at
        // SessionStart was invisible to brain_ask an hour later — miss the one
        // capture-time check and every ⏳ surface stayed blind forever. Every
        // capture now leaves dashed 'likely closed by' edges for the pairs the
        // detector can currently see. Suggestion-only contract unchanged (the
        // human ✓ retires cards; addConn dedups; a not_fulfilled dismissal
        // suppresses the pair inside findStaleOpenCards itself). Bounded: the
        // detector caps at 8 pairs and runs once per capture batch.
        try {
            const { gaps } = findStaleOpenCards(struct, { max: 8 });
            let hintEdges = 0;
            for (const g of gaps) {
                // ANCHOR-GRADE EVIDENCE IS NEVER PERSISTED. Its whole contract is
                // "suggestion, verify by hand" — persisting it made the next
                // render treat it as an established link, so a hint the serve
                // path hedged as "POSSIBLY FULFILLED" came back one capture
                // later at full strength and entered every settled set, i.e.
                // permanent unless dismissed (2026-07-29 review, CONFIRMED).
                // Anchor pairs stay serve-time-only, re-derived and re-hedged
                // on each render, so they cost nothing to be wrong about.
                if (g.via === 'anchor') continue;
                const before = stats.linked;
                addConn(g.open.id, g.by.id, 'likely closed by', undefined, { style: 'dashed', width: 1.5, color: 'rgba(16,185,129,0.55)' });
                if (stats.linked > before) { hintEdges++; continue; }
                // hasConn is pair-level and label-blind, and the structural
                // auto-linker runs FIRST in this same capture — so a co-tagged
                // pair already wearing an 'auto' relates_to edge could never
                // receive its hint, on this or any future capture (2026-07-29
                // review, CONFIRMED). Upgrade the weaker edge in place instead
                // of dropping the finding on the floor. Dismissals and existing
                // hints are left exactly as they are.
                for (const cn of canvas.connections) {
                    const samePair = (cn.fromId === g.open.id && cn.toId === g.by.id) || (cn.fromId === g.by.id && cn.toId === g.open.id);
                    if (!samePair || cn.label === 'likely closed by' || cn.label === '↩ dismissed hint' || DISMISSAL_RELS.has(cn.relationship)) continue;
                    cn.fromId = g.open.id; cn.toId = g.by.id;
                    cn.label = 'likely closed by'; cn.style = 'dashed'; cn.width = 1.5; cn.color = 'rgba(16,185,129,0.55)';
                    hintEdges++;
                    break;
                }
            }
            if (hintEdges) stats.hintEdges = hintEdges;
        } catch { /* hint persistence is opportunistic — never fail a capture */ }
        // ORPHAN GARDENER AT CAPTURE (1.70.0) — a capture must not mint graph
        // orphans. Any just-added decision/milestone card that every pass above
        // (supersede/closes/wikilink/structural/hint) left with ZERO edges gets:
        //   • an edge to its own area container (muted, dashed — containment
        //     made visible, so the card is reachable from the graph), and
        //   • at most ONE confident lexical-anchor edge (exact [[wikilink]],
        //     exact file-slug tag, or an unambiguous ≥0.6 title overlap) —
        //     never a fan-out, never a guess among multiple candidates.
        // Additive + lossless; a failure never fails the capture.
        if (newIds.size) {
            try {
                for (const p of proposeOrphanAnchorLinks(struct, { onlyIds: newIds, connections: canvas.connections })) {
                    if (p.anchor) addConn(p.cardId, p.anchor.toId, 'auto', 'relates_to');
                    if (p.areaId) addConn(p.cardId, p.areaId, 'in area', 'relates_to', { color: 'rgba(120,120,135,0.45)', width: 1, style: 'dashed' });
                    stats.orphanLinked = (stats.orphanLinked || 0) + 1;
                }
            } catch { /* orphan auto-link is opportunistic — never fail a capture */ }
        }
        stampBrainKind(manifest);
        work = await finalizeBrainZip(zip, canvas, manifest, now);
    }

    return { buffer: work, stats };
}

// Deterministic candidate selection — PURE, so the model never chooses WHAT to
// merge. SMART + non-invasive: a card is a candidate only if it's DORMANT —
// old (> minAgeDays), beyond the area's newest N, AND peripheral (connection
// degree ≤ maxDegree). That protects hubs and still-referenced cards (the spine
// of the brain), so consolidation hits forgotten noise — the same cards
// brain_insights flags as orphaned — never load-bearing decisions. Returns each
// over-grown area with its dormant cards (oldest first), each tagged with degree.
export function selectGardenCandidates(struct, { keepNewest = GARDEN_KEEP_NEWEST, minAgeDays = GARDEN_MIN_AGE_DAYS, minCandidates = GARDEN_MIN_CANDIDATES, maxDegree = GARDEN_MAX_DEGREE, now = Date.now() } = {}) {
    if (!struct || !Array.isArray(struct.cards)) return [];
    const cutoff = now - minAgeDays * 86_400_000;
    // Connection degree per card — both ends of every edge. A card that is linked
    // to (or links out to) the rest of the graph is structurally load-bearing.
    const degree = new Map();
    for (const cn of (struct.connections || [])) {
        if (cn.fromId) degree.set(cn.fromId, (degree.get(cn.fromId) || 0) + 1);
        if (cn.toId) degree.set(cn.toId, (degree.get(cn.toId) || 0) + 1);
    }
    const out = [];
    for (const ctn of struct.cards) {
        if (ctn.type !== 'container') continue;
        const title = (ctn.title || '').trim();
        if (!title || GARDEN_PROTECTED.test(title)) continue;
        const children = struct.cards
            .filter(c => c.type === 'text' && c.parentId === ctn.id && (c.text || '').trim() && !/⤵|↩|✅|🛠|❓|🎯/.test(c.text))  // 🛠️ skills are standing reference — never consolidate them away; ❓/🎯 are OPEN items — dormancy is not resolution, and consolidating one is silent false-retirement (2026-07-23 audit; GARDEN_PROTECTED only shields containers *titled* "open questions")
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const autoCutoff = now - GARDEN_AUTO_MIN_AGE_DAYS * 86_400_000;
        const isAuto = (c) => (c.tags || []).some(t => String(t).toLowerCase().replace(/^#/, '') === 'auto');
        const old = children
            .slice(0, Math.max(0, children.length - keepNewest))
            .filter(c => (c.createdAt || 0) < (isAuto(c) ? autoCutoff : cutoff) && (degree.get(c.id) || 0) <= maxDegree);  // dormant: old AND peripheral (#auto ages faster)
        if (old.length >= minCandidates) out.push({ containerId: ctn.id, title, candidates: old.map(c => ({ id: c.id, text: c.text, createdAt: c.createdAt || 0, degree: degree.get(c.id) || 0 })) });
    }
    return out;
}

// Apply: re-selects deterministically (robust to drift since the dry-run) and,
// for each area the agent supplied a synthesis for, adds the 🌿 card + archives
// the originals with audit arrows. `syntheses`: [{ title, synthesis }].
export async function applyGarden(buffer, { syntheses = [] } = {}) {
    const stats = { areas: 0, archived: 0, synthCards: 0, skipped: [] };
    const { zip, canvas, manifest, isV4, struct } = await parseKlypix(buffer);
    if (!isV4 || !canvas.positions) throw new Error('garden needs a v4 .klypix');
    const areas = selectGardenCandidates(struct);
    const synthByTitle = new Map();
    for (const s of syntheses || []) { const t = String(s?.title || '').trim().toLowerCase(); const txt = String(s?.synthesis || '').trim(); if (t && txt) synthByTitle.set(t, txt); }
    if (!areas.length || !synthByTitle.size) return { buffer, stats };

    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const rand = () => Math.random().toString(36).slice(2, 10);
    const top = Object.values(canvas.positions).map(p => p && p.zKey).filter(k => k && isValidZKey(k)).sort().pop() || null;
    const nextZKey = makeZKeyGen(top);
    canvas.connections = Array.isArray(canvas.connections) ? canvas.connections : [];
    const byTitle = new Map();
    for (const c of struct.cards) if (c.type === 'container') { const t = normTitleKey(c.title); if (t && !byTitle.has(t)) byTitle.set(t, c.id); }
    // Archive primitives (mirror captureIntoBrain): find-or-create Archive, move a
    // card into it un-baking any group-shrink, and rewrite a card's text in place.
    const createdCtns = new Set();
    const newCards = [];
    const ensureArchive = () => {
        let id = byTitle.get('archive');
        if (id) return id;
        id = `ctn_${rand()}`;
        createdCtns.add(id);
        const G = BRAIN_GEOM;
        zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify({ type: 'container', locked: false, createdAt: now, createdBy: 'agent', title: 'Archive', collapsed: false, scopeLocked: false, borderColor: 'rgba(120,120,135,0.6)' }));
        canvas.positions[id] = { x: nextContainerX(canvas), y: G.START, w: G.AREA_W, h: G.TITLE_BAR + G.PAD * 2, zKey: nextZKey(), zIndex: canvas.order.length, parentId: null };
        canvas.order.push(id);
        byTitle.set('archive', id);
        return id;
    };
    const rewriteCard = async (id, mutate) => {
        const ip = `items/${shard(id)}/${id}.json`;
        const f = zip.file(ip); if (!f) return false;
        const j = JSON.parse(await f.async('string'));
        mutate(j);
        j.content = wrapText(String(j.content || ''));
        zip.file(ip, JSON.stringify(j));
        const pos = canvas.positions[id];
        if (pos) canvas.positions[id] = { ...pos, h: measureCardH(j.content) };
        return true;
    };
    const archiveCard = async (id) => {
        const arc = ensureArchive();
        let authoredW = null;
        const ip = `items/${shard(id)}/${id}.json`;
        const f = zip.file(ip);
        if (f) {
            const j = JSON.parse(await f.async('string'));
            const a = j.authoredInParent;
            if (a) {
                if (j.type === 'text' && a.fontSize) j.fontSize = a.fontSize;
                if (a.authoredWidth != null) j.authoredWidth = a.authoredWidth;
                authoredW = a.w || null;
                delete j.authoredInParent;
                zip.file(ip, JSON.stringify(j));
            }
        }
        const pos = canvas.positions[id];
        if (pos) canvas.positions[id] = { ...pos, parentId: arc, ...(authoredW ? { w: authoredW } : {}) };
    };

    for (const area of areas) {
        const synthesis = synthByTitle.get(area.title.trim().toLowerCase());
        if (!synthesis) continue;                          // model skipped this area — leave it untouched
        const ctnPos = canvas.positions[area.containerId];
        if (!ctnPos) continue;
        // FAITHFULNESS GUARD (1) — degeneracy: a synthesis far too thin for the
        // cards it replaces is rejected; that area is left untouched + reported,
        // so a one-word "done" can't bury real history. (Originals stay put.)
        const collapsed = synthesis.replace(/\s+/g, ' ').trim();
        if (collapsed.length < MIN_SYNTHESIS_CHARS) {
            stats.skipped.push({ title: area.title, reason: `synthesis too thin (${collapsed.length} chars, need ${MIN_SYNTHESIS_CHARS}) — revise and re-apply` });
            continue;
        }
        // FAITHFULNESS GUARD (2) — figures net: any distinct number (version /
        // size / date / count) in the originals that the prose dropped is appended
        // verbatim, so the crispest facts survive on the visible card even if the
        // synthesis missed them. The originals are archived verbatim regardless.
        const origFigs = new Set();
        for (const c of area.candidates) for (const f of figuresIn(c.text)) origFigs.add(f);
        const synLower = synthesis.toLowerCase();
        const missing = [...origFigs].filter(f => !synLower.includes(f));
        const finalSynth = missing.length ? `${synthesis}\n↳ figures: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}` : synthesis;
        const span = `${new Date(area.candidates[0].createdAt || now).toISOString().slice(0, 10)} → ${new Date(area.candidates[area.candidates.length - 1].createdAt || now).toISOString().slice(0, 10)}`;
        const content = wrapText(`${area.title}: 🌿 Consolidated history (${span}, ${area.candidates.length} cards)\n${finalSynth}`);
        const sid = `txt_${rand()}`;
        // `sources` = machine lineage (which originals fed this synthesis, with
        // their birth dates) — as_of and future provenance passes read the
        // field, never the prose.
        zip.file(`items/${shard(sid)}/${sid}.json`, JSON.stringify({ type: 'text', locked: false, createdAt: now, createdBy: 'agent', ...authorField(), createdVia: 'gardener', content, fontSize: 12, color: '#e8e8ed', border: true, borderColor: 'rgba(59,130,246,0.6)', heading: false, sources: area.candidates.map(c => ({ id: c.id, createdAt: c.createdAt || 0 })) }));
        canvas.positions[sid] = { x: ctnPos.x + 20, y: ctnPos.y + (ctnPos.h || 0) + 10, w: 300, h: measureCardH(content), zKey: nextZKey(), zIndex: canvas.order.length, parentId: area.containerId };
        canvas.order.push(sid);
        newCards.push(sid);
        stats.synthCards++;
        for (const cand of area.candidates) {
            // consolidatedAt = the machine death-date deathDateOfCard prefers —
            // as_of must never depend on the prose stamp parsing correctly.
            await rewriteCard(cand.id, j => { j.content = `⤵ consolidated ${today}\n${j.content}`; j.borderColor = 'rgba(120,120,135,0.5)'; j.consolidatedAt = now; });
            await archiveCard(cand.id);
            canvas.connections.push({ id: `con_${rand()}`, fromId: cand.id, toId: sid, relationship: 'relates_to', label: 'consolidated into', arrowHead: true, width: 1.5, color: 'rgba(120,120,135,0.7)', style: 'solid' });
            stats.archived++;
        }
        stats.areas++;
    }
    if (!stats.synthCards) return { buffer, stats };
    // Broadcast-time overlap guarantee (same as appendIntoContainers): the
    // synthesis card lands BELOW the container frame (auto-grow collision) and
    // archived cards re-parent while keeping their old world spot (Archive
    // balloon) — the incremental re-flow re-stacks both before finalizing.
    if (canvas.settings && canvas.settings.brainLayout === 'cluster-v1') {
        const containerIds = new Set(struct.cards.filter(c => c.type === 'container').map(c => c.id));
        for (const id of byTitle.values()) containerIds.add(id);
        const meta = new Map();
        for (const c of struct.cards) {
            if (c.type === 'container') continue;
            const p = canvas.positions[c.id] || {};
            meta.set(c.id, { h: Math.max(40, Number(p.h) || 40), w: Math.max(40, Number(p.w) || BRAIN_GEOM.CARD_W), keepSize: true, createdAt: Number(c.createdAt) || 0 });
        }
        for (const id of newCards) {
            const p = canvas.positions[id];
            meta.set(id, { h: Math.max(40, Number(p.h) || 40), w: Math.max(40, Number(p.w) || BRAIN_GEOM.CARD_W), keepSize: true, createdAt: now });
        }
        await reflowBrainGeometry({ zip, canvas, struct, meta, containerIds, extraTitles: byTitle, forceFull: false, createdNow: createdCtns, clearKidAnchors: true });
    }
    stampBrainKind(manifest);
    const out = await finalizeBrainZip(zip, canvas, manifest, now);
    return { buffer: out, stats };
}
// Document frequency of STEMMED tokens across live (non-archived, non-container)
// cards — the rarity oracle for anchor matching. O(cards × tokens), built once
// per detection pass and only when a pass actually needs it (lazy).
export function buildStemDf(struct) {
    const df = new Map();
    let live = 0;
    for (const c of struct?.cards || []) {
        if (c.type === 'container' || !(c.text || '').trim() || /^archive$/i.test(c.area || '')) continue;
        live++;
        for (const t of stemSet(tokenSet(c.text))) df.set(t, (df.get(t) || 0) + 1);
    }
    df.__live = live;
    df.__max = anchorDfMax(live);
    return df;
}
export function sharedAnchors(aIdx, bIdx, df, { exclude = null } = {}) {
    const out = [];
    const max = (df && df.__max) || 2;
    const aIsMap = aIdx instanceof Map, bIsMap = bIdx instanceof Map;
    for (const t of (aIsMap ? aIdx.keys() : aIdx)) {
        if (exclude && exclude.has(t)) continue;                 // structural (area/tag) token — shared by construction
        if (!(bIsMap ? bIdx.has(t) : bIdx.has(t))) continue;
        if ((df?.get(t) || 0) > max) continue;                   // not rare enough for this corpus size
        if (aIsMap && bIsMap && !rawMatch(aIdx.get(t), bIdx.get(t))) continue;   // stem collision, not the same word
        out.push(t);
    }
    return out;
}
// One pair-scorer for every serve-/heal-time surface: stemmed coverage of the
// open card's claim by the milestone + shared rare anchors. Suggestion-grade
// evidence, never a close verdict.
export function likelyFulfillsLexical(openCard, milestone, df) {
    const oIdx = stemIndex(claimTokens(normalizeWrappedProse(openCard?.text)));
    const mIdx = stemIndex(tokenSet(milestone?.text));
    if (!oIdx.size || !mIdx.size) return { cov: 0, anchors: [], size: oIdx.size };
    const cov = coverageOf(new Set(oIdx.keys()), new Set(mIdx.keys()));
    const anchors = df ? sharedAnchors(oIdx, mIdx, df, { exclude: structuralStems(openCard?.area, milestone?.area) }) : [];
    return { cov: Math.round(cov * 100) / 100, anchors, size: oIdx.size };
}
export function planFulfillmentFor(struct, cards, { pairSim = null, scope = 'brain', milestones = null, df = null } = {}) {
    const out = new Map();
    if (!struct || !Array.isArray(struct.cards) || !Array.isArray(cards) || !cards.length) return out;
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const plans = cards.filter(c => c && isPlanCard(c) && !isArchived(c));
    if (!plans.length) return out;
    const miles = Array.isArray(milestones) ? milestones.filter(Boolean)
        : struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim() && !isArchived(c) && isMilestoneCard(c));
    if (!miles.length) return out;
    // Settled pairs: an existing hint edge or close (plan → ship), and human
    // dismissals in EITHER direction — a person draws "this ship is not that
    // plan" as naturally as the reverse (review 2026-08-23).
    const settled = new Set();
    for (const cn of struct.connections || []) {
        if (cn.label === 'likely closed by' || cn.label === 'closed by') settled.add(`${cn.fromId}|${cn.toId}`);
        if (DISMISSAL_RELS.has(cn.relationship)) { settled.add(`${cn.fromId}|${cn.toId}`); settled.add(`${cn.toId}|${cn.fromId}`); }
    }
    const dfMap = () => (df ??= buildStemDf(struct));
    const simBar = scope === 'answer' ? PLAN_PAIR_SIM_ANSWER : PLAN_PAIR_SIM_BRAIN;
    const mPre = miles.map(m => { const idx = stemIndex(tokenSet(m.text)); return { m, idx, keys: new Set(idx.keys()) }; });
    const structural = new Map();
    const excludeFor = (a, b) => { const k = `${a || ''}|${b || ''}`; if (!structural.has(k)) structural.set(k, structuralStems(a, b)); return structural.get(k); };
    for (const o of plans) {
        const oIdx = stemIndex(claimTokens(normalizeWrappedProse(o.text)));
        const oKeys = new Set(oIdx.keys());
        if (oKeys.size < SERVE_MIN_STEMS) continue;                         // too vague to pair safely
        // TWO-PASS selection (order-independent — review 2026-08-23 showed the
        // single-pass near-tie rule picked a different ship per card order):
        // collect every accepted candidate, take the top score, then among the
        // candidates within 0.1 of it choose the EARLIEST ship; remaining ties
        // → the original id over a twin id, then the higher score, then the id.
        const accepted = [];
        for (const { m, idx: mIdx, keys: mKeys } of mPre) {
            if (!m || m.id === o.id || (m.createdAt || 0) <= (o.createdAt || 0)) continue;   // a ship must post-date the plan
            if (settled.has(`${o.id}|${m.id}`)) continue;
            const sim = typeof pairSim === 'function' ? pairSim(o.id, m.id) : null;
            const cov = coverageOf(oKeys, mKeys);
            const sameArea = (o.area || '') === (m.area || '');
            // Rare shared anchors are only worth computing when a tier can use them.
            const wantAnchors = (sim != null && sim >= simBar) || scope === 'answer' || cov >= ANCHOR_COV_FLOOR;
            const anchors = wantAnchors ? sharedAnchors(oIdx, mIdx, dfMap(), { exclude: excludeFor(o.area, m.area) }) : [];
            const lex = { cov: Math.round(cov * 100) / 100, anchors, size: oKeys.size };
            // Corroboration reads the ROUNDED coverage the receipt reports (the
            // incident pair measures 0.20 = 10 of 51 stems; a raw 0.196 must not
            // fail a bar that was set from the rounded measurement).
            const corroborated = anchors.length >= 1 || lex.cov >= 0.2;
            // A MEASURED cosine decides the brain tier. The lexical bars exist
            // for hosts with no vectors; when the embedding has already
            // measured a pair as NOT near-duplicate, rare shared words must not
            // overrule it. Measured on the KLYPIX brain sweep (23 pairs): four
            // of the five false pairs came through the anchor path at cosines
            // 0.64–0.74 ("core roadmap" ↔ a desktop build, a freeze plan ↔ the
            // emoji picker); the veto costs one true pair at 0.748 (the single-
            // writer architecture ↔ the one-write-lock release) — precision-
            // first, as every sibling surface. The answer tier keeps its own
            // question-constrained lexical acceptance.
            const lexOk = scope === 'answer'
                ? serveTimeAccepts(lex, sameArea)
                : (sim == null && (cov >= 0.6 || anchorsSufficient(anchors, sameArea, cov)));
            const embedOk = sim != null && sim >= simBar && corroborated;
            if (!embedOk && !lexOk) continue;
            const via = embedOk ? 'embed' : (cov >= 0.6 || lex.cov >= SERVE_COV_BAR ? 'coverage' : 'anchor');
            accepted.push({ m, score: (sim ?? 0) + cov + anchors.length * 0.2, lex, sim, via });
        }
        if (!accepted.length) continue;
        const top = Math.max(...accepted.map(a => a.score));
        const band = accepted.filter(a => a.score >= top - 0.1);
        band.sort((a, b) => ((a.m.createdAt || 0) - (b.m.createdAt || 0))
            || ((isAgconfTwinId(a.m.id) ? 1 : 0) - (isAgconfTwinId(b.m.id) ? 1 : 0))
            || (b.score - a.score)
            || String(a.m.id).localeCompare(String(b.m.id)));
        const best = band[0];
        const head = String(best.m.text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
        out.set(o.id, { kind: 'plan', by: head, byId: best.m.id, cov: best.lex.cov, sim: best.sim == null ? null : Math.round(best.sim * 1000) / 1000, via: best.via, unconfirmed: true, scope });
    }
    return out;
}
export function extractOpenClauses(text) {
    // Sentence-shaped cues ([^:\n], [^\n]+, sentence-initial verbs) read the
    // UNWRAPPED prose — stored hard-wraps otherwise truncate every clause at
    // the first wrap point (~37 chars), which silently crippled clause capture
    // for all STORED cards while tests fed unwrapped text and stayed green.
    // A line that OPENS with its own cue ("remaining: A" under "pending: B")
    // is an authored list entry, not a soft wrap — promote it to a paragraph
    // boundary before joining, or the join would fold sibling claims into one.
    const t = normalizeWrappedProse(String(text || '').split('\n').map(l => CUE_LINE_RE.test(l) ? '\n' + l : l).join('\n'));
    const out = [];
    for (const m of t.matchAll(CLAIM_CUE_RE)) {
        // Stop the clause at the first SENTENCE boundary, not at paragraph end.
        // Unwrapping made a stored card one long paragraph, so "remaining: X."
        // followed by "Y shipped already." absorbed the done-sentence into the
        // claim — coverage then cleared the bar against the milestone that
        // shipped Y and the footer suggested a ✓ for a card whose real
        // remaining item was untouched (2026-07-29 review, CONFIRMED).
        // Same version-literal-safe split as classifyDecay: '1.3.28' survives.
        const clause = (m[1] || m[2] || '').split(/[!?]\s|\.(?=\s|$)/)[0].trim();
        if (!clause) continue;
        const items = clause.split(/\s*(?:\+|·|;)\s*/)
            .map(x => x.trim()).filter(x => x.length >= 4)
            .map(x => ({ text: x, tokens: claimTokens(x) }))
            .filter(it => it.tokens.size >= 1);
        if (items.length) out.push({ clause, items });
    }
    if (/❓|🎯/.test(t)) {
        for (const m of t.matchAll(IMPERATIVE_ASK_RE)) {
            const clause = (m[1] || '').trim();
            if (!clause) continue;
            const tokens = claimTokens(clause);
            if (tokens.size >= 3) out.push({ clause, items: [{ text: clause, tokens }] });
        }
    }
    return out;
}

// One-sided fulfillment scan: which live open claims do these milestones appear
// to fulfil? O(claims × milestones) — NEVER an all-pairs brain scan. Returns
// receipt-bearing candidates ({covered item, uncovered siblings, coverage}) and
// ARCHIVES NOTHING — callers draw dashed "likely closed by" edges / prompt for
// a human ✓; retirement always stays a human act. Skills (🛠) and already-dead
// cards are never claim sources; a milestone must post-date the claim card.
export function findFulfillmentCandidates(struct, milestones, { coverAt = 0.6, requireNewer = true, maxPerMilestone = 3 } = {}) {
    if (!struct || !Array.isArray(struct.cards) || !Array.isArray(milestones) || !milestones.length) return [];
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    // 🏁 cards ARE claim sources for their prose clauses — the incident's own
    // shape was "🏁 Phase 1 VERIFIED. remaining: X + Y", and excluding 🏁 made
    // the incident class invisible to this very scan (review finding). Only
    // dead/skill cards are excluded; self-match is guarded below.
    const live = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim()
        && !isArchived(c) && !/↩|✅|⤵|🛠/.test(c.text));
    // Dismissals + existing hints: a pair the human rejected (not_fulfilled
    // edge via brain_connect) or that already carries a hint edge is never
    // re-suggested — wrong hints must be dismissable, not permanent.
    const settled = new Set();
    for (const cn of struct.connections || []) {
        if (cn.label === 'likely closed by' || cn.relationship === 'not_fulfilled') settled.add(`${cn.fromId}|${cn.toId}`);
    }
    // Milestone token sets ONCE — this used to sit in the innermost item loop
    // (claims × items × milestones tokenizations; output caps bound results,
    // not work — the 9000-card constraint is about work). Comparison happens on
    // STEMMED sets (stemLight) so excludes/excluding, packaged/packaging count
    // as the hits they are — stored token sets stay untouched.
    const mPre = milestones.map(m => ({ m, idx: stemIndex(tokenSet(m.text)), tok: stemSet(tokenSet(m.text)) }));
    // Rarity oracle for the anchor OR-path — built lazily: most captures carry
    // no open-shaped claims at all and must not pay the corpus scan.
    let df = null;
    const dfMap = () => (df ??= buildStemDf(struct));
    const out = [];
    for (const o of live) {
        const clauses = extractOpenClauses(o.text);
        // A whole ❓/🎯 card with no prose clause IS the claim (glyph-gated
        // path; never for 🏁 cards — their claim is only the explicit clause).
        // A plan-shaped plain card (isPlanCard, 2026-08-23) is the same claim
        // shape without the glyph: "we will build X" is fulfilled by "🏁 X".
        const planShaped = isPlanCard(o);
        if (!clauses.length && (/❓|🎯/.test(o.text) || planShaped) && !/🏁/.test(o.text)) {
            const tk = claimTokens(o.text);
            if (tk.size >= 4) clauses.push({ clause: null, items: [{ text: flat(o.text).slice(0, 120), tokens: tk }] });
        }
        for (const cl of clauses) {
            for (const it of cl.items) {
                if (it.tokens.size < 2) continue;              // one-token items match everything
                const itIdx = stemIndex(it.tokens);
                const itStems = new Set(itIdx.keys());
                for (const { m, idx: mIdx, tok: mTok } of mPre) {
                    if (m.id && m.id === o.id) continue;       // a milestone never fulfils its own clause
                    if (m.id && settled.has(`${o.id}|${m.id}`)) continue;
                    if (requireNewer && Number.isFinite(m.createdAt) && m.createdAt <= (o.createdAt || 0)) continue;
                    const cov = coverageOf(itStems, mTok);
                    // ANCHOR OR-PATH (2026-07-29 incident): a verbose diagnostic
                    // ❓ vs a terse differently-worded 🏁 can NEVER reach the flat
                    // bar (42-token denominator, 0.21 measured) — but the pair
                    // shares near-unique tokens. ≥2 rare anchors in the same
                    // area (≥3 cross-area) is hint-grade evidence on its own.
                    // Suggestion-only by construction: via:'anchor' candidates
                    // are never ✓-resolvable and get their own per-milestone cap.
                    let viaAnchor = false;
                    if (cov < coverAt) {
                        const anchors = sharedAnchors(itIdx, mIdx, dfMap(), { exclude: structuralStems(o.area, m.area) });
                        if (!anchorsSufficient(anchors, (o.area || '') === (m.area || ''), cov)) continue;
                        viaAnchor = true;
                    }
                    const uncovered = cl.items.filter(x => x !== it && coverageOf(stemSet(x.tokens), mTok) < coverAt).map(x => x.text);
                    out.push({ open: o, clause: cl.clause, item: it.text, uncovered, milestone: m, cov: Math.round(cov * 100) / 100, resolvable: !viaAnchor && it.tokens.size >= 4, ...(viaAnchor ? { via: 'anchor' } : {}), ...(planShaped ? { kind: 'plan' } : {}) });
                }
            }
        }
    }
    // Best candidate per (open card, milestone) pair; bounded per milestone so
    // one generic ship can never spray edges across the brain.
    const byPair = new Map();
    for (const c of out) {
        const key = `${c.open.id}|${c.milestone.id || milestones.indexOf(c.milestone)}`;
        if (!byPair.has(key) || byPair.get(key).cov < c.cov) byPair.set(key, c);
    }
    // GENERICITY GUARD (mirror the close-pass >4-match rule): an item whose
    // tokens are covered by MANY different milestones is too generic to be a
    // useful hint ("shipped desktop bundle" matches every release card) —
    // drop it entirely; a real claim matches the one or two ships that
    // actually fulfilled it. Then at most 2 hints per item, capped per
    // milestone so one generic ship can never spray edges across the brain.
    const byItem = new Map();
    for (const c of byPair.values()) {
        const k = `${c.open.id}|${c.item}`;
        if (!byItem.has(k)) byItem.set(k, []);
        byItem.get(k).push(c);
    }
    const perMile = new Map();
    const perMileAnchor = new Map();
    const kept = [];
    for (const group of byItem.values()) {
        if (group.length > 3) continue;                    // too generic — no hint
        for (const c of group.sort((a, b) => b.cov - a.cov).slice(0, 2)) {
            const mk = c.milestone.id || milestones.indexOf(c.milestone);
            // Anchor-path candidates spend a SEPARATE (smaller) per-milestone
            // budget: the coverage-path cap must not crowd them out — the exact
            // starvation the 2026-07-29 critic probe found at low bars — and
            // they must not inflate the coverage path's spray allowance either.
            const budget = c.via === 'anchor' ? perMileAnchor : perMile;
            const cap = c.via === 'anchor' ? 2 : maxPerMilestone;
            const n = budget.get(mk) || 0;
            if (n >= cap) continue;
            budget.set(mk, n + 1);
            kept.push(c);
        }
    }
    kept.sort((a, b) => b.cov - a.cov);
    return kept;
}

// Serving-time fulfillment overlay: a recalled open card that a live milestone
// likely fulfilled (a dashed "likely closed by" edge exists) must never render
// as plain open truth — the reader gets the hint + the confirm receipt. Renders
// BELOW a correction overlay when both exist (correction wins precedence).
export function fulfillmentOverlaysFor(struct, cards) {
    const map = new Map();
    if (!struct || !Array.isArray(struct.connections)) return map;
    const byId = new Map(struct.cards.map(c => [c.id, c]));
    const want = new Set((cards || []).map(c => c.id));
    // A dismissal WINS even if both edges coexist on the pair — the relabel in
    // addBrainConnections handles new dismissals, and this covers any brain
    // where the two edges got written independently (or by an older build).
    const dismissed = new Set();
    for (const cn of struct.connections) {
        if (DISMISSAL_RELS.has(cn.relationship)) { dismissed.add(`${cn.fromId}|${cn.toId}`); dismissed.add(`${cn.toId}|${cn.fromId}`); }
    }
    for (const cn of struct.connections) {
        if (cn.label !== 'likely closed by' || !want.has(cn.fromId)) continue;
        if (dismissed.has(`${cn.fromId}|${cn.toId}`)) continue;
        const m = byId.get(cn.toId);
        if (!m || /^archive$/i.test(m.area || '')) continue;    // a since-archived milestone no longer vouches
        const head = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
        // Machine-written hints (capture-time detection, no human ✓) stay
        // HEDGED after persistence. Before this, one capture silently promoted
        // a suggestion to the confirmed "⏳ LIKELY FULFILLED" tier — the diff's
        // own hedging defeated one session later (2026-07-29 review, CONFIRMED).
        if (!map.has(cn.fromId)) map.set(cn.fromId, { by: head, byId: m.id, unconfirmed: cn.hintVia !== 'human' });
    }
    return map;
}
export function extractLimitationClaims(text) {
    // Same unwrap discipline as extractOpenClauses: stored hard-wraps would
    // otherwise truncate every sentence at the first wrap point. Same
    // version-literal-safe sentence split ('1.3.28' survives).
    const t = normalizeWrappedProse(String(text || ''));
    const out = [];
    for (const raw of t.split(/[!?]\s+|\.(?=\s|$)/)) {
        let clause = raw.replace(/^[\s\-–—•·"“”'‘’()[\]]+/, '').trim();
        if (!clause || clause.length < 12) continue;
        if (ADVICE_OPENER_RE.test(clause)) continue;
        if (!LIMITATION_CUE_RE.test(clause)) continue;
        // CONTRAST CUT: the limitation is the pre-contrast span — "Chat has no
        // tools, but the system prompt claimed…" claims only "Chat has no
        // tools"; the tail is elaboration whose tokens drown the coverage
        // denominator (measured on the incident card: whole-sentence cov 0.31
        // → cut cov 0.75). Keep the cut only if it still carries the cue.
        const cut = clause.split(/,?\s+(?:but|however|yet|whereas|--+|—)\s+/i)[0].trim();
        if (cut.length >= 12 && LIMITATION_CUE_RE.test(cut) && claimTokens(cut).size >= 3) clause = cut;
        const tokens = claimTokens(clause);
        if (tokens.size < 3) continue;                       // tiny claims match everything
        out.push({ clause: clause.slice(0, 160), tokens });
        if (out.length >= 4) break;                          // a skill is one lesson, not a spec sheet
    }
    return out;
}

// One-sided scan: which live 🛠️ limitation claims do these milestones appear to
// REMOVE? Mirrors findFulfillmentCandidates (bounded, receipt-bearing, archives
// nothing): a milestone must post-date the skill, acceptance is clause coverage
// OR rare-anchor corroboration, dismissals (`not_fulfilled`) and existing hint
// edges are never re-suggested, and one generic ship is capped so it can never
// spray edges across the rulebook.
export function findSkillObsolescenceCandidates(struct, milestones, { coverAt = 0.6, maxPerMilestone = 3 } = {}) {
    if (!struct || !Array.isArray(struct.cards) || !Array.isArray(milestones) || !milestones.length) return [];
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const liveSkills = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim()
        && !isArchived(c) && isSkillCard(c) && !/↩|⤵/.test(c.text));
    if (!liveSkills.length) return [];
    const settled = new Set();
    for (const cn of struct.connections || []) {
        if (cn.label === 'may obsolete' || DISMISSAL_RELS.has(cn.relationship)) settled.add(`${cn.fromId}|${cn.toId}`);
    }
    const mPre = milestones.map(m => ({ m, idx: stemIndex(tokenSet(m.text)) }));
    let df = null;
    const dfMap = () => (df ??= buildStemDf(struct));
    const out = [];
    for (const s of liveSkills) {
        const claims = extractLimitationClaims(s.text);
        for (const cl of claims) {
            const clIdx = stemIndex(cl.tokens);
            const clStems = new Set(clIdx.keys());
            for (const { m, idx: mIdx } of mPre) {
                if (m.id && m.id === s.id) continue;
                if (m.id && settled.has(`${s.id}|${m.id}`)) continue;
                if (Number.isFinite(m.createdAt) && m.createdAt <= (s.createdAt || 0)) continue;   // a rule written AFTER the ship is post-fix knowledge, not stale
                const cov = coverageOf(clStems, new Set(mIdx.keys()));
                let viaAnchor = false;
                if (cov < coverAt) {
                    const anchors = sharedAnchors(clIdx, mIdx, dfMap(), { exclude: structuralStems(s.area, m.area) });
                    if (!anchorsSufficient(anchors, (s.area || '') === (m.area || ''), cov)) continue;
                    viaAnchor = true;
                }
                out.push({ skill: s, clause: cl.clause, milestone: m, cov: Math.round(cov * 100) / 100, ...(viaAnchor ? { via: 'anchor' } : {}) });
            }
        }
    }
    // Best candidate per (skill, milestone) pair, then per-milestone cap.
    const byPair = new Map();
    for (const c of out) {
        const key = `${c.skill.id}|${c.milestone.id || milestones.indexOf(c.milestone)}`;
        if (!byPair.has(key) || byPair.get(key).cov < c.cov) byPair.set(key, c);
    }
    const byMile = new Map();
    for (const c of byPair.values()) {
        const k = c.milestone.id || String(milestones.indexOf(c.milestone));
        if (!byMile.has(k)) byMile.set(k, []);
        byMile.get(k).push(c);
    }
    const capped = [];
    for (const list of byMile.values()) {
        list.sort((a, b) => b.cov - a.cov);
        capped.push(...list.slice(0, maxPerMilestone));
    }
    return capped;
}

// ── Capture receipts, host-neutral (2026-08-01 parity fix) ──────────────────
// The ⏳/⚠️ capture receipts used to print ONLY through the Claude Stop-hook's
// stderr — a Codex / Cursor / Cline session capturing through brain_note (MCP
// or CLI) got "1 added · 1 superseded" and never saw the nudge, so on those
// hosts the write-side half of both detection classes was silently absent.
// One formatter, consumed by opBrainNote (MCP) and brain-note (CLI), so every
// host hears what the hook hears; the hook keeps its own prefix style.
export function formatCaptureReceipts(stats, { maxEach = 3 } = {}) {
    const s = stats || {};
    const lines = [];
    const reAdopted = Math.max(0, Number(s.reAdopted) || 0);
    if (reAdopted) {
        lines.push(`↪ re-adoption recorded: ${reAdopted} returning decision${reAdopted === 1 ? '' : 's'} now ${reAdopted === 1 ? 'carries' : 'carry'} a dated read-alone receipt and provenance edge to the earlier stance.`);
    }
    for (const f of (Array.isArray(s.fulfillCandidates) ? s.fulfillCandidates : []).slice(0, maxEach)) {
        const rest = f.uncovered && f.uncovered.length ? ` · does NOT cover: ${f.uncovered.map(u => `"${String(u).slice(0, 50)}"`).join(', ')}` : '';
        const act = f.marker
            ? `— if truly done, emit: ${f.marker}`
            : '— PARTIAL/short: the card stays open (verify by hand; dismiss via brain_connect relationship:"not_fulfilled")';
        lines.push(`⏳ likely fulfilled (${f.cov}): "${String(f.item).slice(0, 70)}"${rest} ${act}`);
    }
    for (const f of (Array.isArray(s.skillStale) ? s.skillStale : []).slice(0, maxEach)) {
        lines.push(`⚠️ rule may be obsolete (${f.cov}): skill "${String(f.skill).slice(0, 70)}" asserts "${String(f.clause || '').slice(0, 60)}" — this ship appears to remove it. If so, amend: ${f.marker} (retire by naming it in closes:, or dismiss via brain_connect relationship:"not_fulfilled")`);
    }
    // A `closes:` target that matched too many live cards ARCHIVED NOTHING. It
    // used to archive matches[0] in iteration order with cov 1.00 and no
    // warning, which is silent loss; the refusal has to be visible instead.
    for (const f of (Array.isArray(s.closeRefused) ? s.closeRefused : []).slice(0, maxEach)) {
        lines.push(`⛔ closes: "${f.target}" matched ${f.total} live cards — too generic to trust, so NOTHING was archived and your note was kept as an ordinary card. Name a longer target, or close the exact card with brain_reconcile mode:"claims" confirm:[{ id, milestoneId }]. Top candidates: ${f.candidates.map(c => `(id ${c.id}) "${c.title}"${c.area ? ` [${c.area}]` : ''} cov ${c.cov}`).join(' · ')}`);
    }
    // Every card a closes: archived, by name — "N closed" alone gave the
    // author no way to notice a close that grabbed the wrong card.
    const closedCards = Array.isArray(s.closedCards) ? s.closedCards : [];
    for (const f of closedCards.slice(0, maxEach)) {
        lines.push(`✅ closes: "${f.target}" archived (id ${f.id}) "${f.title}"${f.area ? ` [${f.area}]` : ''}. If that is the wrong card, restore it from Archive.`);
    }
    // …and never a silent remainder: one close can archive up to four cards
    // (review 2026-09-18: 4 closed, 3 named). The rest are named by id.
    if (maxEach > 0 && closedCards.length > maxEach) {
        const rest = closedCards.slice(maxEach);
        lines.push(`✅ …and ${rest.length} more card${rest.length === 1 ? '' : 's'} archived by closes: ${rest.map(f => `(id ${f.id}) "${String(f.title).slice(0, 50)}"`).join(' · ')}. Restore any wrong one from Archive.`);
    }
    // A ~ too thin to stand in for the card it matched (1.86.1 update floor)
    // was APPENDED to that card instead of replacing it — say so, and name the
    // card, so the author knows the old claim still heads it.
    for (const f of (Array.isArray(s.updateAmended) ? s.updateAmended : []).slice(0, maxEach)) {
        const dropped = f.evidenceDropped ? ` The card already had 16 evidence refs, so its ${f.evidenceDropped} oldest were dropped to keep yours.` : '';
        lines.push(`✎ ~ appended, not replaced: "${f.text}" has ${f.words} content word${f.words === 1 ? '' : 's'}, too few to replace (id ${f.id}) "${f.target}" (${f.targetWords}), so it was added to that card as a dated "(~ amended …)" line and the card's text was kept.${dropped} If it corrects the whole claim, send a ~ that restates the full corrected claim.`);
    }
    // A 1.86.0 stub restored to the full marker text, in place (stub repair).
    for (const f of (Array.isArray(s.stubRepairs) ? s.stubRepairs : []).slice(0, maxEach)) {
        lines.push(`🔧 repaired a note 1.86.0 cut short: (id ${f.id}) "${f.from}" now reads "${f.to}". If that card was a different note, restore its text and re-emit this marker.`);
    }
    // …and one that was NOT re-added: the stub it would repair is not live any
    // more. Never silent — the author is the one who can tell whether the note
    // is already in the brain in another form.
    for (const f of (Array.isArray(s.stubRepairMissing) ? s.stubRepairMissing : []).slice(0, maxEach)) {
        lines.push(`↩ not re-added: a marker an older hook already captured as "${f.stub}"${f.area ? ` [${f.area}]` : ''} names no live card of that text any more (archived, superseded or edited since). If the note is not in the brain, re-emit it.`);
    }
    // A marker the engine could not apply (contained, so the rest landed).
    for (const f of (Array.isArray(s.captureErrors) ? s.captureErrors : []).slice(0, maxEach)) {
        const what = f.kind === 'update' ? '~ update' : f.kind === 'repair' ? 'stub repair' : 'open-question merge';
        const after = f.kind === 'question-merge' ? 'The question landed as its own card, and the rest of the capture landed too.'
            : 'The rest of the capture landed; re-emit this one if it matters.';
        lines.push(`⚠️ ${what} failed${f.text ? `: "${f.text}"` : ''}${f.area ? ` [${f.area}]` : ''} (${f.error}). ${after}`);
    }
    // A closes: target that names no live card closed nothing; the phrase went
    // back into the note's text rather than vanishing.
    for (const f of (Array.isArray(s.closesKept) ? s.closesKept : []).slice(0, maxEach)) {
        if (f.alreadyClosed) {
            lines.push(`↩ closes: "${f.target}" names a card that is already closed ((id ${f.alreadyClosed.id}) "${f.alreadyClosed.title}"), so nothing more was closed and the phrase stays in your note's text.`);
            continue;
        }
        lines.push(`↩ closes: "${f.target}" ${f.strict ? 'names no live card by its title' : 'matched no live card'}, so nothing was closed and the phrase stays in your note's text. To close a card, end the sentence first and name its exact title or [[wikilink]].`);
    }
    return lines;
}

// One serve-time overlay for selected standing rules. Only limitation-bearing
// skills pay for the brain-wide scan; thresholds match the existing recall/brief
// path. This changes delivery, never ranking, capture, retirement, or stored data.
export function skillObsolescenceFor(struct, cards, { milestones = null, pairSim = null } = {}) {
    const skills = (cards || []).filter(c => isSkillCard(c) && !/^archive$/i.test(c.area || '') && !/↩|⤵/.test(c.text || ''));
    const out = obsolescenceOverlaysFor(struct, skills);
    const fresh = skills.filter(c => !out.has(c.id))
        .map(c => ({ c, claims: extractLimitationClaims(c.text) })).filter(x => x.claims.length);
    if (!fresh.length) return out;
    const oldest = Math.min(...fresh.map(x => x.c.createdAt || 0));
    // A milestone may ALSO teach a protected rule (the real repaired-eval
    // card does). Keep its skill status; only recognize its headline shipment
    // as evidence here. Quoted milestone glyphs inside advice cannot qualify.
    const recordsMilestone = m => isMilestoneCard(m) || (isSkillCard(m)
        && MILE_GLYPH.test(String(m.text || '').split('\n', 1)[0])
        && !OPEN_GLYPH.test(String(m.text || '').split('\n', 1)[0]));
    const miles = (milestones || struct.cards).filter(m => recordsMilestone(m)
        && !/^archive$/i.test(m.area || '') && !/↩|⤵/.test(m.text || '') && (m.createdAt || 0) > oldest);
    if (!miles.length) return out;
    const settled = new Set();
    for (const cn of struct.connections || []) {
        if (cn.label === 'may obsolete' || DISMISSAL_RELS.has(cn.relationship)) {
            settled.add(cn.fromId + '|' + cn.toId);
            if (DISMISSAL_RELS.has(cn.relationship)) settled.add(cn.toId + '|' + cn.fromId);
        }
    }
    const mPre = miles.map(m => ({ m, idx: stemIndex(tokenSet(m.text)) }));
    let df = null;
    const dfMap = () => (df ??= buildStemDf(struct));
    for (const { c, claims } of fresh) {
        let best = null, bestScore = 0, bestClause = null;
        const claimIndices = claims.map(cl => ({ cl, idx: stemIndex(cl.tokens) }));
        for (const { m, idx: mIdx } of mPre) {
            if (m.id === c.id || (m.createdAt || 0) <= (c.createdAt || 0) || settled.has(c.id + '|' + m.id)) continue;
            const sim = typeof pairSim === 'function' ? pairSim(c.id, m.id) : null;
            for (const { cl, idx: clIdx } of claimIndices) {
                const cov = coverageOf(new Set(clIdx.keys()), new Set(mIdx.keys()));
                const anchors = sharedAnchors(clIdx, mIdx, dfMap(), { exclude: structuralStems(c.area, m.area) });
                const lex = { cov, anchors, size: clIdx.size };
                const accept = (sim != null && sim >= 0.55 && lex.size >= SERVE_MIN_STEMS && (anchors.length >= 1 || cov >= 0.2))
                    || serveTimeAccepts(lex, (c.area || '') === (m.area || ''));
                if (!accept) continue;
                const score = (sim ?? 0) + cov + anchors.length * 0.2;
                if (score > bestScore) { bestScore = score; best = m; bestClause = cl.clause; }
            }
        }
        if (best) out.set(c.id, { by: String(best.text || '').replace(/\s+/g, ' ').trim().slice(0, 100), byId: best.id, clause: bestClause, unconfirmed: true });
    }
    return out;
}

// Confirmed graph edges outrank candidate obsolescence, across context tiers.
export function currentGuidanceFor(struct, cards) {
    const out = new Map();
    const corrections = correctionOverlaysFor(struct, cards);
    for (const [id, correction] of corrections) out.set(id, { correction });
    const hints = skillObsolescenceFor(struct, (cards || []).filter(c => !out.has(c.id)));
    for (const [id, obsolescence] of hints) out.set(id, { obsolescence });
    return out;
}

// Prefix before old text: clipping must never leave an unqualified stale rule.
export function currentGuidancePrefix(guidance, { excerptChars = 100 } = {}) {
    if (!guidance) return '';
    const clip = value => {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        let excerpt = text.slice(0, excerptChars);
        if (/[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
        return excerpt + (text.length > excerpt.length ? '…' : '');
    };
    if (guidance.correction) {
        const by = guidance.correction.by;
        return 'CURRENT CORRECTION [' + by.id + ']: ' + clip(by.text) + ' — superseded guidance: ';
    }
    if (guidance.obsolescence) {
        const by = guidance.obsolescence;
        return '⚠️ RULE MAY BE OBSOLETE (candidate; verify before applying; newer milestone [' + by.byId + ']: “' + clip(by.by) + '”) — original rule: ';
    }
    return '';
}

// Persisted-edge overlay reader for 'may obsolete' hints — the 🛠️ twin of
// fulfillmentOverlaysFor, same rules: dismissals win, a since-archived
// milestone no longer vouches, machine-written hints stay hedged forever.
export function obsolescenceOverlaysFor(struct, cards) {
    const map = new Map();
    if (!struct || !Array.isArray(struct.connections)) return map;
    const byId = new Map(struct.cards.map(c => [c.id, c]));
    const want = new Set((cards || []).map(c => c.id));
    const dismissed = new Set();
    for (const cn of struct.connections) {
        if (DISMISSAL_RELS.has(cn.relationship)) { dismissed.add(`${cn.fromId}|${cn.toId}`); dismissed.add(`${cn.toId}|${cn.fromId}`); }
    }
    for (const cn of struct.connections) {
        if (cn.label !== 'may obsolete' || !want.has(cn.fromId)) continue;
        if (dismissed.has(`${cn.fromId}|${cn.toId}`)) continue;
        const m = byId.get(cn.toId);
        if (!m || /^archive$/i.test(m.area || '') || /↩|⤵/.test(m.text || '')) continue;
        const head = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
        if (!map.has(cn.fromId)) map.set(cn.fromId, { by: head, byId: m.id, unconfirmed: cn.hintVia !== 'human' });
    }
    return map;
}

// Corpse-rate (T10): the release-gated staleness metric. Fixtures are mined
// from the brain's OWN supersede/close edges: for each archived card with a
// live successor, build the ambiguous shared-subject question both could
// answer and check who ranks higher. corpse-rate = fraction of pairs where the
// corpse outranks its successor — the exact 2026-07-23 failure, measurable.
export function corpseRate(struct, { k = 5, maxPairs = 40 } = {}) {
    if (!struct || !Array.isArray(struct.cards)) return { rate: 0, pairs: 0, served: [] };
    const byId = new Map(struct.cards.map(c => [c.id, c]));
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const pairs = [];
    for (const cn of struct.connections || []) {
        if (cn.label !== 'superseded by' && cn.label !== 'closed by') continue;
        const corpse = byId.get(cn.fromId), successor = byId.get(cn.toId);
        if (!corpse || !successor || !isArchived(corpse) || isArchived(successor)) continue;
        const succTok = tokenSet(successor.text);
        const shared = [...tokenSet(corpse.text)].filter(t => succTok.has(t)).slice(0, 6);
        if (shared.length < 3) continue;
        pairs.push({ corpse, successor, q: `what is the state of ${shared.join(' ')}?` });
        if (pairs.length >= maxPairs) break;
    }
    const served = [];
    for (const p of pairs) {
        const { hits } = rankForQuestion(struct, p.q, { k });
        const ci = hits.findIndex(h => h.card.id === p.corpse.id);
        const si = hits.findIndex(h => h.card.id === p.successor.id);
        if (ci !== -1 && (si === -1 || ci < si)) served.push({ q: p.q, corpse: String(p.corpse.text || '').slice(0, 80) });
    }
    return { rate: pairs.length ? Math.round((served.length / pairs.length) * 100) / 100 : 0, pairs: pairs.length, served };
}

// ── Stale-open reconcile ("marked open, but a milestone says it's done") ─────
// The READ-side twin of the closes: write path. An open ❓/🎯 card lingers as
// "still to do" forever unless someone emits a ✓/closes: for it — so a goal that
// quietly SHIPPED keeps surfacing in recall as a "next move". This pure pass
// finds open cards a LATER live 🏁 milestone appears to fulfil (its text COVERS
// the open card's distinctive tokens) and returns them so the surface can PROMPT
// the human to close them — never auto-archives (precision-first, suggestion-only,
// like the migration tripwire). Requires the milestone to post-date the goal so a
// pre-existing milestone can't "fulfil" a newer goal. No I/O, node-runnable.
export function findStaleOpenCards(struct, { coverAt = 0.6, max = 5, pairSim = null } = {}) {
    const empty = { gaps: [], total: 0, plans: [], plansTotal: 0 };
    if (!struct || !Array.isArray(struct.cards)) return empty;
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const live = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim() && !isArchived(c) && !/↩|✅/.test(c.text));
    const opens = live.filter(isOpenCard);
    const miles = live.filter(isMilestoneCard);
    // Plan-shaped plain cards (2026-08-23) ask the same "looks done?" question
    // for proposals that never carried a ❓ — listed separately (plans) so the
    // footer can word them as BUILT, embedding-first when the caller can pay for
    // card↔card similarity (pairSim from the warm vector cache), strict lexical
    // bars without it.
    const plansLive = live.filter(isPlanCard);
    if ((!opens.length && !plansLive.length) || !miles.length) return empty;
    // Human dismissals + existing hint edges suppress a pair here exactly as in
    // findFulfillmentCandidates — a rejected hint must never resurface in the
    // self-heal footer either (parity fix, 2026-07-29).
    const settled = new Set();
    for (const cn of struct.connections || []) {
        if (cn.label === 'likely closed by' || cn.relationship === 'not_fulfilled') settled.add(`${cn.fromId}|${cn.toId}`);
    }
    // Milestone stem sets ONCE — this sat inside the opens loop (opens × miles
    // tokenizations per SessionStart; pure waste at 1,500 cards).
    const mPre = miles.map(m => ({ m, idx: stemIndex(tokenSet(m.text)), tok: stemSet(tokenSet(m.text)) }));
    let df = null;
    const dfMap = () => (df ??= buildStemDf(struct));
    const out = [];
    for (const o of opens) {
        // claimTokens (stopword-stripped, URL-free) — parity with
        // findFulfillmentCandidates. The raw tokenSet left from/this/with in the
        // denominator, which both inflated coverage and offered junk anchors.
        const oIdx = stemIndex(claimTokens(normalizeWrappedProse(o.text)));
        const oTok = new Set(oIdx.keys());
        if (oTok.size < 3) continue;                       // too vague to match safely → leave it
        // CLAUSE-KEYED coverage (2026-07-23): the old whole-card denominator
        // meant a 6-token "remaining: X" clause inside a 40-token card could
        // NEVER reach the bar against a terse milestone — the incident card's
        // exact geometry. Score each open clause item separately and take the
        // best of (whole card, any clause item ≥2 tokens).
        // ≥3 tokens per clause item: 2-token items ('docs update') hit cov 1.0
        // against unrelated milestones (probe-confirmed false stale flags).
        const clauseToks = extractOpenClauses(o.text).flatMap(cl => cl.items.map(it => stemSet(it.tokens))).filter(t => t.size >= 3);
        let best = null, bestCov = 0, bestVia = null;
        for (const { m, idx: mIdx, tok: mTok } of mPre) {
            if ((m.createdAt || 0) <= (o.createdAt || 0)) continue; // only a milestone shipped AFTER the goal
            if (m.id && settled.has(`${o.id}|${m.id}`)) continue;
            let cov = coverageOf(oTok, mTok);              // how much of the goal the milestone covers
            for (const ct of clauseToks) cov = Math.max(cov, coverageOf(ct, mTok));
            if (cov >= coverAt) {
                if (cov > bestCov || bestVia === 'anchor') { bestCov = cov; best = m; bestVia = 'coverage'; }
                continue;
            }
            // Anchor OR-path — the verbose-❓/terse-🏁 geometry (see
            // findFulfillmentCandidates). Coverage wins over anchors when both fire.
            if (bestVia !== 'coverage') {
                const anchors = sharedAnchors(oIdx, mIdx, dfMap(), { exclude: structuralStems(o.area, m.area) });
                if (anchorsSufficient(anchors, (o.area || '') === (m.area || ''), cov) && cov > bestCov) {
                    bestCov = cov; best = m; bestVia = 'anchor';
                }
            }
        }
        if (best) out.push({ open: o, by: best, cov: Math.round(bestCov * 100) / 100, ...(bestVia === 'anchor' ? { via: 'anchor' } : {}) });
    }
    out.sort((a, b) => b.cov - a.cov);
    const plans = [];
    if (plansLive.length) {
        try {
            const byId = new Map(live.map(c => [c.id, c]));
            const hints = planFulfillmentFor(struct, plansLive, { pairSim, scope: 'brain', milestones: miles, df });
            for (const [id, h] of hints) {
                const o = byId.get(id), by = byId.get(h.byId);
                if (o && by) plans.push({ open: o, by, cov: h.cov, sim: h.sim, via: h.via, kind: 'plan' });
            }
            // Identical-text twins (merge residue) collapse to ONE row — the
            // original's id when both exist — so a brain awaiting its Arrange
            // heal does not list the same plan twice.
            const byText = new Map();
            for (const p of plans) {
                const k = String(p.open.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
                const prev = byText.get(k);
                if (!prev || (isAgconfTwinId(prev.open.id) && !isAgconfTwinId(p.open.id))) byText.set(k, p);
            }
            plans.length = 0; plans.push(...byText.values());
            plans.sort((a, b) => ((b.sim ?? 0) + b.cov) - ((a.sim ?? 0) + a.cov));
        } catch { /* best-effort — the open-card report stands on its own */ }
    }
    return { gaps: out.slice(0, max), total: out.length, plans: plans.slice(0, max), plansTotal: plans.length };
}
export function parseDeadline(text) {
    const m = DEADLINE_RE.exec(String(text || ''));
    if (!m) return null;
    const ts = Date.parse(m[1] + 'T23:59:59Z');   // due at the END of the named day (UTC)
    return Number.isFinite(ts) ? { date: m[1], ts } : null;
}
// Live open (❓/🎯) cards whose parsed deadline has passed, newest-overdue-last so
// the most-overdue lead. Injectable `now` for hermetic tests. Skips already
// resolved/superseded cards (they carry ✅/↩︎) and skills (standing reference).
export function findOverdueOpenCards(struct, { now = Date.now() } = {}) {
    const empty = { overdue: [], total: 0, byId: new Map() };
    if (!struct || !Array.isArray(struct.cards)) return empty;
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const dayMs = (iso) => Date.parse(iso + 'T00:00:00Z');
    const nowDay = dayMs(new Date(now).toISOString().slice(0, 10));
    const out = [];
    for (const c of struct.cards) {
        if (c.type === 'container' || !(c.text || '').trim() || isArchived(c)) continue;
        if (/↩|✅/.test(c.text)) continue;                       // already superseded/resolved
        if (!isOpenCard(c)) continue;                            // open questions & goals only
        const d = parseDeadline(c.text);
        // Overdue gate is LENIENT (end of the named day, d.ts) — a card isn't overdue
        // at 00:01 on its deadline day. The DISPLAY count is a whole-calendar-day
        // difference, so "before 2026-07-03" seen on 2026-07-04 reads "passed 1d ago".
        if (d && d.ts < now) out.push({ card: c, date: d.date, daysOverdue: Math.max(0, Math.round((nowDay - dayMs(d.date)) / 86_400_000)) });
    }
    out.sort((a, b) => b.daysOverdue - a.daysOverdue);
    return { overdue: out, total: out.length, byId: new Map(out.map(o => [o.card.id, o])) };
}
export function openStatusSummary(struct, { now = Date.now(), untouchedDays = STATUS_UNTOUCHED_DAYS, pairSim = null, areas = null } = {}) {
    const empty = {
        open: 0, openIds: [], overdue: 0, overdueById: new Map(), likelyDone: 0, likelyDoneById: new Map(),
        untouched: 0, untouchedIds: [], perArea: [], plans: [], plansTotal: 0, untouchedDays, computedAt: now,
    };
    if (!struct || !Array.isArray(struct.cards)) return empty;
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const scope = resolveAreaScope(struct, areas);
    const scoped = !!(scope && scope.keep.size);
    const live = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim() && !isArchived(c));
    const opens = live.filter(c => isUnresolvedOpenCard(c) && (!scoped || scope.keep.has(normTitleKey(flat(c.area)))));
    const openIds = opens.map(c => c.id);
    const openSet = new Set(openIds);
    const head = (t) => flat(t).slice(0, 100);
    // Overdue ∩ open (findOverdueOpenCards skips ↩|✅ but not ⤵ — intersect).
    const overdueById = new Map();
    try {
        for (const [id, o] of findOverdueOpenCards(struct, { now }).byId) {
            if (openSet.has(id)) overdueById.set(id, { date: o.date, daysOverdue: o.daysOverdue });
        }
    } catch { /* deadline parsing is best-effort */ }
    // Likely done: persisted hint edges first (they carry the human/machine
    // provenance), then the fresh detector for pairs no capture ever linked.
    const likelyDoneById = new Map();
    try {
        for (const [id, f] of fulfillmentOverlaysFor(struct, opens)) {
            if (!openSet.has(id)) continue;
            likelyDoneById.set(id, { byId: f.byId ?? null, by: f.by || '', via: 'edge', cov: null, unconfirmed: f.unconfirmed !== false });
        }
    } catch { /* edge overlay is best-effort */ }
    let stale = null;
    try { stale = findStaleOpenCards(struct, { max: Infinity, pairSim }); } catch { stale = null; }
    for (const g of (stale && stale.gaps) || []) {
        const id = g.open && g.open.id;
        if (!openSet.has(id) || likelyDoneById.has(id)) continue;
        likelyDoneById.set(id, {
            byId: (g.by && g.by.id) ?? null, by: head(g.by && g.by.text),
            via: g.via === 'anchor' ? 'anchor' : 'coverage',
            cov: Number.isFinite(g.cov) ? g.cov : null, unconfirmed: true,
        });
    }
    // Plan-shaped plain cards ride along so the SessionStart footer needs no
    // second detector run; they are NOT opens and never touch the counts.
    const plans = ((stale && stale.plans) || []).map(p => ({
        openId: p.open && p.open.id, byId: (p.by && p.by.id) ?? null, by: head(p.by && p.by.text),
        cov: Number.isFinite(p.cov) ? p.cov : null, sim: Number.isFinite(p.sim) ? p.sim : null, via: p.via || null,
    })).filter(p => p.openId);
    const ageMs = untouchedDays * 86_400_000;
    const untouchedIds = opens
        .filter(c => (c.createdAt || 0) > 0 && now - c.createdAt > ageMs && !likelyDoneById.has(c.id) && !overdueById.has(c.id))
        .map(c => c.id);
    const untouchedSet = new Set(untouchedIds);
    const lastMile = new Map();
    for (const c of live) {
        if (!isMilestoneCard(c)) continue;
        const a = flat(c.area);
        if (a && (c.createdAt || 0) > (lastMile.get(a) || 0)) lastMile.set(a, c.createdAt);
    }
    const byArea = new Map();
    for (const c of opens) {
        const a = flat(c.area) || 'Notes';
        let r = byArea.get(a);
        if (!r) byArea.set(a, r = { area: a, open: 0, likelyDone: 0, overdue: 0, untouched: 0, lastMilestoneAt: lastMile.get(a) || null });
        r.open++;
        if (likelyDoneById.has(c.id)) r.likelyDone++;
        if (overdueById.has(c.id)) r.overdue++;
        if (untouchedSet.has(c.id)) r.untouched++;
    }
    const perArea = [...byArea.values()].sort((a, b) => b.open - a.open || a.area.localeCompare(b.area));
    return {
        open: openIds.length, openIds, overdue: overdueById.size, overdueById,
        likelyDone: likelyDoneById.size, likelyDoneById, untouched: untouchedIds.length, untouchedIds,
        perArea, plans, plansTotal: (stale && stale.plansTotal) || 0, untouchedDays, computedAt: now,
    };
}
// Narrow a summary to the open cards a renderer is actually about to list
// (an area-scoped digest, the brief's non-focus tier). Header numbers and
// per-item flags then come from the SAME maps by construction, so the header
// can never claim more than the bullets show. `cards` are struct cards.
export function narrowOpenStatusSummary(sum, cards) {
    if (!sum) return sum;
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
    const ids = list.map(c => c.id);
    const keep = new Set(ids);
    const overdueById = new Map([...(sum.overdueById || [])].filter(([id]) => keep.has(id)));
    const likelyDoneById = new Map([...(sum.likelyDoneById || [])].filter(([id]) => keep.has(id)));
    const untouchedIds = (sum.untouchedIds || []).filter(id => keep.has(id));
    const untouchedSet = new Set(untouchedIds);
    const lastMile = new Map((sum.perArea || []).map(r => [r.area, r.lastMilestoneAt || null]));
    const byArea = new Map();
    for (const c of list) {
        const a = flat(c.area) || 'Notes';
        let r = byArea.get(a);
        if (!r) byArea.set(a, r = { area: a, open: 0, likelyDone: 0, overdue: 0, untouched: 0, lastMilestoneAt: lastMile.get(a) || null });
        r.open++;
        if (likelyDoneById.has(c.id)) r.likelyDone++;
        if (overdueById.has(c.id)) r.overdue++;
        if (untouchedSet.has(c.id)) r.untouched++;
    }
    return {
        ...sum, open: ids.length, openIds: ids, overdue: overdueById.size, overdueById,
        likelyDone: likelyDoneById.size, likelyDoneById, untouched: untouchedIds.length, untouchedIds,
        perArea: [...byArea.values()].sort((a, b) => b.open - a.open || a.area.localeCompare(b.area)),
    };
}
// The header grammar, applied everywhere an open count is printed. Parts are
// omitted when zero so a tidy brain still reads "## Open (3)".
//   status: `## Open (67) · 34 look already done · 1 ⏰ overdue · 26 created >45 d ago`
//   brief:  `## Open questions & goals (67 · 34 look already done · 1 ⏰ overdue · 26 created >45 d ago)`
export function openStatusHeaderParts(sum) {
    if (!sum) return [];
    const days = Number.isFinite(sum.untouchedDays) ? sum.untouchedDays : STATUS_UNTOUCHED_DAYS;
    const parts = [];
    if (sum.likelyDone) parts.push(`${sum.likelyDone} look already done`);
    if (sum.overdue) parts.push(`${sum.overdue} ⏰ overdue`);
    if (sum.untouched) parts.push(`${sum.untouched} created >${days} d ago`);
    return parts;
}
export function openStatusHeader(sum, style = 'status') {
    const n = sum ? sum.open : 0;
    const parts = openStatusHeaderParts(sum);
    if (style === 'brief') return `## Open questions & goals (${[String(n), ...parts].join(' · ')})`;
    return `## Open (${n})${parts.map(p => ` · ${p}`).join('')}`;
}
// Per-area table — brain_ask and brain_insights only. The hook digest never
// prints it: its area rows already carry "N open (K look done)", and a second
// table costs ~1,100 budget-exempt chars on a 5,842-char injection.
export function perAreaTableToMarkdown(sum, { cap = 12, areas = null } = {}) {
    if (!sum || !Array.isArray(sum.perArea) || !sum.perArea.length) return '';
    const days = Number.isFinite(sum.untouchedDays) ? sum.untouchedDays : STATUS_UNTOUCHED_DAYS;
    const day = (ts) => ts ? new Date(ts).toISOString().slice(0, 10) : '';
    const wanted = Array.isArray(areas) && areas.length ? new Set(areas.map(a => normTitleKey(a)).filter(Boolean)) : null;
    const rows = sum.perArea.filter(r => r.open > 0 && (!wanted || wanted.has(normTitleKey(r.area))));
    if (!rows.length) return '';
    const out = [`## By area (${rows.length})`];
    for (const r of rows.slice(0, cap)) {
        out.push(`- ${r.area} — ${r.open} open`
            + (r.likelyDone ? ` · ${r.likelyDone} look done` : '')
            + (r.overdue ? ` · ${r.overdue} ⏰ overdue` : '')
            + (r.untouched ? ` · ${r.untouched} created >${days} d ago` : '')
            + (r.lastMilestoneAt ? ` · last 🏁 ${day(r.lastMilestoneAt)}` : ''));
    }
    if (rows.length > cap) out.push(`- …and ${rows.length - cap} more area(s) — brain_ask for the whole brain`);
    return out.join('\n') + '\n';
}
// Disk-cache codec. Maps → arrays; a record that is not the shape we wrote
// (missing openIds / maps) deserializes to null — the reader treats that as a
// MISS and rewrites, never throws.
export function serializeOpenStatusSummary(sum) {
    if (!sum) return null;
    return { ...sum, overdueById: [...(sum.overdueById || [])], likelyDoneById: [...(sum.likelyDoneById || [])] };
}
export function deserializeOpenStatusSummary(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!Number.isFinite(raw.open) || !Array.isArray(raw.openIds)) return null;
    if (!Array.isArray(raw.overdueById) || !Array.isArray(raw.likelyDoneById)) return null;
    if (!Array.isArray(raw.untouchedIds) || !Array.isArray(raw.perArea)) return null;
    return {
        ...raw,
        overdueById: new Map(raw.overdueById.filter(e => Array.isArray(e) && e.length === 2)),
        likelyDoneById: new Map(raw.likelyDoneById.filter(e => Array.isArray(e) && e.length === 2)),
        plans: Array.isArray(raw.plans) ? raw.plans : [],
        plansTotal: Number.isFinite(raw.plansTotal) ? raw.plansTotal : 0,
        untouchedDays: Number.isFinite(raw.untouchedDays) ? raw.untouchedDays : STATUS_UNTOUCHED_DAYS,
    };
}
// Cache file beside the hook's struct cache: same key formula
// (sha1-16 of the separator/drive-normalized brain path) so the Claude lane,
// the Codex lane and any MCP call on one brain share ONE record, and the
// hook's existing `.brief-cache-*.json` pruning covers it.
export function statusSummaryCachePathFor(brainPath, home = os.homedir()) {
    const norm = String(brainPath).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());
    const key = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
    return path.join(home, '.claude', 'project-brain', `.brief-cache-${key}.status.json`);
}
// Cached summary for one brain, keyed on BOTH mtimeMs AND size: the desktop's
// append-only incremental saves can change bytes between two writes with a
// coarse mtime. Written tmp + rename so two parallel sessions on one brain
// never interleave a partial file; a JSON parse failure or shape mismatch is a
// MISS (recomputed and rewritten), never a throw. On a hit the cheap
// now-dependent fields (overdue, created >N d) are refreshed against the
// struct so a brain nobody edited for a week still reports today's ages —
// only the expensive detector result is what the cache actually saves.
// KLYPIX_STATUS_CACHE_TRACE=<file> appends 'hit'/'miss' lines (tests only).
export function cachedOpenStatusSummary(struct, { brainPath = null, cacheFile = null, now = Date.now(), pairSim = null, write = true } = {}) {
    const file = cacheFile || (brainPath ? statusSummaryCachePathFor(brainPath) : null);
    let st = null;
    try { const s = fs.statSync(brainPath); st = { mtimeMs: s.mtimeMs, size: s.size }; } catch { st = null; }
    const trace = (what) => {
        const t = process.env.KLYPIX_STATUS_CACHE_TRACE;
        if (!t) return;
        try { fs.appendFileSync(t, what + '\n'); } catch { /* tests only */ }
    };
    if (file && st) {
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (raw && raw.mtimeMs === st.mtimeMs && raw.size === st.size) {
                const cached = deserializeOpenStatusSummary(raw.summary);
                if (cached) { trace('hit'); return { summary: refreshOpenStatusSummary(cached, struct, { now }), cached: true, file }; }
            }
        } catch { /* miss */ }
    }
    trace('miss');
    const summary = openStatusSummary(struct, { now, pairSim });
    if (file && st && write) {
        const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify({ mtimeMs: st.mtimeMs, size: st.size, summary: serializeOpenStatusSummary(summary) }));
            fs.renameSync(tmp, file);
        } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* */ } }
    }
    return { summary, cached: false, file };
}
// Re-derive the now-dependent halves of a cached summary from the struct.
// likelyDoneById (the detector output) is kept; overdue / untouched / perArea
// are O(opens) and recomputed so the cache never serves yesterday's ages.
export function refreshOpenStatusSummary(sum, struct, { now = Date.now() } = {}) {
    if (!sum || !struct || !Array.isArray(struct.cards)) return sum;
    try {
        const byId = new Map(struct.cards.map(c => [c.id, c]));
        const opens = (sum.openIds || []).map(id => byId.get(id)).filter(Boolean);
        const keep = new Set(opens.map(c => c.id));
        const overdueById = new Map();
        for (const [id, o] of findOverdueOpenCards(struct, { now }).byId) {
            if (keep.has(id)) overdueById.set(id, { date: o.date, daysOverdue: o.daysOverdue });
        }
        const days = Number.isFinite(sum.untouchedDays) ? sum.untouchedDays : STATUS_UNTOUCHED_DAYS;
        const ageMs = days * 86_400_000;
        const likely = sum.likelyDoneById || new Map();
        const untouchedIds = opens
            .filter(c => (c.createdAt || 0) > 0 && now - c.createdAt > ageMs && !likely.has(c.id) && !overdueById.has(c.id))
            .map(c => c.id);
        const base = { ...sum, overdue: overdueById.size, overdueById, untouched: untouchedIds.length, untouchedIds, computedAt: now };
        return narrowOpenStatusSummary(base, opens);
    } catch { return sum; }
}
export function releaseFulfilledOpens(struct, commits, { ref = '', containedFn = null, maxCandidates = RELEASE_RECONCILE_MAX, summary = null, now = Date.now() } = {}) {
    const empty = { candidates: [], truncated: false };
    if (!struct || !Array.isArray(struct.cards)) return empty;
    const list = Array.isArray(commits) ? commits.filter(c => c && c.sha && c.subject) : [];
    const contained = typeof containedFn === 'function' ? containedFn : () => false;
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const live = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim() && !isArchived(c));
    const opens = live.filter(isUnresolvedOpenCard);
    if (!opens.length) return empty;
    const openById = new Map(opens.map(c => [c.id, c]));
    const byId = new Map(live.map(c => [c.id, c]));
    const bySha = new Map(list.map(c => [String(c.sha).toLowerCase(), c]));
    // A short sha on a card resolves against the range's full shas by prefix —
    // #commit- tags are 7 hex, the range carries 40.
    const resolveSha = (short) => {
        const s = String(short || '').toLowerCase();
        if (bySha.has(s)) return bySha.get(s);
        for (const [full, c] of bySha) if (full.startsWith(s)) return c;
        return null;
    };
    const shasOn = (card) => {
        const out = [];
        for (const m of String(card.text || '').matchAll(COMMIT_TAG_RE)) out.push({ sha: m[1].toLowerCase(), via: 'commit-tag' });
        for (const t of (card.tags || [])) {
            const m = /^#?commit-([0-9a-f]{7,40})$/i.exec(String(t));
            if (m) out.push({ sha: m[1].toLowerCase(), via: 'commit-tag' });
        }
        for (const e of (card.evidence || [])) {
            if (e && e.kind === 'commit' && typeof e.ref === 'string' && /^[0-9a-f]{7,40}$/i.test(e.ref.trim())) {
                out.push({ sha: e.ref.trim().toLowerCase(), via: 'commit-evidence' });
            }
        }
        return out;
    };
    const cands = new Map();                                     // openId → best candidate
    const rank = { 'commit-tag': 5, 'commit-evidence': 4, edge: 3, coverage: 2, anchor: 1 };
    const offer = (c) => {
        const prev = cands.get(c.openId);
        if (!prev || rank[c.via] > rank[prev.via] || (rank[c.via] === rank[prev.via] && (c.cov || 0) > (prev.cov || 0))) cands.set(c.openId, c);
    };
    const head = (card) => flat(card.text).replace(/^[^:\n]{1,40}:\s*/, '').slice(0, 110);

    // (1) the card's own commit receipt
    for (const o of opens) {
        for (const { sha, via } of shasOn(o)) {
            if (!contained(sha)) continue;
            const c = resolveSha(sha);
            offer({ openId: o.id, area: o.area || null, headline: head(o), via, cov: null, by: { sha, subject: c ? flat(c.subject).slice(0, 120) : '', cardId: null }, confirmable: true, unconfirmed: true });
        }
    }

    // (2) coverage / anchor against the commits themselves
    const pseudo = [];
    for (const c of list) {
        if (!CC_RE.test(c.subject)) continue;
        const body = String(c.body || '').trim();
        pseudo.push({
            id: `commit:${c.sha}`, text: `🏁 ${c.subject}${body ? `\n${body}` : ''}`,
            createdAt: Number.isFinite(c.ts) && c.ts > 0 ? c.ts * 1000 : now,
            __sha: c.sha, __subject: flat(c.subject).slice(0, 120), __bodyLen: body.length,
        });
    }
    if (pseudo.length) {
        try {
            for (const f of findFulfillmentCandidates(struct, pseudo, { maxPerMilestone: 2 })) {
                if (!openById.has(f.open.id)) continue;
                const m = f.milestone;
                const via = f.via === 'anchor' ? 'anchor' : 'coverage';
                const confirmable = via === 'coverage' && (f.cov || 0) >= 0.6 && (m.__bodyLen || 0) >= 12;
                offer({
                    openId: f.open.id, area: f.open.area || null, headline: head(f.open), via,
                    cov: Number.isFinite(f.cov) ? f.cov : null,
                    by: { sha: m.__sha, subject: m.__subject, cardId: null },
                    confirmable, unconfirmed: true,
                });
            }
        } catch { /* the advisory stands on the evidence it did gather */ }
    }

    // (3) an existing hint edge / current gap whose MILESTONE carries a
    //     contained commit tag — the ship is already carded, and the release
    //     is what proves the card's commit is in the build.
    try {
        const sum = summary || openStatusSummary(struct, { now });
        for (const [openId, f] of (sum.likelyDoneById || new Map())) {
            if (!openById.has(openId) || !f.byId) continue;
            const mile = byId.get(f.byId);
            if (!mile) continue;
            for (const { sha } of shasOn(mile)) {
                if (!contained(sha)) continue;
                const c = resolveSha(sha);
                offer({
                    openId, area: openById.get(openId).area || null, headline: head(openById.get(openId)), via: 'edge',
                    cov: Number.isFinite(f.cov) ? f.cov : null,
                    by: { sha, subject: c ? flat(c.subject).slice(0, 120) : flat(f.by).slice(0, 120), cardId: f.byId },
                    confirmable: true, unconfirmed: true,
                });
                break;
            }
        }
    } catch { /* summary is best-effort — sources 1 and 2 stand alone */ }

    const all = [...cands.values()].sort((a, b) => (rank[b.via] - rank[a.via]) || ((b.cov || 0) - (a.cov || 0)) || String(a.openId).localeCompare(String(b.openId)));
    return { candidates: all.slice(0, maxCandidates), truncated: all.length > maxCandidates };
}
// The one sentence a release-lease holder reads. Three honest shapes: found /
// found nothing / could not look.
export function releaseReconcileNotice({ ref, sinceRef = '', candidates = [], skipped = false } = {}) {
    if (skipped) return `KLYPIX release reconcile skipped: git history for ${ref} could not be read.`;
    // A young repo has no baseline to name (no release tag, no ship signal —
    // the FIRST release), and "since ." reads like a bug. The wording is
    // byte-identical whenever a baseline exists (RR7 locks it verbatim).
    if (!candidates.length) return `KLYPIX release reconcile: no open cards look fulfilled by commits in ${ref}${sinceRef ? ` since ${sinceRef}` : ''}.`;
    const confirmable = candidates.filter(c => c && c.confirmable).length;
    return `KLYPIX release reconcile: ${candidates.length} open card(s) look fulfilled by commits already in ${ref} (${confirmable} confirmable)`
        + ` — verify each, then confirm with brain_reconcile mode:"release" ref:"${ref}" confirm:[{ id, sha }] (or dismiss:[…]). Nothing was changed.`;
}
// ONE keying rule for the compiled-guard sidecar, shared by every consumer
// (the Claude --guard fast path, the Codex advisory lane, tests). The formula
// mirrors global-brain-hook.mjs's cache keying (sha1-16 of the normalized
// brain path) — test/guard-cards.mjs asserts the two derivations agree.
export function guardSidecarPathFor(brainPath, home = os.homedir()) {
    // On Windows the WHOLE path is case-folded, not just the drive letter —
    // hosts reach the same brain through differently-cased CWDs (e:/ vs E:/,
    // observed live in this project's own doctor output), and a case-split key
    // would give each host its own half-blind sidecar (review 2026-08-24).
    // POSIX paths keep their case: there, distinct casings ARE distinct files.
    let norm = String(brainPath).replace(/\\/g, '/');
    norm = process.platform === 'win32' ? norm.toLowerCase() : norm.replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());
    const key = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
    return path.join(home, '.claude', 'project-brain', `.guards-${key}.json`);
}
export function validateGuard(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, reason: 'guard must be an object: { when: {…}, severity?, message } — or { remove: true } to disarm' };
    }
    // Disarm sentinel (adversarial review 2026-08-24): a plain ~ amendment
    // rewrites prose but PRESERVES the machine field, so without this there was
    // no authorable way to switch a guard off short of archiving the card.
    if (value.remove === true) {
        const extra = Object.keys(value).filter((k) => k !== 'remove');
        if (extra.length) return { ok: false, reason: 'guard.remove takes no other fields — pass exactly { remove: true } to disarm, or a full guard to replace' };
        return { ok: true, guard: { remove: true } };
    }
    const when = value.when;
    if (!when || typeof when !== 'object' || Array.isArray(when)) {
        return { ok: false, reason: 'guard.when must be an object with at least one trigger (tool, command, paths, multiWorktree)' };
    }
    const out = { when: {}, severity: 'warn', message: '' };
    if (when.tool !== undefined) {
        if (typeof when.tool !== 'string' || !compileGuardRegex(when.tool)) {
            return { ok: false, reason: `guard.when.tool must be a valid regex source string (≤${GUARD_RE_MAX} chars)` };
        }
        out.when.tool = when.tool.trim();
    }
    if (when.command !== undefined) {
        if (typeof when.command !== 'string' || !compileGuardRegex(when.command)) {
            return { ok: false, reason: `guard.when.command must be a valid regex source string (≤${GUARD_RE_MAX} chars)` };
        }
        out.when.command = when.command.trim();
    }
    if (when.paths !== undefined) {
        if (!Array.isArray(when.paths) || !when.paths.length || when.paths.length > GUARD_PATHS_MAX
            || !when.paths.every((p) => typeof p === 'string' && p.trim() && p.length <= GUARD_RE_MAX)) {
            return { ok: false, reason: `guard.when.paths must be 1–${GUARD_PATHS_MAX} non-empty path-prefix strings (≤${GUARD_RE_MAX} chars each) — prefixes, not regexes` };
        }
        out.when.paths = when.paths.map((p) => p.trim().replace(/\\/g, '/'));
    }
    if (when.multiWorktree !== undefined) {
        if (when.multiWorktree !== true) return { ok: false, reason: 'guard.when.multiWorktree accepts only true (omit it otherwise)' };
        out.when.multiWorktree = true;
    }
    if (!Object.keys(out.when).length) {
        return { ok: false, reason: 'guard.when needs at least one trigger: tool, command, paths, or multiWorktree' };
    }
    if (value.severity !== undefined && value.severity !== 'warn' && value.severity !== 'block') {
        return { ok: false, reason: "guard.severity must be 'warn' or 'block' (default warn). 'block' is for irreversible actions and human-directed authoring only" };
    }
    if (value.severity === 'block') out.severity = 'block';
    const msg = String(value.message || '').trim();
    if (!msg || msg.length > GUARD_MSG_MAX) {
        return { ok: false, reason: `guard.message is required (≤${GUARD_MSG_MAX} chars) — it is what the interrupted session reads` };
    }
    out.message = msg;
    return { ok: true, guard: out };
}
// Live cards carrying a VALID guard field → the compiled list the sidecar
// stores. Invalid guards are skipped (they still exist as prose cards); a
// resolved/superseded/archived card stops guarding without any extra step.
export function compileGuards(struct) {
    if (!struct || !Array.isArray(struct.cards)) return [];
    const out = [];
    for (const c of struct.cards) {
        if (c.type === 'container' || !c.guard) continue;
        if (c.guard.remove === true) continue;              // disarmed via ~ amendment
        if (/^archive$/i.test(c.area || '')) continue;
        // Retirement test uses the ANCHORED stamp shapes, never a bare glyph
        // scan — a live guard whose prose merely mentions ✅ must keep guarding
        // (the glyph-in-prose trap this file already defends against elsewhere;
        // adversarial review 2026-08-24 caught the bare /↩|✅|⤵/ version).
        if (hasRetirementStamp(c.text)) continue;
        const v = validateGuard(c.guard);
        if (!v.ok) continue;
        out.push({ id: c.id, area: c.area || null, title: c.title || null, ...v.guard });
    }
    return out;
}
// Evaluate compiled guards against ONE tool event. Pure; every regex test is
// try/caught and inputs are sliced so a hostile pattern or a huge command can
// never hang the hook. Verdict per guard:
//   fired:false                        — a verifiable trigger said no
//   fired:true, unverified:[]          — fire at the declared severity
//   fired:true, unverified:['paths']   — verifiable triggers passed but an
//     input was unavailable. Per the 2026-08-18 field rule ("a probe that
//     fails must refuse, never exempt") this NEVER silently exempts — but a
//     deny on unverified input would false-block, so the caller degrades
//     block→warn and SAYS what could not be verified.
export function evaluateGuards(guards, { toolName = '', command = '', files = null, worktreeCount = null } = {}) {
    const results = [];
    const CMD_CAP = 16384;
    const raw = String(command || '');
    const cmd = raw.slice(0, CMD_CAP);
    const cmdTruncated = raw.length > CMD_CAP;
    const tool = String(toolName || '').slice(0, 200);
    for (const g of Array.isArray(guards) ? guards : []) {
        try {
            const unverified = [];
            let fired = true;
            // A trigger whose stored pattern fails to COMPILE at eval time
            // (hand-edited sidecar, corrupt entry) is an UNVERIFIABLE trigger,
            // never a silent drop — three review layers collapsed cannot-check
            // into checked-and-clear before this (2026-08-24).
            if (g.when.tool) {
                const re = compileGuardRegex(g.when.tool);
                if (!re) unverified.push('tool-pattern');
                else if (!re.test(tool)) fired = false;
            }
            if (fired && g.when.command) {
                const re = compileGuardRegex(g.when.command);
                if (!re) unverified.push('command-pattern');
                // A match on the truncated prefix is a real match; a NO-match on
                // a truncated command proves nothing — report it unverifiable
                // rather than letting truncation become exemption.
                else if (!re.test(cmd)) {
                    if (cmdTruncated) unverified.push('command-truncated');
                    else fired = false;
                }
            }
            if (fired && g.when.paths) {
                if (!Array.isArray(files)) unverified.push('paths');
                else if (!files.some((f) => {
                    const file = String(f || '').replace(/\\/g, '/').toLowerCase();
                    return g.when.paths.some((p) => file.startsWith(p.toLowerCase()));
                })) fired = false;
            }
            if (fired && g.when.multiWorktree) {
                if (!Number.isFinite(worktreeCount)) unverified.push('worktreeCount');
                else if (worktreeCount <= 1) fired = false;
            }
            if (fired) results.push({ guard: g, unverified });
        } catch { /* one bad guard never breaks the rest */ }
    }
    return results;
}

// Live worktree probe — bounded, call-time. The count changes independently of
// the brain, so a compiled snapshot can false-deny (worktree removed) or
// silently exempt (worktree added); callers probe AT the moment a
// multiWorktree guard is actually in play. null = could not verify.
export function probeWorktreeCount(dir) {
    try {
        const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
            cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500,
        });
        return out.split('\n').filter((l) => l.startsWith('worktree ')).length;
    } catch { return null; }
}
// ONE currency-checked reader/rebuilder for the compiled-guard sidecar, shared
// by every enforcement surface (Claude --guard, Codex advisory, brain_note's
// post-write refresh). The adversarial review's two criticals were both "the
// sidecar never learns the brain changed": a resolved guard kept denying with
// a recovery message that could not work. This closes it at the read site —
// stale (mtime mismatch) or missing ⇒ parse + recompile + ATOMIC write.
//   returns { guards, worktreeCount, mtimeMs, rebuilt } on success
//   returns { guards: null, stale: true } when the brain exists but the
//     rebuild failed — the caller must treat every guard as UNVERIFIABLE
//     (degrade block→warn), never as absent.
//   returns { guards: [] } when the brain itself is gone.
export async function ensureGuardSidecar(brainPath, { home = os.homedir(), buildIfMissing = true } = {}) {
    const sidecarPath = guardSidecarPathFor(brainPath, home);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(brainPath).mtimeMs; } catch { return { guards: [], worktreeCount: null, mtimeMs: 0, rebuilt: false }; }
    try {
        const cur = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
        if (cur && cur.mtimeMs === mtimeMs && Array.isArray(cur.guards)) {
            return { guards: cur.guards, worktreeCount: Number.isFinite(cur.worktreeCount) ? cur.worktreeCount : null, mtimeMs, rebuilt: false };
        }
    } catch { /* absent or unreadable → rebuild below */ }
    if (!buildIfMissing) return { guards: null, stale: true };
    try {
        const { struct } = await parseKlypix(fs.readFileSync(brainPath));
        const guards = compileGuards(struct);
        const worktreeCount = guards.some((g) => g.when && g.when.multiWorktree)
            ? probeWorktreeCount(path.dirname(brainPath)) : null;
        const payload = JSON.stringify({ v: 1, mtimeMs, builtAt: Date.now(), brainPath, worktreeCount, guards });
        fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
        const tmp = `${sidecarPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, payload);
        fs.renameSync(tmp, sidecarPath);
        return { guards, worktreeCount, mtimeMs, rebuilt: true };
    } catch { return { guards: null, stale: true }; }
}
export function liftLeadingMarker(marker, text) {
    const t = String(text ?? '');
    if (marker) return { marker, text: t };
    const lead = t.trimStart();
    const m = LEADING_MARKER_RE.exec(lead);
    return m ? { marker: m[1], text: lead.slice(m[0].length) } : { marker: '', text: t };
}
export function repairRawMarker(text) {
    const raw = String(text ?? '');
    const m = RAW_MARKER_CARD_RE.exec(raw);
    if (!m) return raw;
    const cpl = brainCPL();
    const lines = raw.split('\n');
    let lead = lines[0], prev = lines[0], i = 1;
    for (; i < lines.length; i++) {
        const line = lines[i], t = line.trim();
        if (!t || /^\s*(?:#[\p{L}\p{N}_-]+\s*)+$/u.test(line) || /^(?:✔|✅|↩|⤵|\(re-affirmed|\(~ amended)/u.test(t)) break;
        const firstWord = (/^\S*/.exec(t) || [''])[0];
        const midWord = prev.length === cpl && !/\s/.test(prev.trim());
        if (!(prev.length <= cpl && line.length <= cpl && (midWord || prev.length + 1 + firstWord.length > cpl))) break;
        lead = `${lead.trimEnd()}${midWord ? '' : ' '}${t}`;
        prev = line;
    }
    lead = `${m[1]}: ${RAW_MARKER_GLYPH[m[2]]}${lead.slice(m[0].length)}`;
    return wrapText([lead, ...lines.slice(i)].join('\n'), cpl);
}

export function noteToCaptureInput({ text = '', area = '', marker = '', closes = '', evidence = null, verify = null, guard = null, createdVia = 'mcp', capturedBy = null } = {}) {
    const by = capturedByField({ capturedBy });
    ({ marker, text } = liftLeadingMarker(marker, text));
    const body = String(text).trim();
    if (!body) return { cards: [], resolutions: [], updates: [] };
    const a = String(area || '').trim();
    if (marker === '✓') return { cards: [], resolutions: [{ area: a, text: body }], updates: [] };
    if (marker === '~') return { cards: [], resolutions: [], updates: [{ area: a, text: body, createdVia, ...by, ...(Array.isArray(evidence) ? { evidence } : {}), ...(typeof verify === 'string' ? { verify } : {}), ...(guard ? { guard } : {}) }] };
    const prefix = marker === '?' ? '❓ ' : marker === '!' ? '🏁 ' : marker === '+' ? '🛠️ ' : '';
    const borderColor = marker === '?' ? 'rgba(245,166,35,0.8)' : marker === '!' ? 'rgba(59,130,246,0.8)' : marker === '+' ? 'rgba(139,92,246,0.85)' : 'rgba(16,185,129,0.6)';
    const tag = a ? `\n#${a.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
    const cardText = (a ? `${a}: ${prefix}${body}` : `${prefix}${body}`) + tag;
    return { cards: [{ text: cardText, area: a, color: '#e8e8ed', borderColor, createdVia, ...by, ...(closes ? { closes } : {}), ...(evidence ? { evidence } : {}), ...(verify ? { verify } : {}), ...(guard ? { guard } : {}) }], resolutions: [], updates: [] };
}

/**
 * Build a RICH "map" .klypix: areas become titled containers, their cards
 * stack inside, connections draw across. Produces a real spatial board (used by
 * the project brain) rather than a flat grid. Spec:
 *   { title, areas: [{ title, color?, cards: [{text, heading?, color?}] }],
 *     connections: [{ from, to, relationship?, label? }] }   // from/to by card title
 */
export async function buildKlypixMap(spec) {
    if (!spec || !Array.isArray(spec.areas) || spec.areas.length === 0) {
        throw new Error('map spec needs a non-empty "areas" array');
    }
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const rand = () => Math.random().toString(36).slice(2, 10);

    const TITLE_BAR = 44, PAD = 16, CARD_GAP = 12, CARD_W = 280, FONT = 15, LINE_H = FONT * 1.4;
    const AREA_W = CARD_W + PAD * 2;
    const COL_GAP = 48, ROW_GAP = 48, START = 80;
    // Wrapped-height contract for the bordered cards this builder emits. They
    // render at width CARD_W with the app's bordered-text box model
    // (src/canvas/items/TextItem.tsx:733-734 — padding '8px 10px' + 1px border,
    // box-sizing:border-box, lineHeight 1.35, wordBreak:break-word) and the app's
    // ResizeObserver (TextItem.tsx:672-692) GROWS item.h to the rendered content
    // height on open. Estimating height from explicit '\n' count alone ignores
    // wrapping: a long single line reserves ~1 line (~40px) but renders as several
    // wrapped lines, so the app grows the card and it overlaps the next one. So
    // estimate the WRAPPED line count using the app's own text metrics
    // (src/canvas/items/types.ts sizePastedText: avgCharPx = fontSize*0.5,
    // charsPerLine = floor(usableWidth/avgCharPx)) and deliberately OVER-reserve a
    // hair (0.9 wrap-efficiency for word-boundary raggedness + a margin). The app
    // only ever SHRINKS an over-estimate, so over-reserving widens gaps but never
    // overlaps; under-reserving overlaps.
    const TEXT_PAD_H = 10, TEXT_BORDER = 1, WRAP_MARGIN = 8;
    const CONTENT_W = CARD_W - TEXT_PAD_H * 2 - TEXT_BORDER * 2;   // usable text px (258)
    const AVG_CHAR_PX = FONT * 0.5;                                // app's ~0.5em/char metric
    const CHARS_PER_LINE = Math.max(8, Math.floor((CONTENT_W / AVG_CHAR_PX) * 0.9));
    const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(spec.areas.length))));

    const positions = {};
    const order = [];
    const items = {}; // id -> json
    const titleToId = new Map(); // card title -> id (for connections)
    const firstLine = (t) => String(t ?? '').split('\n').map(s => s.trim()).find(Boolean) || '';
    let z = 0;
    const nextZKey = makeZKeyGen();

    // Shelf-pack areas into rows of `cols`; each row's height = tallest area.
    let rowTopY = START, rowMaxH = 0, colX = START, colIdx = 0;
    spec.areas.forEach((area, ai) => {
        const cards = (area.cards || []).filter(c => c && typeof c.text === 'string' && c.text.trim());
        // measure card heights — WRAPPED lines, not just explicit '\n' count.
        const measured = cards.map(c => {
            const wrappedLines = String(c.text).split('\n').reduce(
                (n, line) => n + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)), 0);
            // + 18 = 8px×2 vertical padding + 1px×2 border (box-sizing:border-box).
            return Math.max(40, Math.round(wrappedLines * LINE_H) + 18 + WRAP_MARGIN);
        });
        const innerH = measured.reduce((s, h) => s + h + CARD_GAP, 0);
        const areaH = TITLE_BAR + PAD + innerH + PAD;

        if (colIdx >= cols) { // new row
            rowTopY += rowMaxH + ROW_GAP;
            rowMaxH = 0; colIdx = 0; colX = START;
        }
        const ax = colX, ay = rowTopY;

        const ctnId = `ctn_${rand()}_${ai}`;
        items[ctnId] = {
            type: 'container', locked: false, createdAt: now, createdBy: 'agent',
            title: area.title || `Area ${ai + 1}`, collapsed: false, scopeLocked: false,
            borderColor: area.color || '#10b981',
        };
        positions[ctnId] = { x: ax, y: ay, w: AREA_W, h: areaH, zKey: nextZKey(), zIndex: z, parentId: null };
        order.push(ctnId); z++;

        let cy = ay + TITLE_BAR + PAD;
        cards.forEach((c, ci) => {
            const id = `txt_${rand()}_${ai}_${ci}`;
            const h = measured[ci];
            items[id] = {
                type: 'text', locked: false, createdAt: now, createdBy: 'agent', ...authorField(),
                // Guard trigger — additive machine field (guard cards, 2026-08-24).
                ...(c.guard && typeof c.guard === 'object' ? { guard: c.guard } : {}),
                content: String(c.text), fontSize: FONT,
                color: c.color || '#e8e8ed', border: true,
                borderColor: c.color || 'rgba(16,185,129,0.35)',
                fillColor: 'rgba(18,18,26,0.85)',
                heading: !!c.heading,
                fontWeight: c.heading ? 'bold' : 'normal', fontStyle: 'normal',
                textDecoration: 'none', textAlign: 'left', verticalAlign: 'top',
                fontFamily: 'Thmanyah Sans',
            };
            positions[id] = { x: ax + PAD, y: cy, w: CARD_W, h, zKey: nextZKey(), zIndex: z, parentId: ctnId };
            order.push(id); z++;
            const t = firstLine(c.text).toLowerCase();
            if (t && !titleToId.has(t)) titleToId.set(t, id);
            cy += h + CARD_GAP;
        });

        rowMaxH = Math.max(rowMaxH, areaH);
        colX += AREA_W + COL_GAP;
        colIdx++;
    });

    // Connections (by card title, across all areas).
    const REL = new Set(['leads_to', 'depends_on', 'relates_to', 'conflicts_with', 'supports', 'questions', 'costs', 'blocks']);
    const resolve = (ref) => {
        if (typeof ref === 'string') return titleToId.get(ref.trim().toLowerCase()) || null;
        return null;
    };
    const connections = (Array.isArray(spec.connections) ? spec.connections : []).map((c, i) => {
        const fromId = resolve(c.from), toId = resolve(c.to);
        if (!fromId || !toId || fromId === toId) return null;
        return {
            id: `con_${rand()}_${i}`, fromId, toId,
            relationship: REL.has(c.relationship) ? c.relationship : undefined,
            label: typeof c.label === 'string' ? c.label : undefined,
            arrowHead: true, width: 2, color: '#10b981', style: 'solid',
        };
    }).filter(Boolean);

    const zip = new JSZip();
    const manifest = {
        format: 'klypix', version: 4, schemaVersion: 4, createdAt: nowIso, updatedAt: nowIso,
        title: spec.title || 'Brain', stats: { itemCount: order.length, assetCount: 0, totalBytes: 0 },
        // Map builds default to spec.kind; brains pass kind:'brain' so the flag
        // survives renames (detection = manifest.kind OR brain.* filename).
        ...(spec.kind === 'brain' ? { kind: 'brain' } : {}),
        sync: { enabled: false, lastSyncRev: null, lastSyncAt: null, deviceId: `dev_${rand()}${rand()}` },
    };
    const xs = Object.values(positions);
    const minX = Math.min(...xs.map(p => p.x)), minY = Math.min(...xs.map(p => p.y));
    const canvasJson = {
        version: 4, view: { panX: 120 - minX * 0.55, panY: 120 - minY * 0.55, zoom: 0.55 },
        order, connections, lines: [], strokes: [], nextGroupNumber: spec.areas.length + 1,
        // Stamp the layout engine: appends re-flow incrementally (broadcast-time
        // overlap guarantee) and the first tidy keeps this map's anchors instead
        // of full-reshuffling it into a cluster.
        positions, settings: { background: '#0a0a0f', brainLayout: 'cluster-v1' },
    };
    zip.file('manifest.json', JSON.stringify(manifest));
    zip.file('canvas.json', JSON.stringify(canvasJson));
    for (const id of order) zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify(items[id]));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export function brainLensData(struct, opts = {}) {
    const { staleDays = 21, root = null, limit = 30, now = Date.now() } = opts;
    const cards = struct.cards.filter(c => c.type !== 'container');
    const textCards = cards.filter(c => c.type === 'text' && String(c.text || '').trim());

    // Freshness — age buckets + resolution glyphs; stale open ❓ called out.
    const freshness = { fresh7d: 0, days30: 0, days90: 0, stale: 0, archived: 0, staleQuestions: [] };
    for (const c of textCards) {
        if (lensIsArchived(c)) { freshness.archived++; continue; }
        const age = now - (c.createdAt || 0);
        const isOpenQ = /❓/.test(c.text || '') && !/✅|↩|⤵/.test(c.text || '');
        if (isOpenQ && age > staleDays * LENS_DAY)
            freshness.staleQuestions.push({ id: c.id, title: lensTitle(c), area: c.area || null, ageDays: Math.round(age / LENS_DAY) });
        if (!c.createdAt || age > 90 * LENS_DAY) freshness.stale++;
        else if (age <= 7 * LENS_DAY) freshness.fresh7d++;
        else if (age <= 30 * LENS_DAY) freshness.days30++;
        else freshness.days90++;
    }
    freshness.staleQuestions.sort((a, b) => b.ageDays - a.ageDays);

    // Provenance — who wrote the brain, by channel.
    const channels = {};
    for (const c of textCards) { const k = lensChannel(c); channels[k] = (channels[k] || 0) + 1; }

    // Activity — the last 7 days, day by day, newest additions listed.
    const days = [];
    for (let d = 6; d >= 0; d--) {
        const start = now - (d + 1) * LENS_DAY, end = now - d * LENS_DAY;
        days.push({ daysAgo: d, added: cards.filter(c => (c.createdAt || 0) > start && (c.createdAt || 0) <= end).length });
    }
    const recent = cards
        .filter(c => (c.createdAt || 0) > now - 7 * LENS_DAY)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, limit)
        .map(c => ({ id: c.id, title: lensTitle(c), area: c.area || null, hoursAgo: Math.round((now - c.createdAt) / 3_600_000) }));

    // Timeline — birth order (the Replay spine). Events stay compact: id + t.
    const events = cards
        .filter(c => Number(c.createdAt) > 0)
        .map(c => ({ id: c.id, t: c.createdAt }))
        .sort((a, b) => a.t - b.t);
    const weeks = new Map();
    for (const e of events) {
        const wk = new Date(e.t); wk.setUTCHours(0, 0, 0, 0); wk.setUTCDate(wk.getUTCDate() - wk.getUTCDay());
        const key = wk.toISOString().slice(0, 10);
        weeks.set(key, (weeks.get(key) || 0) + 1);
    }
    const timeline = {
        total: events.length,
        tMin: events[0]?.t ?? null,
        tMax: events[events.length - 1]?.t ?? null,
        weeks: [...weeks.entries()].map(([weekStart, added]) => ({ weekStart, added })),
        events,
    };

    // Orrery — focus+context neighborhood, ring-capped so it can never hairball.
    const degree = new Map();
    for (const cn of struct.connections) { degree.set(cn.fromId, (degree.get(cn.fromId) || 0) + 1); degree.set(cn.toId, (degree.get(cn.toId) || 0) + 1); }
    const byId = new Map(struct.cards.map(c => [c.id, c]));
    let rootId = null;
    if (root) {
        const want = String(root).trim().toLowerCase();
        rootId = struct.cards.find(c => c.id === root)?.id
            ?? struct.cards.find(c => lensTitle(c).toLowerCase().startsWith(want))?.id
            ?? null;
    }
    if (!rootId) { let best = 0; for (const [id, n] of degree) if (byId.has(id) && n > best) { best = n; rootId = id; } }
    let orrery = null;
    if (rootId) {
        const RING_CAP = { 1: 14, 2: 22, 3: 30 };
        const adj = new Map();
        for (const cn of struct.connections) {
            if (!byId.has(cn.fromId) || !byId.has(cn.toId)) continue;
            if (!adj.has(cn.fromId)) adj.set(cn.fromId, []);
            if (!adj.has(cn.toId)) adj.set(cn.toId, []);
            adj.get(cn.fromId).push(cn.toId);
            adj.get(cn.toId).push(cn.fromId);
        }
        const known = new Set([rootId]);
        const nodes = [];
        let frontier = [rootId], overflow = 0;
        for (const hop of [1, 2, 3]) {
            const candidates = [];
            for (const cur of frontier) for (const other of adj.get(cur) || []) {
                if (!known.has(other) && !candidates.includes(other)) candidates.push(other);
            }
            candidates.sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0) || (a < b ? -1 : 1));
            const kept = candidates.slice(0, RING_CAP[hop]);
            overflow += candidates.length - kept.length;
            for (const id of kept) {
                known.add(id);
                const c = byId.get(id);
                nodes.push({ id, hop, title: lensTitle(c), area: c.area || null, degree: degree.get(id) || 0 });
            }
            frontier = kept;
            if (!frontier.length) break;
        }
        const seen = new Set();
        const edges = [];
        for (const cn of struct.connections) {
            if (!known.has(cn.fromId) || !known.has(cn.toId)) continue;
            const k = `${cn.fromId}|${cn.toId}|${cn.relationship || ''}|${cn.label || ''}`;
            if (seen.has(k)) continue;
            seen.add(k);
            edges.push({ fromId: cn.fromId, toId: cn.toId, rel: cn.relationship || null, label: cn.label || null });
        }
        const rc = byId.get(rootId);
        orrery = { rootId, rootTitle: lensTitle(rc), rootArea: rc.area || null, nodes, edges, overflow };
    }

    // Unresolved — open-❓ triage, oldest debt first, with typed evidence.
    const unresolved = [];
    for (const c of textCards) {
        if (!/❓/.test(c.text || '') || /✅|↩|⤵/.test(c.text || '') || lensIsArchived(c)) continue;
        const evidence = [];
        for (const cn of struct.connections) {
            const other = cn.fromId === c.id ? cn.toId : cn.toId === c.id ? cn.fromId : null;
            if (!other || !byId.has(other) || evidence.length >= 4) continue;
            evidence.push({ id: other, title: lensTitle(byId.get(other)), rel: cn.relationship || null, label: cn.label || null });
        }
        unresolved.push({
            id: c.id, title: lensTitle(c), area: c.area || null,
            ageDays: c.createdAt ? Math.max(0, Math.round((now - c.createdAt) / LENS_DAY)) : 0,
            evidence,
        });
    }
    unresolved.sort((a, b) => b.ageDays - a.ageDays || (a.id < b.id ? -1 : 1));

    return {
        title: struct.title,
        counts: { cards: cards.length, textCards: textCards.length, connections: struct.connections.length },
        staleDays,
        freshness,
        provenance: { channels },
        activity: { days, recent },
        timeline,
        orrery,
        unresolved,
    };
}

/** Agent-readable rendering of brainLensData (a view, or 'all'). */
export function lensToMarkdown(d, view = 'all') {
    const L = [];
    const date = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '—');
    const want = (v) => view === 'all' || view === v;
    L.push(`# Brain lens — ${d.title} (${d.counts.textCards} cards · ${d.counts.connections} connections)`);
    if (want('freshness')) {
        const f = d.freshness;
        L.push(`\n## Freshness\n≤7d **${f.fresh7d}** · ≤30d **${f.days30}** · ≤90d **${f.days90}** · stale **${f.stale}** · archived **${f.archived}**`);
        if (f.staleQuestions.length) {
            L.push(`Stale open ❓ (> ${d.staleDays}d):`);
            for (const q of f.staleQuestions.slice(0, 8)) L.push(`- ${q.ageDays}d · ${q.title}${q.area ? ` _(${q.area})_` : ''}`);
        }
    }
    if (want('provenance')) {
        const ch = Object.entries(d.provenance.channels).sort((a, b) => b[1] - a[1]);
        L.push(`\n## Who wrote it\n${ch.map(([k, n]) => `${k} **${n}**`).join(' · ') || '—'}`);
    }
    if (want('activity')) {
        L.push(`\n## This week\n${d.activity.days.map(x => `${x.daysAgo}d:${x.added}`).join(' · ')} (added per day, 6d→today)`);
        for (const r of d.activity.recent.slice(0, 10)) L.push(`- ${r.hoursAgo}h ago · ${r.title}${r.area ? ` _(${r.area})_` : ''}`);
    }
    if (want('timeline')) {
        L.push(`\n## Timeline\n${d.timeline.total} timed cards, ${date(d.timeline.tMin)} → ${date(d.timeline.tMax)}`);
        L.push(d.timeline.weeks.map(w => `${w.weekStart}:${w.added}`).join(' · '));
    }
    if (want('orrery') && d.orrery) {
        L.push(`\n## Orrery — “${d.orrery.rootTitle}”${d.orrery.rootArea ? ` _(${d.orrery.rootArea})_` : ''}`);
        for (const hop of [1, 2, 3]) {
            const ring = d.orrery.nodes.filter(n => n.hop === hop);
            if (ring.length) L.push(`hop ${hop}: ${ring.map(n => n.title.slice(0, 42)).join(' · ')}`);
        }
        if (d.orrery.overflow) L.push(`(+${d.orrery.overflow} more beyond ring caps)`);
    }
    if (want('unresolved')) {
        L.push(`\n## Unresolved (oldest first)`);
        if (!d.unresolved.length) L.push('No open questions — everything is decided. 🎉');
        for (const q of d.unresolved.slice(0, 12)) {
            L.push(`- **${q.ageDays}d** · ${q.title}${q.area ? ` _(${q.area})_` : ''}`);
            for (const ev of q.evidence.slice(0, 3)) L.push(`  ↳ ${ev.label || ev.rel || 'linked'}: ${ev.title.slice(0, 60)}`);
        }
    }
    return L.join('\n');
}
export function cardContentsHint(it, hasReading = false) {
    if (!it || typeof it !== 'object') return null;
    const hasBytes = !!(it.assetId || (typeof it.src === 'string' && it.src.startsWith('data:')) || it.originalPath || it.refPath);
    const ext = String(it.extension || String(it.fileName || '').split('.').pop() || '').toLowerCase();
    if (it.type === 'file' && it.isFolder) return 'its file list; add entry_paths with file paths from it (up to 8) to get those files themselves';
    if (it.type === 'link') return hasReading ? "KLYPIX's whole saved reading" : null;
    if (!hasBytes) return null;
    if (it.type === 'image' || (it.type === 'file' && IMAGE_FILE_EXT_RE.test(ext))) return "the photo itself (a smaller copy when it is large) and the original's file path";
    if (it.type === 'video' || it.type === 'audio') {
        return hasReading ? "KLYPIX's whole saved reading" : `a local path to the ${it.type} file (no reading is saved yet, and ${it.type} cannot be attached)`;
    }
    if (it.type !== 'file') return null;
    // A document KLYPIX has read comes back with its saved text first — only
    // while that text is of the bytes the card holds — and the file by path.
    const read = savedDocumentText(it) !== null;
    const saved = read ? "KLYPIX's saved text of the document, and " : '';
    if (ext === 'pdf') return `${saved}a local path to the PDF to open with your file-reading tool${it.previewDataUrl ? ", and KLYPIX's saved image of page 1" : ''}`;
    if (TEXT_FILE_EXT_RE.test(ext)) return read ? `${saved}a local path to the file to open with your file-reading tool` : "the file's text";
    if (OFFICE_FILE_EXT_RE.test(ext)) {
        const preview = read ? null : it.previewSheet ? "KLYPIX's saved first rows of the sheet" : it.previewHtml ? "KLYPIX's saved opening text" : null;
        return `${saved}a local path to the file to open with your file-reading tool${preview ? `, and ${preview}` : ''}`;
    }
    return `${saved}a local path to the file to open with your file-reading tool`;
}

/**
 * Render a parsed struct to the markdown brief (shared by read-klypix + MCP).
 *
 * Options (P0 agent parity, all optional — a bare call keeps the old shape plus
 * card ids):
 *   parsed      the full parseKlypix result; adds each card's saved reading,
 *               labels, status, comments, approval, canvas-link target, whether
 *               KLYPIX has read a link/media card, and the ink count
 *   lockedBoxes scopeLockedView(...).boxes — one line per box a person locked
 *   mcp         an MCP caller: the assets footer names read_card_contents
 *               instead of a CLI flag the caller cannot pass
 */
export function structToMarkdown(struct, { assetsDir, parsed = null, lockedBoxes = [], mcp = false } = {}) {
    // Archived cards were rendered here IDENTICALLY to live ones — no marker, and
    // `area` was never printed at all — so read_canvas served superseded,
    // consolidated and deleted-then-archived decisions as current fact. This is
    // the surface an agent reads to learn a project, which makes it the worst
    // place for that. They stay in the output (this is a whole-canvas dump, and
    // history is legitimately part of it) but they are now labelled.
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const items = parsed?.items || {};
    const rich = !!parsed;
    const visible = new Set(struct.cards.map(c => c.id));
    const readings = rich ? savedReadingIndex(parsed, new Set(Object.keys(items).filter(id => !visible.has(id)))) : null;
    const L = [];
    const n = struct.counts;
    L.push(`# ${struct.title}`);
    L.push(`*${struct.format} · ${n.live ?? n.cards} live cards${n.archived ? ` · ${n.archived} archived` : ''}${n.containers ? ` · ${n.containers} containers` : ''} · ${n.connections} connections · ${n.assets} assets*\n`);
    if (n.archived) L.push(`> ⛔ ${n.archived} card(s) below are marked archived — superseded, consolidated or retired. Read them as history, not as the current state.\n`);
    for (const box of lockedBoxes || []) L.push(`> 🔒 ${scopeLockLine(box)}\n`);
    const lockedIds = new Set((lockedBoxes || []).map(b => b.id));
    if (rich) {
        const strokes = Array.isArray(parsed.canvas?.strokes) ? parsed.canvas.strokes.length : 0;
        const lines = Array.isArray(parsed.canvas?.lines) ? parsed.canvas.lines.length : 0;
        const frozenInk = frozenDrawingCount(parsed.canvas?.strokes, items) + frozenDrawingCount(parsed.canvas?.lines, items);
        if (strokes || lines) L.push(`*Ink: ${strokes} freehand stroke${strokes === 1 ? '' : 's'} · ${lines} drawn line${lines === 1 ? '' : 's'}/shape${lines === 1 ? '' : 's'}${frozenInk ? ` · ${frozenInk} frozen` : ''} (not readable as text)*\n`);
    }
    L.push(`## Cards`);
    // The replacement rides in the stale card's own heading (1.98.0) — before,
    // the edge appeared only in the separate connection list at the end.
    let successors = new Map();
    try { successors = correctionOverlaysFor(struct, struct.cards.filter(c => c.type !== 'container')); } catch { successors = new Map(); }
    for (const c of struct.cards) {
        const archived = isArchived(c);
        const replacedNote = successors.has(c.id) ? ` — ${supersededByNote(successors.get(c.id), 90)}` : '';
        const it = items[c.id] || {};
        // Human-set state rides in the heading, where a reader cannot miss it.
        const state = [
            c.frozen ? 'frozen — read-only for AI tools' : null,
            lockedIds.has(c.id) ? 'locked from AI tools by a person (its cards are not shown)' : null,
            c.type === 'container' && c.containerKind === 'block' ? 'a frameless block' : null,
            c.type === 'container' && c.collapsed ? 'collapsed by the person (its cards are still listed)' : null,
        ].filter(Boolean);
        L.push(`### ${c.title || `(${c.type})`}  \`${c.type}\` · id ${c.id}${archived ? `  ⛔ archived${replacedNote}` : (replacedNote ? `  ⚠️${replacedNote}` : '')}${c.area && !archived ? `  _[${c.area}]_` : ''}${state.length ? `  · ${state.join(' · ')}` : ''}`);
        if (c.text) L.push(escapeInstructionLines(c.type === 'text' ? String(c.text).trim() : `→ ${c.text}`));
        if (rich) {
            const extra = [];
            if (c.type === 'canvas-link') {
                const target = it.relPath || it.filePath;
                extra.push(`Opens canvas: ${it.title || '(untitled)'}${target ? ` → ${target}` : ''}`);
            }
            if (c.type === 'approval') {
                const opts = Array.isArray(it.options) ? it.options.map(String) : [];
                extra.push(`Approval: ${escapeInstructionLines(String(it.question || '').trim()) || '(no question)'}${opts.length ? ` · options: ${opts.join(' | ')}` : ''} · decision: ${it.decision != null && it.decision !== '' ? String(it.decision) : 'pending'}`);
            }
            const result = readings.byResult.get(c.id);
            if (result) extra.push(`↳ KLYPIX's ${result.kind === 'ocr' ? 'text from' : 'reading of'} card ${result.sourceId}${result.kind === 'link' ? (result.partial ? ' (partial)' : ' (full)') : ''}`);
            const slot = readings.bySource.get(c.id) || {};
            const derived = derivedReading(it);
            if (slot.link) extra.push(`Read by KLYPIX → card ${slot.link.id} (${slot.link.partial ? 'partial' : 'full'})`);
            if (slot.ocr) extra.push(`Text extracted by KLYPIX (OCR) → card ${slot.ocr.id}`);
            if (derived) {
                const meta = [derived.kindLabel, derived.ranOn === 'cloud_ai' ? 'cloud AI' : derived.ranOn === 'this_pc' ? 'this PC' : null,
                    derived.visuals === true ? 'visuals seen' : derived.visuals === false ? 'audio only' : null, ymd(derived.at)].filter(Boolean).join(' · ');
                const excerpt = derived.text.length > 600 ? `${derived.text.slice(0, 600)}…` : derived.text;
                extra.push(`KLYPIX's saved reading (${meta}):\n${fenceContent({ cardId: c.id, source: `KLYPIX reading, ${derived.ranOn === 'cloud_ai' ? 'cloud AI' : 'this PC'}`, author: recordedAuthor(it), text: excerpt })}`);
            }
            const readable = ['link', 'video', 'audio', 'image'].includes(c.type) || (c.type === 'file' && !it.isFolder);
            // An MCP caller gets the photo or file itself from read_card_contents,
            // so "not read" is only worth saying where nothing else stands in for
            // a reading (links, audio, video).
            const fileStandsIn = mcp && (c.type === 'image' || c.type === 'file');
            if (readable && !slot.link && !slot.ocr && !derived && !fileStandsIn) {
                const step = notReadStep(it);
                extra.push(`Not read by KLYPIX yet${step ? ` — ${step}` : ''}.`);
            }
            if (mcp) {
                const hint = cardContentsHint(it, !!derived || !!slot.link);
                if (hint) extra.push(`Inside: read_card_contents with card_ids ["${c.id}"] returns ${hint}.`);
            }
            if (extra.length) L.push(extra.join('\n'));
        }
        const meta = [];
        if (c.links?.length) meta.push(`links: ${c.links.map(t => `[[${t}]]`).join(', ')}`);
        // #hashtags written in the text, and the tag PILLS put on the card
        // (item.tags) — both carried, labelled apart.
        if (c.tags?.length) meta.push(`tags: ${c.tags.map(t => `#${t}`).join(' ')}`);
        const pills = (c.labels || []).filter(t => !(c.tags || []).includes(t));
        if (pills.length) meta.push(`tag pills: ${pills.join(', ')}`);
        if (rich && it.status && it.status !== 'none') meta.push(`status: ${it.status}`);
        if (c.editedAt && c.editedAt !== c.createdAt) meta.push(`edited ${ymd(c.editedAt)}`);
        if (rich && Array.isArray(it.reactions) && it.reactions.length) {
            const counts = new Map();
            for (const r of it.reactions) if (r && r.emoji) counts.set(String(r.emoji), (counts.get(String(r.emoji)) || 0) + 1);
            if (counts.size) meta.push(`reactions: ${[...counts].map(([e, k]) => `${e} ${k}`).join(' · ')}`);
        }
        if (meta.length) L.push(`\n_${meta.join(' · ')}_`);
        if (rich && Array.isArray(it.comments) && it.comments.length) {
            const open = it.comments.filter(cm => cm && !cm.resolved);
            const resolved = it.comments.length - open.length;
            const head = `Comments: ${open.length} open, ${resolved} resolved`;
            if (!open.length) L.push(head);
            else {
                const body = open.slice(0, 5).map(cm => `${String(cm.author || 'unknown').slice(0, 60)}: ${String(cm.text || '').replace(/\s+/g, ' ').trim().slice(0, 300)}`).join('\n')
                    + (open.length > 5 ? `\n… +${open.length - 5} more open` : '');
                L.push(`${head}:\n${fenceContent({ cardId: c.id, source: 'open comments', author: 'the people named, as recorded', text: body })}`);
            }
        }
        L.push('');
    }
    if (struct.connections.length) {
        L.push(`## Connection graph`);
        // Arrows a person drew first; the app's provenance breadcrumbs (a file
        // dragged out of a folder card) last and labelled — KLYPIX draws them at
        // low salience because nobody authored them.
        const ordered = [...struct.connections.filter(e => e.origin !== 'provenance'), ...struct.connections.filter(e => e.origin === 'provenance')];
        for (const e of ordered) {
            const rel = e.relationship ? ` —(${e.relationship})→ ` : ' → ';
            const how = [e.style ? e.style : null, e.origin === 'provenance' ? 'provenance link (drawn by KLYPIX, low salience)' : null].filter(Boolean);
            L.push(`- ${e.from}${rel}${e.to}${e.label ? `  (${e.label})` : ''}${how.length ? `  [${how.join(' · ')}]` : ''}`);
        }
        L.push('');
    }
    if (struct.assets.length) {
        L.push(`## Assets (images / files)`);
        L.push(assetsDir
            ? `Extracted to \`${assetsDir}\` — open them to read images with vision:`
            : mcp
                ? "Call read_card_contents with a card's id for what is inside it: the photo itself, a PDF, Office, audio or video file as a local file path, a text file's words, the files inside a folder, and KLYPIX's saved readings and previews."
                : `Re-run with \`--assets <dir>\` to extract these for reading:`);
        for (const a of struct.assets) L.push(`- ${a}`);
        L.push('');
    } else if (mcp) {
        L.push('_Call read_card_contents for what is inside a link, video, photo, PDF, document or folder card._');
    }
    return L.join('\n');
}
