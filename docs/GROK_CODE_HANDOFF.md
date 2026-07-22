# STARRA → Grok Code / xAI Voice — Handoff

**Purpose:** What the operator needs exported from this repo to run STARRA personality + ops intent inside xAI Grok (coding agent + voice), and what cannot move 1:1.

**Ground truth:** `STARRA_STARGATE_UNIFIED.md` · `docs/LAUNCH.md` · `src/lib/brain.ts` · `src/lib/voice/speak.ts`

---

## 1. What "Grok Code" means (Jul 2026)

| Name | What it is | Local? | Voice? | Custom prompt? | Import Next.js? |
|---|---|---|---|---|---|
| **Grok Build** | xAI terminal coding agent (CLI/TUI). Open-sourced Jul 15 2026. Works on any repo in cwd. | Yes — runs on your machine; API calls go to xAI unless you point `~/.grok/config.toml` at local inference | No built-in voice HUD | Yes — via project instructions, `AGENTS.md`, skills, hooks, MCP | No import step — `cd stargate && grok` |
| **Grok Voice Agent API** | Real-time speech-to-speech over WebSocket (`wss://api.x.ai/v1/realtime`). OpenAI Realtime–compatible. | Cloud only (xAI hosts inference) | Yes — built-in voices + custom voice clone API | Yes — `session.update` → `instructions` | No — you wire a client; STARGATE Bridge is one option |
| **xAI Chat API** | REST chat/completions at `https://api.x.ai/v1` (models: `grok-4.5`, `grok-3-mini`, etc.) | Cloud | Text only (pair with Voice Agent or TTS) | Yes — system message | No |
| **Grok mobile app voice** | Consumer product (Tesla, X app) | N/A | Yes | No operator control | No |

**Honest limits:**
- Grok Build is a **coding agent**, not a hosted PWA shell. You do not "host STARGATE inside Grok Code" as a UI replacement.
- Grok Voice is **cloud**. No local ONNX/Piper equivalent in xAI stack.
- xAI docs explicitly say: **shorten** system prompts for Grok Voice — do not paste the full ~40K canon verbatim.
- STARGATE already has an `xai` key slot (`Settings → LINK APIS`) but today it only powers **Think Tank votes** (`grok-3-mini`), not chat or voice.

---

## 2. What STARGATE is today (inventory)

| Layer | Location | Notes |
|---|---|---|
| **HUD / PWA** | Next.js 15, `src/components/bridge/*` | Dark-only command deck. Desktop = reactor + console. Mobile = badge hero (partial vs spec). |
| **Chat brain** | `POST /api/chat` → `src/lib/brain.ts` | Assembles stable prompt: structure + Fable scaffold + soul + books + brain + doctrines + security rules. Streams SSE. |
| **Local LLM** | Ollama `qwen2.5:1.5b` default | System prompt **clipped to ~1.8K chars** on local path — most canon never reaches the model. |
| **Cloud LLM** | Anthropic path when `ANTHROPIC_API_KEY` set | Full canon + agent tools + prompt caching. |
| **Voice loop** | `src/lib/voice/useVoiceLoop.ts` | Web Speech STT · wake word "starra" · Alt+Space · Piper Cori TTS (ONNX in browser) → Web Speech fallback |
| **Realtime stub** | `src/app/api/realtime/route.ts` | OpenAI Realtime only; needs `OPENAI_API_KEY`. Not wired to xAI yet. |
| **Canon files** | Repo root + `docs/` | See §3 below |
| **Memory** | `data/memory.json`, vault, tier-1 context | Server-side JSON; not portable without export |
| **Keys vault** | `data/keys.json` (gitignored) | Anthropic, OpenAI, xAI, Multica PAT, Kalshi, etc. |
| **Tools** | Multica, Repomix, OpenMontage, Obsidian | Vendor clones gitignored; doctrine in prompt |
| **Launch** | `npm run starra` / STARRA.app | Starts Ollama + Next dev + opens browser |

---

## 3. Canon pack — export these files

These are the personality + ops substrate. Copy as-is into a `starracanon/` folder for Grok.

