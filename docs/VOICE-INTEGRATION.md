# Voice Integration — xAI Realtime (Ara) vs Current Loop

Spec for swapping STARGATE's voice path from **Web Speech STT + Piper TTS + OpenAI Realtime stub** to **xAI Grok Voice Agent API** with voice **Ara**. Traces to Book 1 §7 (full-duplex, barge-in) and `docs/GROK_CODE_HANDOFF.md`.

---

## Current architecture (today)

```
Operator speaks
    │
    ├─ Wake: "starra" (continuous Web Speech) or ⌥+Space / badge tap
    │
    ▼
useVoiceLoop.ts
    │
    ├─ POST /api/realtime  →  OpenAI session OR { mode: "stub" }  (not used for audio yet)
    │
    ├─ Web Speech STT (command recog, single utterance)
    │
    ▼
POST /api/chat  (SSE stream)
    │
    ├─ brain.ts canon + memory/vault/tier-1
    ├─ Provider: Ollama (1.8K clip + LOCAL_VOICE_TAIL) or Anthropic
    │
    ▼
speak.ts
    │
    ├─ Piper Cori ONNX (browser) — preferred
    └─ Web Speech synthesis — fallback
```

**Files:**

| File | Role |
|---|---|
| `src/lib/voice/useVoiceLoop.ts` | Wake word, hotkey, STT, chat dispatch, TTS trigger |
| `src/lib/voice/speak.ts` | Piper → Web Speech TTS |
| `src/lib/voice/wake-word.ts` | "starra" matcher |
| `src/lib/voice/piper-speak.ts` | ONNX loader |
| `src/app/api/realtime/route.ts` | OpenAI Realtime client secret only |
| `src/app/api/chat/route.ts` | Text brain + `LOCAL_VOICE_TAIL` copy guard |

**Gaps vs Book 1 spec:**

- Not true full-duplex — STT runs after TTS finishes (barge-in partial via `onspeechstart` cancel).
- Realtime route exists but loop ignores live session; always falls through to Web Speech + chat.
- Local 1.5B path clips canon to ~1.8K chars — voice personality thin offline.
- TTS is Piper Cori, not Ara.

---

## Target architecture (Path A — Realtime Ara)

```
Operator speaks
    │
    ▼
Bridge Realtime client (new or extended useVoiceLoop)
    │
    ├─ POST /api/realtime  →  xAI client_secret (ephemeral)
    │
    ├─ WebSocket wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-1.0
    │     (PINNED — ?model= on the socket is what selects the model; a bare URL
    │      defaults to the grok-voice-latest alias, which xAI repoints to 2.0
    │      on 2026-08-05 at $0.08/min vs $0.05/min. docs.x.ai/docs/models,
    │      fetched 2026-07-31.)
    │     Authorization: Bearer <ephemeral OR server-side key in dev>
    │
    ├─ session.update { voice: "eve", instructions: STARRA_GROK_SYSTEM, tools: [...] }
    │
    ├─ input_audio_buffer.append (PCM 24kHz base64)
    │
    ├─ server_vad turn detection + barge-in (native)
    │
    ├─ function_call → STARGATE /api/* handlers (GROK_TOOLS_SCHEMA.json)
    │
    └─ response.output_audio.delta → Web Audio playback
```

**Brain split options:**

| Mode | Brain | Voice |
|---|---|---|
| **A1 — Voice-native** | Instructions in Realtime session (`STARRA_GROK_SYSTEM.md`) + tool results | Ara in-session |
| **A2 — Hybrid** | Realtime for audio only; tool calls hit `/api/chat` for heavy canon | Ara in-session |

Recommend **A1** for latency; inject tier-1/memory via tool calls or periodic context push.

---

## `/api/realtime` swap spec

**Current** (`src/app/api/realtime/route.ts`):

- POST to `https://api.openai.com/v1/realtime/sessions`
- Body: `{ model, voice: "ash" }`
- Env: `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`

**Target:**

