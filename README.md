# STARGATE

**STARGATE** is a personal, voice-first operator HUD — a JARVIS-style command deck for STARRA LLC.
It's a dark-only Next.js PWA that fronts **STARRA**, an AI operator/companion persona, and wires her to
a provider-switchable brain, a full-duplex voice call with an animated face, live prediction-market
data, a multi-model "think tank," on-disk memory + document vault, and a set of gated operator tools.

Canon lives in `STARRA_STARGATE_UNIFIED.md` (Book 1 Design Spec · Book 2 Master Doc · Book 3 Brain);
repo rules are in `CLAUDE.md` (dark-only, operator voice, "verify — never guess").

---

## ⭐ Call STARRA — the seamless voice call

One button opens a full-screen, Grok/Ani-style call with **her face and her voice**, in the browser:

- **One entry, everywhere.** The composer's call button, tapping the reactor eye, and the mobile hero
  badge all open the *same* call. (There used to be a redundant mic-vs-call split and a separate native
  window — both retired.)
- **Her face, in-browser.** Two silent portrait clips (`public/avatar/starra-{idle,talking}.mp4`)
  crossfade on call state: a breathing **idle** face while she listens, her warm **talking** loop plus a
  magenta pulse while she speaks. Rendered client-side → zero lag, `$0`, no separate window. Only the
  talking clip decodes while she's actually speaking (light on older hardware).
- **Real-time voice via xAI Realtime.** `POST /api/realtime` mints a short-lived client secret (voice
  **"ara"**) so the browser opens the xAI Realtime WebSocket directly — the raw `XAI_API_KEY` never
  reaches the client. STT + LLM + TTS all run in xAI's cloud; the laptop only streams PCM audio in/out.
- **Feels alive.** Server VAD + local RMS **barge-in** (cut her off the instant you talk), live YOU/STARRA
  transcript, mute, end-call, and an in-overlay cost meter.
- **Honest failures.** A blocked mic now says **"Microphone blocked"** with the exact fix, not a
  misleading "voice link down."

> The face + UI are free either way; the xAI Realtime voice is the one metered piece (`voiceCost.ts`
> tracks minutes at $0.05/min in the overlay). A separate free path — wake-word STT + free brain +
> local TTS — also exists (below).

---

## The brain

Provider-switchable, assembled per request in `src/app/api/chat/route.ts` + `src/lib/brain.ts`:

| Provider | Role | Notes |
|---|---|---|
| **Kimi (Groq)** | free daily driver | `moonshotai/kimi-k2-instruct-0905`, **tiered prompt** kept under the ~8K cap |
| **Grok (xAI)** | opt-in, full canon | `grok-4.5`, uncapped canon + tool loop |
| **Anthropic (Claude)** | keyed fallback | can run a bounded agent tool-loop |
| **Ollama** | local/offline | `qwen2.5:1.5b` default, tuned for an 8GB Mac |

- **`LLM_PROVIDER=auto`** prefers keyed Kimi → Anthropic → local Ollama → an offline canned reply.
- **Grounding** is assembled fresh each turn: Tier-1 business context, tiered memory, vault facts,
  Obsidian notes, a repomix preview, live weather (wttr.in), DuckDuckGo web search, and a security
  threat brief — then streamed as SSE.
- **Prompt discipline:** a stable/volatile split powers Anthropic prompt caching; the **tiered builder**
  keeps Groq/Kimi under budget with an always-on identity core + keyword-gated doctrines, and *reports*
  what it deferred instead of silently cutting it.
- **STARRA's persona** is single-sourced: `src/lib/persona.ts` (`STARRA_VOICE_PERSONA`) is the distilled
  spoken character shared by the voice call and the external avatar app; the chat brain layers the
  richer file-based canon on top so she's one continuous character across every surface.

