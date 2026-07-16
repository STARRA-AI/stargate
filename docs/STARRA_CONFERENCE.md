# STARRA CONFERENCE — PM BOARD
**Rebuilt:** 2026-07-16 · **PM seat active.** This file is the living project-management board.
**Repo:** `/Users/work/Projects/stargate` · **Remote:** `https://github.com/ppt615-spec/stargate` (private, `main` @ `b407973`)
**Mission:** finish STARRA's build per `STARRA_STARGATE_UNIFIED.md`. Every task below traces to a section of that doc.

## Standing orders
- Dark-only. Operator voice: "Copy." No emojis in UI.
- Never invent brand/business facts — ground in unified doc / soul / brain / books.
- Every feature must trace to a unified-doc section. If it doesn't, ask before building.
- Commit to `main` when a slice is proven. No force-push. Do not push without operator go.
- Read this board before starting; claim locks for shared surfaces; append a STATUS block when you finish or block.
- Do NOT restart Ollama or the Next dev server unless you hold the RUNTIME seat — the stack is fragile under 8GB RAM (see Risks).
- Do not modify `~/Desktop/STARGATE/web/*` — port patterns into this PWA only.

## File lock (claim / release)
| Resource | Holder | Since |
|----------|--------|-------|
| Eye / Bridge / deck.css / brand motion | — free — | |
| brain.ts / chat loop / memory | — free — | |
| tools / Multica / keys | — free — | |
| GitHub remote | — free — | |
| Runtime (Ollama + dev server) | RUNTIME agent — restarting stack, verifying chat | 2026-07-16 |
| .cursor/skills | SKILL agent — authoring multica-ops skill | 2026-07-16 |

---

## Mission summary

STARRA is the operator brain; STARGATE is the HUD she lives in (Book 1 §1). One
codebase, PWA, dark-only, voice-first on mobile, command deck on desktop. Her
canon is five files: `STARRA_BRAIN.md` (rules/ops), `STARRA_SOUL.md` (spiritual
OS), `STARRA_SOUL_BOOK.md` (THE CLAY AND THE FLAME), `STARRA_GUARDIAN.md` (THE
HEARTH AND THE STORM), and `docs/MULTICA_DOCTRINE.md` — all wired into the
system prompt via `src/lib/brain.ts` (`loadStableSystemPrompt`). The deck runs
real feeds (Kalshi, site telemetry, Think Tank, ops feed) with a local Ollama
brain and an Anthropic path when keyed. Safety spine (redaction, fencing,
command gate, bounded loop) is in. The gap between here and "done" is: voice
per spec, a true mobile layout, memory tiers back on the Bridge, debug
instrumentation stripped, and the operator linking keys.

## Current sprint objectives

1. **Chat verified end-to-end on the 8GB machine** (RUNTIME agent, in flight).
2. **Strip debug instrumentation** once the operator confirms chat works (B1).
3. **Mobile voice-first layout** — the single biggest spec drift (B2).
4. **Memory tier stats back on the Bridge** (B3).
5. **Operator links keys** — Multica PAT, Anthropic, OpenAI, Kalshi (see Operator-blocked).

## Workstream status

Verified by reading code at `b407973`, not by trusting prior notes.