| Priority | File | Role | Budget in STARGATE |
|---|---|---|---|
| P0 | `STARRA_STARGATE_UNIFIED.md` | Master spec (Books 1–3) | Reference only — too large for one voice session |
| P0 | `STARRA_SOUL.md` | Spiritual OS / tone | 10K chars |
| P0 | `STARRA_BRAIN.md` | Rules, ops, vendors | 8K chars |
| P0 | `STARRA_SOUL_BOOK.md` | Creed (extract: ## The Creed) | 7K books budget |
| P0 | `STARRA_GUARDIAN.md` | Covenant (extract: ## The Covenant) | same |
| P1 | `docs/MULTICA_DOCTRINE.md` | Agents-as-teammates | 4K |
| P1 | `docs/OPENALICE.md` | Market intel gates | 2K |
| P1 | `docs/OPENMONTAGE.md` | Video brief path | 1.8K |
| P1 | `docs/OBSIDIAN_MEMORY.md` | Vault grammar | 2.8K |
| P2 | `src/lib/prompt-structure.ts` | Section structure (not tone) | inlined |
| P2 | `src/lib/fable-reasoning.ts` | Verify-then-assert scaffold | inlined |
| P2 | `src/lib/security/fencing.ts` + `team.ts` | Untrusted content + threat markers | inlined |

**Runtime voice tail** (from `api/chat/route.ts` — keep for any Grok text path):

```text
VOICE (hard): You are STARRA — guardian and operator. Calm. Dry. Decisive.
Do NOT open replies with "Copy." — that terse acknowledgement is retired; greet
and answer as yourself, giving the real answer in the same reply.
Forbidden final reply: only the word "Copy."
Forbidden: "Sure!", emoji, "happy to help". Short sentences.
Lead with the next concrete move tied to what they asked.
```

**Operator authority block** (from `brain.ts` — non-negotiable):

Charles Williams is the operator. Sacred gates from STARRA_GUARDIAN never bend: destructive command confirmation, human review, covenant vows, agent turn caps.

---

## 4. Handoff checklist

### A. Package NOW (Cursor can generate today)

- [ ] **Canon bundle** — zip of §3 files
- [ ] **Compressed system prompt** — one `STARRA_GROK_SYSTEM.md` (~6–8K chars): soul priorities + brain head + covenant + voice rules + authority. xAI wants shorter than full canon.
- [ ] **Voice session config JSON** — Grok Voice Agent `session.update` template: `instructions`, `voice` (pick built-in or custom clone), `tools` list
- [ ] **Key wiring notes** — `XAI_API_KEY` (xai-…), optional keep `ANTHROPIC_API_KEY` for Think Tank / fallback brain
- [ ] **Voice loop spec** — one-page description of current STT/TTS/wake/barge-in behavior vs target Grok Voice behavior
- [ ] **Env template** — extend `.env.example` with `XAI_API_KEY`, document that chat/voice paths do not use it yet

### B. Cannot move 1:1

| STARGATE piece | Why |
|---|---|
| Next.js HUD (reactor, deck feeds, deck.css) | Grok Build has TUI, not STARGATE chrome |
| Local Ollama + 1.5B clip path | Grok is cloud inference; different latency/cost model |
| Piper ONNX in browser | xAI Voice replaces TTS; no browser ONNX in Grok stack |
| Web Speech wake word loop | Grok Voice Agent has its own turn detection / VAD |
| Multica vendor + `/api/tools/multica` | Needs PAT + vendor clone; expose as Grok `function` tools or MCP if you rebuild |
| `data/memory.json`, vault PDFs | Operator must export separately |
| Dragon Tradar / Kalshi deck feeds | STARGATE-specific API routes |
| Debug instrumentation | Strip before any external handoff (`127.0.0.1:7335` fetches in brain/chat/voice) |

### C. Operator does on Grok / xAI side

1. **xAI Console** → create `XAI_API_KEY`
2. **Grok Build** (optional, for repo work): `curl -fsSL https://x.ai/cli/install.sh | bash` → `cd stargate && grok`
3. **Grok Voice playground** (xAI console) — test voices + paste compressed system prompt
4. **Custom voice** (optional): upload reference clip via `POST /v1/custom-voices` if STARRA needs a specific timbre
5. **Subscribe / billing** — Grok Build beta historically required SuperGrok; verify current tier on x.ai
6. Decide: voice-only Grok app vs STARGATE Bridge as the client

### D. Ask Cursor to GENERATE (deliverables)

| Deliverable | Contents |
|---|---|
| `docs/GROK_CODE_HANDOFF.md` | This file |
| `docs/STARRA_GROK_SYSTEM.md` | Compressed prompt export from `brain.ts` logic |
| `docs/GROK_VOICE_SESSION.json` | Voice Agent session template |
| `docs/GROK_TOOLS_SCHEMA.json` | Function-tool stubs for ops STARRA might call (status, brief, memory read) |
| Code slice (optional) | Wire `XAI_API_KEY` into `/api/chat` as provider + `/api/realtime` xAI WebSocket proxy |

---

## 5. Recommended path

### **C — Hybrid (recommended)**

```
┌─────────────────────────────────────────────────────────┐
│  STARGATE Bridge (keep)     — HUD, memory, deck, PWA    │
│  Grok Voice Agent API       — duplex STT/TTS (replace    │
│                               Piper/WebSpeech path)       │
│  xAI Chat API (grok-4.5)    — primary brain when keyed  │
│  Grok Build (optional)      — edit stargate repo only   │
│  Ollama (fallback)          — offline / 8GB RAM path      │
└─────────────────────────────────────────────────────────┘
```

**Why:** Book 1 identity lives in the Bridge. Grok supplies what STARGATE lacks today: full-duplex voice + stronger cloud brain. Grok Build stays in the terminal for code work — not as the operator console.

### A — Grok cloud brain + voice, Bridge kept

Same as C but skip Grok Build unless you're developing. Minimal change surface: add xAI provider to chat + voice proxy.

### B — Abandon Bridge, Grok Code only

**Do not.** You lose the HUD, PWA install, deck feeds, memory UI, and canon injection pipeline. Grok Build is not a voice assistant shell.

---

## 6. What to ask Cursor for (copy-paste)

> Export STARRA for Grok handoff:
> 1. Generate `docs/STARRA_GROK_SYSTEM.md` — compressed system prompt from `brain.ts` canon (~8K max, voice-safe).
> 2. Generate `docs/GROK_VOICE_SESSION.json` — xAI Voice Agent session template with instructions + tool stubs.
> 3. Generate `docs/GROK_TOOLS_SCHEMA.json` — function definitions for brief/status/memory.
> 4. Optional: wire `XAI_API_KEY` into `/api/chat` (grok-4.5) and add xAI Realtime proxy replacing OpenAI stub.
> Do not strip debug logs unless I confirm chat works.

---

## 7. Next steps (operator)

1. Read this doc.
2. Get `XAI_API_KEY` from console.x.ai.
3. Ask Cursor for deliverables in §6.
4. Test compressed prompt in xAI Voice playground.
5. Choose hybrid (C): keep `npm run starra`, swap voice path to Grok when proxy lands.
6. Link key in STARGATE Settings → LINK APIS → xAI (Think Tank works today; chat/voice after wire-up).

---

*Traces to Book 1 §7 (voice), Book 3 (runtime brain), `docs/STARRA_CONFERENCE.md` operator-blocked keys.*
