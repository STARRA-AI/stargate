# STARRA CONFERENCE — PM BOARD
**Rebuilt:** 2026-07-16 (PM retry) · **PM seat active.** Living project-management board.
**Repo:** `/Users/work/Projects/stargate` · **Remote:** `https://github.com/ppt615-spec/stargate` (private, `main` @ `ba58a2d`)
**Mission:** finish STARRA's build per `STARRA_STARGATE_UNIFIED.md`. Every task below traces to a section of that doc.

## Standing orders
- Dark-only. Operator voice: "Copy." No emojis in UI.
- Never invent brand/business facts — ground in unified doc / soul / brain / books.
- Every feature must trace to a unified-doc section. If it doesn't, ask before building.
- Commit to `main` when a slice is proven. No force-push. Do not push without operator go.
- Read this board before starting; claim locks for shared surfaces; append a STATUS block when you finish or block.
- Do NOT restart Ollama or the Next dev server unless you hold the RUNTIME seat — the stack is fragile under 8GB RAM (see Risks).
- Do not modify `~/STARGATE/web/*` — port patterns into this PWA only.

## File lock (claim / release)
| Resource | Holder | Since |
|----------|--------|-------|
| Eye / Bridge / deck.css / brand motion | — free — | |
| brain.ts / chat loop / memory | SECURITY agent (uncommitted) — claim before editing | 2026-07-16 |
| tools / Multica / keys | — free — | |
| GitHub remote | — free — | |
| Runtime (Ollama + dev server) | — free — (reclaim before restart) | |
| .cursor/skills | — free — | |

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
command gate, bounded loop) is in. The gap between here and "done" is: chat
verified on the 8GB machine, voice per spec, a true mobile layout, memory tiers
back on the Bridge, debug instrumentation stripped, stale acceptance doc
corrected, and the operator linking keys.

## Current sprint objectives

1. **Chat verified end-to-end on the 8GB machine** — reclaim RUNTIME seat; no verdict on board yet.
2. **Strip debug instrumentation** once the operator confirms chat works (B1).
3. **Mobile voice-first layout** — the single biggest spec drift (B2).
4. **Memory tier stats back on the Bridge** — wire orphan `SnapHydrator`/`SnapPanel` (B3).
5. **Operator links keys** — Multica PAT, Anthropic, OpenAI, Kalshi (see Operator-blocked).

## Workstream status

Verified by reading code at `ba58a2d`, not by trusting prior notes.