**Think Tank** (`lib/tank.ts`) — every linked model (local Ollama, Claude Haiku, Gemini Flash,
GPT-4o-mini, Grok-3-mini) votes LONG/SHORT/HOLD with a confidence on the top watched market; unlinked
models show a "LINK" chip. **Dragon Tradar** (`/api/dragon` + `lib/kalshi.ts`) is a live Kalshi
prediction-market watchlist (BTC/Fed/CPI/ETH) plus an RSA-signed authenticated balance/positions view
when Kalshi keys are linked.

---

## Voice

- **Realtime call** — `useVoiceCall.ts` (full-duplex xAI Realtime, barge-in, transcript, metered).
- **Wake-word / push-to-talk** — `useVoiceLoop.ts` + `wake-word.ts`: say **"starra"**, press **⌥+Space**,
  or tap the badge; the recognized command routes through the shared chat. Uses browser Web Speech and
  suspends itself while the full-duplex call owns the mic.
- **TTS fallback chain** — `speak.ts`: **Ara** (xAI via `/api/tts`, key stays server-side) → **Piper**
  (in-browser, when model files are present) → **Web Speech**. Ara is the default.

---

## The deck (HUD)

`src/components/bridge/Bridge.tsx` renders two layouts from one component:

- **Desktop command deck** — a three-column HUD: Business Snap / Dragon Tradar / Think Tank / Site
  Telemetry on the left; the **reactor eye** + operator console in the center; Agent Ops feed /
  Proposals / Ventures on the right. Boot sequence, cinematic badge/wordmark videos, an ECO low-power
  toggle, and live polling of `/api/vitals`, `/api/dragon`, `/api/tank`, `/api/telemetry`,
  `/api/proposals`, `/api/feed`.
- **Mobile, voice-first** — the hero badge is the primary action (opens the call); TODAY / OPS / MEM /
  LINKS tabs below.
- **Reactor eye** — a cybernetic star-eye that tracks your face (MediaPipe gaze, "EYE CAM") or follows
  the cursor, and reacts to voice/HUD state. Tapping its core starts a call.

All motion respects `prefers-reduced-motion` and a low-power mode. Fonts split by role: Orbitron (HUD
chrome), Rajdhani (body), JetBrains Mono (telemetry).

---

## Memory, Vault & Obsidian

- **Memory** (`lib/memory/store.ts`) — JSON-backed three tiers: working (~10 exchanges) → rolling
  summaries → archival, all redacted, no LLM needed. Browse at `/memory`.