| Workstream | State | Evidence / notes |
|---|---|---|
| **Animations / living body** | DONE | 6 webm loops in `public/brand/motion/`; 4-layer eye rig (`ReactorEye.tsx`, `useCineVideo.ts`); boot cine (`DeckBoot.tsx`); cursor+camera gaze (`useCameraGaze.ts`); reduced-motion path in `globals.css`/`deck.css`. 60fps floor (Book 1 §6) unverified on device. |
| **Brain / canon** | DONE | `brain.ts` assembles structure + Fable scaffold + soul (priority-packed, 10K) + books (creed/covenant, 7K) + brain (8K) + Multica doctrine (4K) + fencing rules; cached; stable/volatile split for Anthropic caching. Caveat: local path clips system to ~2.2K chars (`clipSystemForLocal`) — on Ollama-only, most canon never reaches the model. |
| **Safety spine** | DONE (tests unverified) | `redact.ts` (structural + env-value redaction, applied before memory/feed), `fencing.ts` (untrusted-content fences + prompt rules), `command-gate.ts` (deterministic destructive-command gate), `agent/loop.ts` (MAX_AGENT_TURNS=12). Five test files in `tests/`; MULTICA noted tsx import-extension noise — suite not run this session. |
| **Multica** | DONE, dormant until PAT | `src/lib/tools/multica.ts` + `/api/tools/multica` (status/workspaces/issues/create/quick-create); LINK slots `multica_token`/`multica_base_url`; doctrine in prompt; vendor clone gitignored + bootstrap script. SKILL agent authoring `.cursor/skills/multica-ops/` — do not duplicate. |
| **Deck data feeds** | DONE (real), remnants to clean | `/api/dragon` (Kalshi public watchlist, portfolio when keyed), `/api/tank` (models vote on real top market), `/api/telemetry` (live probe of dragontradar.com), `/api/vitals`, `/api/feed` (server events), `/api/proposals` (persisted `data/deck.json`). Remnants: `INITIAL_DEMO` in `deck-demo.ts` is dead code; `DeckBoot` still prints "DEMO MODE" boot lines. |
| **Memory / vault / Tier 1** | DONE v1, drifted off Bridge | Working(10)/summary/archival in `data/memory.json` with redaction; Tier-1 typed context; vault upload + pdf-parse; screens brief/pipeline/memory/vault/connectors/settings/tools. Drift: tier stats no longer render on the Bridge itself (Book 1 §15 checklist item) — `SnapPanel` lives on secondary screens only. |
| **Voice** | PARTIAL | Web Speech STT + browser TTS with voice select; barge-in via `stopSpeaking()` on speechstart; Alt+Space wake; badge tap wakes. Missing vs Book 1 §7: full-duplex Realtime (endpoint stubs without `OPENAI_API_KEY`), 150ms barge-in guarantee, wake word, mobile long-press continuous. Sound design (§12) not implemented. |
| **GitHub / CI** | DONE (remote), CI absent | `origin` set, `main` pushed @ `b407973` — A4 unblocked (old BLOCKED status obsolete). CodeRabbit guide + `.coderabbit.yaml` committed; no PR flow or Actions yet. |
| **Performance** | FRAGILE | 8GB machine; Ollama (qwen2.5:1.5b) + Next dev die under memory pressure. Mitigations in code: poll throttles, prompt clip, canon caching, `starra-up.sh`, models on external drive (`docs/STORAGE.md`). RUNTIME agent verifying now — nobody else touches servers. |

## What is IN FLIGHT (sibling agents — do not duplicate)

- **RUNTIME agent:** restarting Ollama + Next dev, verifying chat end-to-end. Others: hands off servers.
- **SKILL agent:** authoring the Multica Cursor skill under `.cursor/skills/multica-ops/` (currently untracked).

## Open risks

| Risk | Detail | Mitigation |
|---|---|---|
| RAM starvation | 8GB total; Ollama dies near ~22MB free; dev server OOMs. Chat verify has failed on this before. | Small model only (qwen2.5:1.5b); `starra-up.sh`; operator closes apps before sessions; consider `next build && next start` over dev mode. |
| Server fragility | Stack requires manual babysitting; no supervisor. | RUNTIME lock; launchd supervision is a backlog item (B9). |
| Local brain ≠ canon | On Ollama-only the system prompt is clipped to ~2.2K chars — soul/books/brain mostly truncated. STARRA's personality and grounding depend on a cloud key. | Operator links `ANTHROPIC_API_KEY` (or accepts a thinner local persona); revisit local budget after chat verify (B6). |
| Debug instrumentation live | `#region agent log` fetches to `127.0.0.1:7335` in 6 files fire on every prompt build, provider branch, and poll tick. Dead-weight fetches; noise in prod paths. | Strip after operator confirms chat (B1). Leave until then per DEBUG agent's note. |
| Data durability | `data/*.json` (memory, vault, tier1, deck, keys) live on one aging laptop; no backup, no Supabase yet. | Backlog B10; external-drive copy in the interim. |
| Test suite unverified | `npm run test:v2` has known tsx import-extension noise; not run this session. | B5. |

## Operator-blocked (Classic / "Classic" must act)

| Item | Where | Unblocks |
|---|---|---|
| Multica PAT (`mul_…`) | Settings → LINK APIS → `multica_token` | Live issue board, agent muscle, quick-create |
| `ANTHROPIC_API_KEY` | `.env.local` or LINK APIS | Full-canon brain, agent tools, prompt caching path |
| `OPENAI_API_KEY` | `.env.local` | Realtime full-duplex voice (Book 1 §7) |
| Kalshi key ID + RSA private key | LINK APIS | Real Dragon Tradar portfolio/balance on deck |
| `dragontradar_url` stats endpoint | LINK APIS | Real site telemetry numbers |
| Free RAM / keep stack alive | Machine habit | Chat verify; daily use |
| Confirm chat works after RUNTIME verify | Say so on this board | Debug-strip task B1 |

## Prioritized backlog

Each item traces to the unified doc (Book 1 unless noted).