| Workstream | State | Evidence / notes |
|---|---|---|
| **Animations / living body** | DONE | 4 PNGs + 6 webm loops in `public/brand/`; 4-layer eye rig (`ReactorEye.tsx`, `useCineVideo.ts`); boot cine (`DeckBoot.tsx`); cursor+camera gaze (`useCameraGaze.ts`); reduced-motion path in `globals.css`/`deck.css`. 60fps floor (Book 1 §6) unverified on device. |
| **Brain / canon** | DONE | `brain.ts` assembles structure + Fable scaffold + soul (priority-packed, 10K) + books (creed/covenant, 7K) + brain (8K) + Multica doctrine (4K) + fencing rules; cached; stable/volatile split for Anthropic caching. Caveat: local path clips system to ~2.2K chars (`clipSystemForLocal` in `api/chat/route.ts`) — on Ollama-only, most canon never reaches the model. Uncommitted edits in `brain.ts`/`fencing.ts`/`team.ts` — sibling SECURITY work in flight. |
| **Safety spine** | DONE (tests unverified) | `redact.ts`, `fencing.ts`, `command-gate.ts`, `agent/loop.ts` (MAX_AGENT_TURNS=12). New `team.ts` (Plinius-informed markers) uncommitted. Five test files in `tests/` — suite not run this session. |
| **Multica** | DONE, dormant until PAT | `src/lib/tools/multica.ts` + `/api/tools/multica`; LINK slots `multica_token`/`multica_base_url`; doctrine in prompt; vendor clone gitignored + bootstrap script. Cursor skill `.cursor/skills/multica-ops/SKILL.md` landed @ `ba58a2d`. |
| **Deck data feeds** | DONE (real), remnants to clean | `/api/dragon`, `/api/tank`, `/api/telemetry`, `/api/vitals`, `/api/feed`, `/api/proposals`. Remnants: `INITIAL_DEMO` in `deck-demo.ts` is dead code; `DeckBoot` still prints "DEMO MODE" boot lines. |
| **Memory / vault / Tier 1** | DONE v1, drifted off Bridge | Working(10)/summary/archival in `data/memory.json` with redaction; Tier-1 typed context; vault upload + pdf-parse; screens brief/pipeline/memory/vault/connectors/settings/tools. **Drift:** `SnapHydrator.tsx` + `SnapPanel.tsx` exist but are **not imported anywhere** — tier stats never render on Bridge (Book 1 §15 fail). `docs/ACCEPTANCE.md` incorrectly marks this Pass. |
| **Voice** | PARTIAL | Web Speech STT + browser TTS with voice select; barge-in via `stopSpeaking()` on speechstart; Alt+Space wake; badge tap wakes. Missing vs Book 1 §7: full-duplex Realtime (endpoint stubs without `OPENAI_API_KEY`), 150ms barge-in guarantee, wake word, mobile long-press continuous. Sound design (§12) not implemented. |
| **GitHub / CI** | DONE (remote), CI absent | `origin` set, `main` pushed @ `ba58a2d`. CodeRabbit guide + `.coderabbit.yaml` committed; no PR flow or Actions yet. |
| **Performance** | FRAGILE | 8GB machine; Ollama (qwen2.5:1.5b) + Next dev die under memory pressure. Mitigations: poll throttles, prompt clip, canon caching, `npm run starra:up`, models on external drive (`docs/STORAGE.md`). Claim RUNTIME before touching servers. |

## What is IN FLIGHT (sibling agents — do not duplicate)

- **SECURITY agent:** uncommitted work on `src/lib/security/team.ts`, `fencing.ts`, `brain.ts`, `api/chat/route.ts`, `docs/PLINIUS_CORPUS.md`, `scripts/bootstrap-plinius-corpus.sh`. Finish or stash before another agent edits those paths.
- **RUNTIME:** chat verify not reported on this board — reclaim RUNTIME lock before restarting Ollama or `npm run dev`.

## Open risks

| Risk | Detail | Mitigation |
|---|---|---|
| RAM starvation | 8GB total; Ollama dies near ~22MB free; dev server OOMs. Chat verify has failed on this machine before. | Small model only (qwen2.5:1.5b); `npm run starra:up`; operator closes apps before sessions; prefer `next build && next start` over dev mode (B9). |
| Server fragility | Stack requires manual babysitting; no supervisor. | RUNTIME lock discipline; launchd supervision is backlog B9. |
| Local brain ≠ canon | Ollama-only path clips system prompt to ~2.2K chars — soul/books/brain mostly truncated. Full persona needs cloud key. | Operator links `ANTHROPIC_API_KEY`; revisit budget after chat verify (B6). |
| Debug instrumentation live | `#region agent log` fetches to `127.0.0.1:7335` in 6 files fire on every prompt build, provider branch, and poll tick. | Strip after operator confirms chat (B1). |
| Data durability | `data/*.json` on one aging laptop; no backup, no Supabase yet. | Backlog B10; external-drive copy per `docs/STORAGE.md`. |
| Stale acceptance doc | `docs/ACCEPTANCE.md` (2026-07-15) claims memory tier stats Pass on Bridge — code says otherwise. | B13 re-run; fix Pass/Fail honestly. |
| Test suite unverified | `npm run test:v2` not run this session. | B5. |