```typescript
// Pseudocode — implement when operator approves wire-up
const key = process.env.XAI_API_KEY ?? (await getKey("xai"));
const model = process.env.XAI_REALTIME_MODEL ?? "grok-voice-think-fast-1.0";

POST https://api.x.ai/v1/realtime/client_secrets
Authorization: Bearer ${key}
Body: {
  model,
  voice: "eve",
  instructions: "<loaded from STARRA_GROK_SYSTEM or truncated>",
  // optional: tools from GROK_TOOLS_SCHEMA
}

Return: { mode: "live", client_secret, model, voice: "eve", url: "wss://api.x.ai/v1/realtime?model=<model>" }
```

**Env additions (document in `.env.example`):**

```
XAI_API_KEY=
XAI_REALTIME_MODEL=grok-voice-think-fast-1.0
```

Keep OpenAI path behind feature flag or remove after xAI validated.

---

## Client changes (`useVoiceLoop.ts`)

| Step | Change |
|---|---|
| 1 | On wake, if `/api/realtime` returns `mode: "live"` with xAI secret, open WebSocket instead of Web Speech command recog |
| 2 | Stream mic PCM 24kHz to `input_audio_buffer.append` |
| 3 | Play `response.output_audio.delta` via AudioContext |
| 4 | On `response.function_call_arguments.done`, fetch mapped `/api/*` route, return `conversation.item.create` with output |
| 5 | Fallback: if stub/error, keep existing Web Speech → chat → Piper path (Path B) |
| 6 | HUD states: map xAI events to existing `hudState` (`listening`, `thinking`, `speaking`, etc.) |

**Wake word:** Grok server VAD replaces continuous "starra" listener during active Realtime session. Keep wake word for session *start* only, or map to push-to-talk until xAI supports custom wake.

---

## Path B — TTS-only interim (no Realtime)

Minimal change if xAI key not ready:

1. Wire `XAI_API_KEY` into `/api/chat` as provider (`grok-4.5` / `grok-3-mini`).
2. Keep Web Speech STT + existing TTS.
3. Optional: call xAI REST TTS with `voice: ara` in `speak.ts` when keyed (separate from Realtime).

Higher latency; no native barge-in. Acceptable for desk testing.

---

## OpenAI Realtime compatibility

xAI Voice Agent API is **OpenAI Realtime–compatible**. Event types align:

| Event | Purpose |
|---|---|
| `session.update` / `session.updated` | Config voice, instructions, tools |
| `input_audio_buffer.append` | Send mic audio |
| `input_audio_buffer.commit` | End utterance (if not using server VAD) |
| `response.output_audio.delta` | Receive audio chunks |
| `response.function_call_arguments.delta` | Tool invocation |
| `conversation.item.create` | Return tool output |

Reference session template: [`GROK_VOICE_SESSION.json`](GROK_VOICE_SESSION.json).

---

## Testing checklist

- [ ] xAI playground: paste [`STARRA_GROK_SYSTEM.md`](STARRA_GROK_SYSTEM.md), voice Ara, verify "Copy." + substance pattern
- [ ] `/api/realtime` returns `mode: "live"` with xAI secret when keyed
- [ ] WebSocket connects; `session.updated` received
- [ ] Duplex audio: speak → hear Ara reply < 1s perceived
- [ ] Barge-in: interrupt mid-utterance
- [ ] Tool call: `stargate_status` hits Bridge and speaks result
- [ ] Fallback: stub mode still runs Piper loop
- [ ] No raw `XAI_API_KEY` in browser bundle (ephemeral token only)

---

## What stays unchanged

- Bridge HUD, deck feeds, memory UI
- `brain.ts` canon pipeline for `/api/chat` text path
- Debug instrumentation (do not strip unless operator confirms)
- Piper/Web Speech as **fallback** when Realtime unavailable

---

*Operator index: [`HANDOFF.md`](HANDOFF.md). API routes: [`API-SURFACE.md`](API-SURFACE.md).*
