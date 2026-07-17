# STARGATE → Grok / Ara Handoff Pack

**Operator entry point.** This pack exports STARRA personality + ops intent for xAI Grok Build (coding agent) and Grok Voice Agent API (cloud speech-to-speech). Ground truth remains [`STARRA_STARGATE_UNIFIED.md`](../STARRA_STARGATE_UNIFIED.md) at repo root — do not paste the full unified doc into voice sessions.

**Prior consensus:** Grok Build ≠ Bridge host. **Ara** = xAI built-in voice (`voice: "ara"`). Keep the STARGATE Bridge HUD; wire Ara later via Realtime WebSocket.

---

## What this pack is

| File | Role |
|---|---|
| [`HANDOFF.md`](HANDOFF.md) | This index — start here |
| [`GROK_CODE_HANDOFF.md`](GROK_CODE_HANDOFF.md) | Inventory, limits, checklist (extended reference) |
| [`STARRA_GROK_SYSTEM.md`](STARRA_GROK_SYSTEM.md) | Compressed voice-safe system prompt (~6–8K) |
| [`GROK_VOICE_SESSION.json`](GROK_VOICE_SESSION.json) | xAI Voice Agent `session.update` template |
| [`GROK_TOOLS_SCHEMA.json`](GROK_TOOLS_SCHEMA.json) | Function-tool stubs mapping to STARGATE APIs |
| [`API-SURFACE.md`](API-SURFACE.md) | Critical route table + key slots |
| [`VOICE-INTEGRATION.md`](VOICE-INTEGRATION.md) | Realtime Ara swap spec vs current Piper loop |

**Canon sources (copy separately if needed):** `STARRA_SOUL.md`, `STARRA_BRAIN.md`, `STARRA_SOUL_BOOK.md`, `STARRA_GUARDIAN.md`, `docs/MULTICA_DOCTRINE.md`, etc. See §3 in [`GROK_CODE_HANDOFF.md`](GROK_CODE_HANDOFF.md).

---

## How to use

### With Grok Build (repo work)

Grok Build is a **terminal coding agent**, not a voice HUD. It runs in the repo cwd.

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
cd /Users/work/Projects/stargate
grok
```

Point Grok at this pack:

1. Read [`STARRA_GROK_SYSTEM.md`](STARRA_GROK_SYSTEM.md) as project instructions (or paste into `AGENTS.md` excerpt).
2. Use [`API-SURFACE.md`](API-SURFACE.md) when wiring routes.
3. Use [`VOICE-INTEGRATION.md`](VOICE-INTEGRATION.md) when implementing the Realtime proxy.

Grok Build does **not** replace `npm run starra` or the Bridge PWA.

### With xAI Voice playground

1. Create `XAI_API_KEY` at [console.x.ai](https://console.x.ai).
2. Open Voice Agent playground (or connect via WebSocket).
3. Paste contents of [`STARRA_GROK_SYSTEM.md`](STARRA_GROK_SYSTEM.md) into **instructions**, or load [`GROK_VOICE_SESSION.json`](GROK_VOICE_SESSION.json) as your `session.update` payload (replace the `instructions` placeholder with the system file body).
4. Set `voice: "ara"`, `model: grok-voice-latest`.
5. Attach tools from [`GROK_TOOLS_SCHEMA.json`](GROK_TOOLS_SCHEMA.json) if your client supports `function` tools — wire handlers to STARGATE `/api/*` when Bridge is running.

Test operator voice: responses should open with "Copy." only when followed by substance. Never emoji. Never "Sure!".

### With STARGATE Bridge (hybrid — recommended)

Keep the HUD. Swap voice path when Realtime proxy lands:

```
Bridge (HUD, memory, deck) + Grok Voice (duplex STT/TTS) + xAI Chat (brain) + Ollama (offline fallback)
```

See [`VOICE-INTEGRATION.md`](VOICE-INTEGRATION.md) for the swap spec.

---

## Environment matrix

| Variable / slot | Where set | Powers today | Target (Path A) |
|---|---|---|---|
| `XAI_API_KEY` / keys slot `xai` | `.env` or Settings → LINK APIS | Think Tank vote only | Chat brain + Realtime voice |
| `ANTHROPIC_API_KEY` / `anthropic` | `.env` or vault | Full chat + agent tools | Keep as fallback / Think Tank |
| `OPENAI_API_KEY` / `openai` | `.env` or vault | Realtime stub (`/api/realtime`) | Replace with xAI Realtime |
| `OLLAMA_*` | `.env` | Local brain (1.8K prompt clip) | Offline fallback |
| `multica_token` | vault | Multica workspaces/issues | Grok function tools → `/api/tools/multica` |
| Kalshi slots | vault | Dragon Tradar deck | Unchanged |
| `openalice_base_url` | vault | Market intel read | Unchanged |

No secrets in this pack. Never commit `data/keys.json` or `.env.local`.

---

## Path A vs Path B

### Path A — Realtime Ara (recommended)

Full-duplex speech-to-speech via `wss://api.x.ai/v1/realtime?model=grok-voice-latest`.

- Voice: **Ara** (xAI built-in; not Piper Cori).
- Instructions: [`STARRA_GROK_SYSTEM.md`](STARRA_GROK_SYSTEM.md).
- Client: STARGATE Bridge (replace OpenAI Realtime stub) or xAI playground for testing.
- Barge-in: server VAD (`turn_detection.type: server_vad`).
- Tools: [`GROK_TOOLS_SCHEMA.json`](GROK_TOOLS_SCHEMA.json) → STARGATE API handlers.

**Pros:** Low latency, native turn-taking, matches Book 1 full-duplex spec.  
**Cons:** Cloud-only; API cost per minute.

### Path B — TTS-only (interim)

Keep current loop: Web Speech STT → `POST /api/chat` SSE → Piper/Web Speech TTS.

- No Realtime WebSocket.
- xAI Chat API (`grok-4.5` / `grok-3-mini`) as text brain when wired.
- Ara voice only if you add a separate xAI TTS call (not in Bridge today).

**Pros:** Minimal code change; works offline for STT/TTS fallbacks.  
**Cons:** Higher latency; not true duplex; wake-word loop stays browser-side.

---

## What cannot move 1:1

| STARGATE piece | Why |
|---|---|
| Next.js HUD (reactor, deck, `deck.css`) | Grok Build is TUI, not STARGATE chrome |
| Piper ONNX in browser | xAI Voice replaces TTS |
| Web Speech wake word ("starra") | Grok Voice has its own VAD / turn detection |
| Local Ollama 1.5B clip path | Different latency/cost; Grok is cloud |
| `data/memory.json`, vault PDFs | Export separately; not in this pack |
| Multica vendor clone | Needs PAT + `vendor/multica`; expose via tools/MCP |
| Dragon Tradar / Kalshi feeds | STARGATE-specific routes |
| Debug instrumentation | Keep in repo; strip only for external distribution |

---

## Quick start (operator)

1. Read this file.
2. Get `XAI_API_KEY`.
3. Test [`STARRA_GROK_SYSTEM.md`](STARRA_GROK_SYSTEM.md) in xAI Voice playground with voice **Ara**.
4. Link xAI in Bridge Settings → LINK APIS (Think Tank works today).
5. Choose hybrid: keep `npm run starra`, plan Realtime swap per [`VOICE-INTEGRATION.md`](VOICE-INTEGRATION.md).
6. Optional: `cd stargate && grok` for repo edits only.

---

*Traces to Book 1 §7 (voice), Book 3 (runtime brain), [`GROK_CODE_HANDOFF.md`](GROK_CODE_HANDOFF.md).*