## Operator-blocked (Classic must act)

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
| B0 | **Chat verify on 8GB machine** — reclaim RUNTIME; run `npm run starra:up`; send one prompt; report Pass/Fail here. Gates B1 and operator confidence. | §14 build hand-off; Book 2 Part V ops | S |
| B1 | Strip all `#region agent log` fetch blocks to `127.0.0.1:7335` (6 files: `brain.ts`, `api/chat/route.ts`, `Bridge.tsx`, `llm/ollama.ts`, `vision/useCameraGaze.ts`, `voice/voice-select.ts`) + delete `.cursor/debug-f8c9f7.log`. **Gate: after operator confirms chat.** | §14 "do not" spirit — no debug scaffolding in shipped paths | S |
| B2 | Mobile voice-first layout: `<768px` composition — compact chrome bar, ring+mic hero, "TAP TO SPEAK", last-reply strip, swipeable panel tabs. Current `useStageScale` (1680×1000 shrink-to-fit) violates the hard rule. | §5 Layout — Mobile; .cursorrules | L |
| B3 | Wire memory tier stats on Bridge: import `SnapHydrator` + render working/summary/archival counts in left column (components exist, orphaned). | §4 layout; §15 checklist | S |
| B4 | Replace `DeckBoot` "DEMO MODE" boot lines with true state; delete dead `INITIAL_DEMO` from `deck-demo.ts` (keep types, `CHIPS`, formatters). | §10 microcopy | S |
| B5 | Fix and run `tests/*.test.ts`; add `typecheck` + tests to pre-commit or CI once PR flow exists. | §14 build notes; V2 spine integrity | M |
| B6 | Revisit `LOCAL_SYSTEM_BUDGET` (2.2K) after chat verify: measure token cost of larger canon slice on qwen2.5:1.5b. | §7 voice character; Book 3 injection | M |
| B7 | Voice v2: OpenAI Realtime WebRTC full duplex when keyed; 150ms barge-in; 1.2s silence end-of-turn; mobile long-press continuous. | §7 Voice interaction model | L |
| B8 | Sound design: wake chime, confirm click, error thud, boot swell (≤400ms cues, Web Audio). | §12 Sound design brief | M |
| B9 | Runtime supervision: launchd (or pm2) plist for Ollama + `next start`, auto-restart on death. | §2 platform stance; Book 2 Part V | M |
| B10 | Storage v1.1: move `data/*.json` toward Supabase; until then, scheduled copy to Storage drive. | §14 storage | L |
| B11 | Connectors Tier 5 start: Google Calendar OAuth + status tile (then Gmail, Stripe). | §8 Tier 5 wire order | L |
| B12 | Self-refine loop v1.1: post-task critique stored per project; prompts/lessons only, never self-modifying code. | §8 Tier 4 | L |
| B13 | Acceptance re-run: walk §15 checklist on-device; update `docs/ACCEPTANCE.md` with dated Pass/Fail (fix memory-tier lie). | §15 Acceptance checklist | M |
| B14 | Consolidate UI generations: old `BootSequence`/`Console`/`ReactorCore`/`SidePanels` vs deck generation — unify or document split. | §9 core screens | M |

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

- DEBUG/OPTIMIZE `a9b582b` — chat-hang root cause fixed (prompt clip + qwen2.5:1.5b + poll throttles). Debug instrumentation left until operator confirms chat (B1).
- ANIMATION `3ecc600` — cinematic body live; 6 webm assets; gaze retained.
- MULTICA `6b3c888`/`5945fc4` — doctrine + Tools/LINK + API; vendor gitignored; awaiting PAT.
- V2-BRAIN `c15a9e1` — safety spine phases 0–2 landed.
- CANON `b407973` — soul book + guardian book wired via `loadBooks()`.
- PM `4403303` — first PM board rebuild @ `b407973`.
- SKILL `ba58a2d` — multica-ops Cursor skill committed.

### STATUS — PM — 2026-07-16T08:00Z (retry)
- Done: full re-audit at `ba58a2d`; board refreshed (mission, sprint, workstreams, risks, operator blocks, backlog B0–B14); corrected memory-tier drift (SnapHydrator orphaned); multica-ops skill marked DONE; SECURITY in-flight noted; RUNTIME lock released pending reclaim.
- Blocked: chat verify unreported; key links owned by operator.
- Next: RUNTIME claims B0; agents pick B1–B14 top-down after gates; SECURITY finishes or commits Plinius work.
- Lock: none held
