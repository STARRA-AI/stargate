# STARRA Inner Conference Room
**Opened:** 2026-07-16 · **Goal:** Bring STARRA to life — form matches function.
**Repo:** `/Users/work/Projects/stargate` (Next.js PWA). Preserve current HUD look.

## Standing orders
- Dark-only. Operator voice: "Copy." No emojis in UI.
- Do not modify `~/Desktop/STARGATE/web/*` for "upgrade" of the old app — port into this PWA.
- Never invent brand/business facts — ground in unified doc / soul / brain.
- Commit to `main` when a slice is proven. No force-push.
- Read this file before starting; append a short STATUS block when you finish or block.
- If you touch shared UI (`Bridge.tsx`, `ReactorEye.tsx`, `deck.css`), claim the lock below first.

## File lock (claim / release)
| Resource | Holder | Since |
|----------|--------|-------|
| Eye / Bridge / deck.css / brand motion | ANIMATION | 2026-07-16T06:18Z |
| brain.ts / chat loop / memory | V2-BRAIN | 2026-07-16T06:19Z |
| tools / Multica / keys | MULTICA | 2026-07-16T06:19Z |
| GitHub remote | GITHUB+DOCS | 2026-07-16T06:19Z |

---

## Agenda (recent operator directives)

### A1 — ANIMATIONS FIRST (priority 0)
**Spec:** `/Users/work/Desktop/STARRA_ANIMATION_SPEC.md`  
**Assets:**  
- `/Users/work/Downloads/files (5)/badge_heartbeat.webm`  
- `/Users/work/Downloads/files (5)/eye_alert.webm`  
- `/Users/work/Downloads/files (5)/eye_think.webm`  
- `/Users/work/Downloads/files (5)/panel_boot.webm`  
- `/Users/work/Downloads/files (5)/wordmark_shine.webm`  
- `/Users/work/Downloads/eye_idle.webm`  
**Mandate:** Wire cinematic loops + 4-layer eye rig into the PWA. Form = function (idle/think/alert/boot/heartbeat/shine). Hardware budget: transform/opacity only; video carries heavy visuals. Integrate with existing cursor+camera gaze.  
**Agent:** ANIMATION  
**Status:** IN PROGRESS — lock claimed

### A2 — MULTICA POWER
**Source:** `vendor/multica` (cloned from https://github.com/multica-ai/multica.git)  
**Mandate:** Distill Multica doctrine into STARRA's prompt; add Tools + LINK API for Multica token; issue/status bridge when keyed. Do not commit the whole vendor tree — gitignore + bootstrap.  
**Agent:** MULTICA  
**Status:** QUEUED

### A3 — V2 ARCHITECTURE UPGRADE (appearance frozen)
**Spec:** `/Users/work/Desktop/STARRA_V2_CURSOR_HANDOFF.md`  
**Mandate:** Port jarvis-*patterns* (not jarvis code) into this Next.js app: loop caps, redaction, untrusted fencing, prompt caching/token diet, tiered memory, tool selection, turn evaluator. **Do not change HUD appearance.** Adapt Flask phases to `src/lib` + `/api/chat`. Phases 0→1 first.  
**Agent:** V2-BRAIN  
**Status:** IN PROGRESS — lock claimed on brain/chat/memory; staying in `src/lib` + `/api/chat` (no HUD).

### A4 — GITHUB PRIVATE REPO
**Mandate:** Auth + `gh repo create stargate --private --source=. --remote=origin --push`. Blocked until Classic completes device login.  
**Agent:** GITHUB+DOCS  
**Status:** IN PROGRESS — device login started; lock claimed

### A5 — CODERABBIT (advisory)
**Mandate:** Short operator guide: how to use CodeRabbit PRs to debug this repo once remote exists. Optional `.coderabbit.yaml`.  
**Agent:** GITHUB+DOCS  
**Status:** IN PROGRESS — writing `docs/CODERABBIT.md` + `.coderabbit.yaml`

### A6 — DEBUG/OPTIMIZE (prior thread)
**Note:** Agent previously ran; chat hang fix landed as `a9b582b`. Re-check only if ANIMATION/V2 regress.

---

## Cross-talk protocol
After each commit or blocker, append:

```
### STATUS — <AGENT> — <ISO time>
- Done: …
- Blocked: …
- Next: …
- Lock: claimed/released …
```

ANIMATION owns the living body. MULTICA owns external agent muscle. V2-BRAIN owns safety and memory spine. GITHUB owns remotes. DOCS owns review tooling. Conference goal: one living STARRA.

### STATUS — DEBUG/OPTIMIZE — 2026-07-16T01:19
- Done: Chat hang root cause fixed (prompt clip + qwen2.5:1.5b + eye/poll throttles). Commit `a9b582b`.
- Blocked: Ollama dies under ~22MB free RAM — operator must free memory for chat verify.
- Next: ANIMATION/V2/MULTICA continue; leave debug instrumentation until operator confirms chat.
- Lock: none held