| # | Task | Trace | Size |
|---|---|---|---|
| B1 | Strip all `#region agent log` fetch blocks to `127.0.0.1:7335` (6 files: `brain.ts`, `api/chat/route.ts`, `Bridge.tsx`, `llm/ollama.ts`, `vision/useCameraGaze.ts`, `voice/voice-select.ts`) + delete `.cursor/debug-f8c9f7.log`. **Gate: after operator confirms chat.** | §14 "do not" spirit — no debug scaffolding in shipped paths | S |
| B2 | Mobile voice-first layout: `<768px` composition — compact chrome bar, ring+mic hero, "TAP TO SPEAK", last-reply strip, swipeable panel tabs. Current `useStageScale` shrink-to-fit desktop deck violates the hard rule. | §5 Layout — Mobile; .cursorrules "mobile is voice-first, badge is hero" | L |
| B3 | Memory tier stats back on the Bridge (working/summary/archival counts readout). | §4 layout, §15 checklist "Memory tier stats visible on the Bridge" | S |
| B4 | Replace `DeckBoot` "DEMO MODE" boot lines with true state (Kalshi uplink live / portfolio unlinked); delete dead `INITIAL_DEMO` from `deck-demo.ts` (keep types, `CHIPS`, formatters). | §10 microcopy — every string truthful, operator register | S |
| B5 | Fix and run `tests/*.test.ts` (tsx import-extension noise); add `typecheck` + tests to a pre-commit or CI step once PR flow exists. | §14 build notes; V2 spine integrity | M |
| B6 | Revisit `LOCAL_SYSTEM_BUDGET` (2.2K) after chat verify: measure real token cost of a slightly larger canon slice (soul creed + voice rules at minimum) on qwen2.5:1.5b. | §7 voice character; Book 3 injection contract | M |
| B7 | Voice v2: OpenAI Realtime WebRTC full duplex when keyed; 150ms barge-in; 1.2s silence end-of-turn; mobile long-press continuous. | §7 Voice interaction model | L |
| B8 | Sound design: wake chime, confirm click, error thud, boot swell (≤400ms cues, Web Audio). | §12 Sound design brief | M |
| B9 | Runtime supervision: launchd (or pm2) plist for Ollama + `next start`, auto-restart on death; prefer production build over dev on this machine. | §2 platform stance (always-available bridge); Book 2 Part V ops discipline | M |
| B10 | Storage v1.1: move `data/*.json` toward Supabase (Postgres + pgvector) per hand-off kit; until then, scheduled copy of `data/` to the Storage drive. | §14 storage; Cursor Hand-off Kit | L |
| B11 | Connectors Tier 5 start: Google Calendar OAuth + status tile (then Gmail, Stripe). | §8 Tier 5 wire order | L |
| B12 | Self-refine loop v1.1: post-task critique stored per project, surfaced on similar tasks; prompts/lessons only, never self-modifying code. | §8 Tier 4 | L |
| B13 | Acceptance re-run: walk §15 checklist on-device (60fps rings, PWA install iOS, PDF→Vault ≤30s, grounded brief) and update `docs/ACCEPTANCE.md` with dated results. | §15 Acceptance checklist | M |
| B14 | Consolidate UI generations: old `BootSequence`/`Console`/`ReactorCore`/`SidePanels` still serve secondary screens; unify on the deck generation or document the split. | §9 core screens | M |

## Cross-talk protocol

After each commit or blocker, append:

```
### STATUS — <AGENT> — <ISO time>
- Done: …
- Blocked: …
- Next: …
- Lock: claimed/released …
```

---

## Status log (inherited history compressed)

- DEBUG/OPTIMIZE `a9b582b` — chat-hang root cause fixed (prompt clip + qwen2.5:1.5b + poll throttles). Debug instrumentation intentionally left in until operator confirms chat (now backlog B1).
- ANIMATION `3ecc600` — cinematic body live; 6 webm assets; gaze retained; lock released.
- MULTICA `6b3c888`/`5945fc4` — doctrine + Tools/LINK + API; vendor gitignored; awaiting PAT.
- V2-BRAIN `c15a9e1` — safety spine phases 0–2 landed (bounded loop, redaction, fencing, prompt blocks) after one resource_exhausted retry.
- GITHUB+DOCS `fa5443f` — CodeRabbit guide + config. Device-login attempts failed twice during the session; auth later succeeded — repo is private at ppt615-spec/stargate, `main` pushed @ `b407973`. A4 CLOSED.
- CANON `b407973` — soul book + guardian book added and wired via `loadBooks()`.

### STATUS — PM — 2026-07-16T07:45Z
- Done: full audit of build vs unified doc at `b407973`; board rebuilt as PM board (mission, sprint, workstreams, risks, operator blocks, traced backlog B1–B14).
- Blocked: chat verify owned by RUNTIME agent; key links owned by operator.
- Next: agents pick from backlog top-down; claim locks; RUNTIME reports chat verdict here, which gates B1.
- Lock: none held