- **Vault** (`lib/vault/store.ts`, `/vault`) — upload text/md/csv/**pdf** (20 MB cap) → fact extraction +
  redaction; facts are injected into prompts fenced as untrusted content.
- **Obsidian** (`lib/obsidian/*`, `/api/tools/obsidian`) — full CRUD over a local Obsidian markdown
  vault: list/read/search, wikilink resolution, and write/delete behind a destructive-confirm gate.

---

## Operator tools (`/tools`)

Each backs a `/api/tools/*` route. Several **stage/queue** work for an external agent rather than
executing end-to-end in the deck — flagged below.

- **Repomix** — pack the repo to `data/packs/` (`npm run pack`, or console: `pack the repo`). *Real.*
- **Prompt structure** — distill a prompt-leak corpus into reusable structure. *Real.*
- **Multica** — create/track issues against the Multica agent-board cloud API (needs a token). *Real.*
- **OpenAlice** — read/plan bridge to an external market-intel runtime; trade **intents stage behind a
  confirm token** and are never auto-executed. *Real, external runtime.*
- **OpenMontage** — queue video briefs to `data/openmontage-briefs/` for an external render agent;
  STARGATE writes the brief, it does **not** render. *Queue is real; rendering is out-of-band.*
- **Funding intel** — a curated static registry of funding sources. *Reference data, not a live API.*

---

## Security & gating

Wired throughout chat, shell, and tools (`lib/security/*`):

- **command-gate** — destructive shell commands are held until you reply `confirm <token>`.
- **trade-gate** — trade intents require explicit confirmation; nothing auto-executes.
- **fencing** — untrusted content (vault/web/Obsidian) is fenced before it reaches the model.
- **redact** — secrets are scrubbed from outputs and logs.
- **team** — inbound input is threat-scanned.
- **shell** (`lib/tools/shell.ts`) — a real gated executor (30 s timeout, 1 MB cap, redacted, localhost-only).

---

## Auth

Single shared-password gate (`lib/auth.ts` + `middleware.ts`): the password (server env only) is compared
constant-time; success sets an **HMAC-SHA256-signed, httpOnly** session cookie (30-day TTL). Middleware
guards every non-static route — unauthenticated APIs get 401, pages redirect to `/login?next=`. If no
password is configured the gate stays **off** so the deck can't lock itself out. Web Crypto throughout,
so the same helpers run in Edge middleware and Node routes. The login screen has a show/hide reveal.

---

## Desktop app & the talking avatar

- **Native-feeling app** — `~/Applications/STARRA.app` launches the deck in a chromeless Chrome
  app-window with a dedicated profile (modern engine — an earlier WKWebView build choked on modern
  CSS/JS on macOS 12, so it was retired; `desktop/main.swift` kept for reference). The launcher pre-grants
  the deck's microphone permission for its profile.
- **Talking avatar (optional, external)** — `avatar/launch` + `avatar/stop` (localhost-only) drive a
  separate Python app at `~/Projects/starra-avatar` (a photoreal, word-matched-lips "cinematic" mode via
  a free Colab GPU). This is *not* the seamless in-browser call; it's a heavier, higher-fidelity option.

---

## Tech stack

**Next.js 15.5** (App Router, Turbopack) · **React 19** · **TypeScript 5** · **Tailwind CSS 4** ·
`@anthropic-ai/sdk` · xAI Realtime (voice) · in-browser **Piper TTS** (`onnxruntime-web`) ·
**MediaPipe** face/gaze · `pdf-parse` (vault) · `zod` (validation) · `repomix`. Local JSON store under
`data/` (Supabase-ready). No database required to run.

---

## Run

```bash
git clone https://github.com/ppt615-spec/stargate.git && cd stargate
cp .env.example .env.local     # add keys you want: XAI_API_KEY (voice/grok), ANTHROPIC_API_KEY, GROQ_API_KEY, STARRA_PASSWORD…
npm install
npm run starra:install         # once — puts `starra` on PATH + builds STARRA.app
starra                         # starts Ollama + the deck, opens the HUD
```

Or just `npm run dev` and open <http://localhost:3000>.
Wake her by saying **"starra"** or pressing **⌥+Space**; press the call button for the full voice call.

Handy scripts: `starra up | open | stop | status | install` · `npm run typecheck` · `npm run pack`
(repomix) · `npm run voice:download` (Piper models) · `npm run face:download` (MediaPipe).

### Configuration highlights (`.env.local`)
- `LLM_PROVIDER` — `auto` (default) · `kimi` · `grok` · `anthropic` · `ollama`
- `XAI_API_KEY` — enables the realtime voice call + Ara TTS + opt-in Grok brain
- `GROQ_API_KEY` / `ANTHROPIC_API_KEY` — the free daily driver and the keyed fallback
- `STARRA_PASSWORD` — turns on the auth gate (leave unset to run open, locally)

---

## Feature status legend

- **Fully working:** the voice call (+ wake-word + TTS), the chat brain + provider switching, memory,
  vault, Obsidian, Dragon Tradar, Think Tank, telemetry, proposals, keys, auth, repomix, prompts,
  metrics/feed, the HUD.
- **Real but external-dependent (stage/queue, not end-to-end in-app):** OpenMontage, OpenAlice, Multica,
  the Python talking avatar.
- **Reference data:** Funding intel (static registry).
- **Demo/placeholder:** `/connectors` (Connect buttons are disabled until keys exist), `/pipeline`
  (hardcoded seed cards, localStorage-only).

---

*Personal project for STARRA LLC. Dark-only. Operator voice. She is STARGATE.*

---

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 STARRA LLC.
