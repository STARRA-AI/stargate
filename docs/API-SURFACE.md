# STARGATE API Surface

Critical routes for Grok handoff, Voice tool wiring, and Bridge integration. Base URL: `http://127.0.0.1:3000` when running `npm run starra` / `next dev`.

Full canon: [`STARRA_STARGATE_UNIFIED.md`](../STARRA_STARGATE_UNIFIED.md). Tool schemas: [`GROK_TOOLS_SCHEMA.json`](GROK_TOOLS_SCHEMA.json).

---

## Core operator

| Method | Route | Purpose | Auth / keys |
|---|---|---|---|
| `POST` | `/api/chat` | Main brain — SSE stream. Assembles canon from `brain.ts` + memory/vault/tier-1. | `ANTHROPIC_API_KEY` or Ollama (`OLLAMA_*`) |
| `GET` | `/api/llm/status` | Provider, Ollama health, soul/brain load stats | None |
| `GET` | `/api/context` | Tier-1 goals/projects/tasks + memory snap | None |
| `PUT` | `/api/context` | Save Tier-1 (Zod `Tier1Schema`) | Operator gate recommended |
| `GET` | `/api/memory` | Full memory store | None |
| `GET` | `/api/memory?q=` | Filtered memory search | None |
| `POST` | `/api/realtime` | Realtime session bootstrap | `OPENAI_API_KEY` today → target `XAI_API_KEY` |
| `GET` | `/api/keys` | Key slot status (masked) | None |
| `POST` | `/api/keys` | Link/unlink API keys to vault | Writes `data/keys.json` |
| `GET` | `/api/feed` | Deck feed lines | None |
| `POST` | `/api/feed` | Push feed line `{ tag?, text }` | None |
| `GET` | `/api/vitals` | HUD vitals strip | None |
| `GET` | `/api/telemetry` | Site telemetry (Dragon stats when keyed) | `dragontradar_*` slots |

---

## Think Tank & markets

| Method | Route | Purpose | Auth / keys |
|---|---|---|---|
| `GET` | `/api/tank` | Multi-model Think Tank vote on top Kalshi market | `anthropic`, `openai`, `gemini`, **`xai`** |
| `GET` | `/api/dragon` | Kalshi watchlist + portfolio for Dragon deck | `kalshi_key_id`, `kalshi_private_key` |
| `GET` | `/api/proposals` | Operator proposals queue | None |
| `POST` | `/api/proposals` | Submit proposal | None |

**Note:** `xai` slot powers Think Tank votes. It also powers the primary chat
brain when `LLM_PROVIDER=grok` (opt-in only — `auto` selects Kimi, not Grok) —
`/api/chat` streams via `streamHosted({ provider: "grok" })`. Duplex Realtime
voice IS wired (voice "ara") via `/api/realtime` + the `useVoiceCall` hook /
call overlay, pending a live mic pass; Ara (xAI TTS) voice output is wired
separately via `/api/tts`.

---

## Tools surface

| Method | Route | Query / body | Keys |
|---|---|---|---|
| `GET` | `/api/tools/multica` | `?action=status\|workspaces\|issues\|agents` | `multica_token`, optional `multica_base_url` |
| `POST` | `/api/tools/multica` | `{ mode: "issue"\|"quick", ... }` | `multica_token` |
| `GET` | `/api/tools/repomix` | Pack preview | None |
| `POST` | `/api/tools/repomix` | `{ target? }` — runs Repomix | None |
| `GET` | `/api/tools/openmontage` | Queue status | None |
| `POST` | `/api/tools/openmontage` | `{ topic, brief?, pipeline? }` or `{ action: "mark_done", id }` | None (local vendor) |
| `GET` | `/api/tools/openalice` | `?action=status\|issues\|inbox` | `openalice_base_url` |
| `POST` | `/api/tools/openalice` | Bridge actions | `openalice_base_url` |
| `GET` | `/api/tools/obsidian` | Vault read/search | Local vault path |
| `POST` | `/api/tools/obsidian` | Vault write (gated) | Local vault path |
| `GET` | `/api/tools/funding` | Funding playbook readout | None |
| `GET` | `/api/tools/prompts` | Prompt structure status | None |
| `POST` | `/api/tools/prompts` | Re-distill prompt patterns | None |

---

## Vault & uploads

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/vault/upload` | Vault listing |
| `POST` | `/api/vault/upload` | PDF upload to vault |

---

## Key slots (`/api/keys` → `src/lib/keys.ts`)

| Slot ID | Label | Powers |
|---|---|---|
| `anthropic` | Anthropic (Claude) | Think Tank · premium brain |
| `openai` | OpenAI (GPT) | Think Tank · Realtime stub |
| `gemini` | Google (Gemini) | Think Tank |
| **`xai`** | **xAI (Grok)** | **Think Tank · chat brain (`LLM_PROVIDER=grok`) · Ara TTS** |
| `kalshi_key_id` | Kalshi API key ID | Dragon Tradar |
| `kalshi_private_key` | Kalshi RSA private key | Dragon Tradar |
| `dragontradar_url` | Dragon stats URL | Site telemetry |
| `dragontradar_token` | Dragon stats token | Site telemetry |
| `multica_token` | Multica PAT | Workspaces · issues · agents |
| `multica_base_url` | Multica API base | Cloud or self-host |
| `github_token` | GitHub token | Future funding lookup |
| `open_collective_api_key` | Open Collective | Future funder finder |
| `aiassist_api_key` | AiAssist | Future angel scans |
| `openalice_base_url` | OpenAlice runtime | Market intel |
| `openalice_alpaca_key_id` | Alpaca key ID | Broker gate (dormant) |
| `openalice_alpaca_secret_key` | Alpaca secret | Broker gate (dormant) |

Env fallbacks: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, **`XAI_API_KEY`**, `MULTICA_TOKEN`, etc.

---

## Environment variables (`.env.example`)

| Variable | Default | Role |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Cloud brain + agent |
| `OPENAI_API_KEY` | — | Realtime stub |
| `OPENAI_REALTIME_MODEL` | `gpt-4o-realtime-preview` | OpenAI Realtime model |
| **`XAI_API_KEY`** | — | **Live: chat (`LLM_PROVIDER=grok`) + Ara TTS + Realtime duplex voice call (pending live mic pass)** |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Local brain |
| `OLLAMA_MODEL` | `qwen2.5:1.5b` | Local model |
| `LLM_PROVIDER` | `auto` | `auto` \| `ollama` \| `anthropic` \| `kimi` \| `grok` |
| `OLLAMA_PRIORITY` | `1` | Prefer Ollama when set |

---

## Grok tool → route quick map

| Grok function (see schema) | Route |
|---|---|
| `stargate_status` | `GET /api/llm/status` + `GET /api/context` |
| `stargate_memory_search` | `GET /api/memory?q=` |
| `stargate_queue_brief` | `POST /api/tools/openmontage` |
| `stargate_multica_status` | `GET /api/tools/multica?action=status` |
| `stargate_dragon_snapshot` | `GET /api/dragon` |
| `stargate_think_tank` | `GET /api/tank` |
| `stargate_chat` | `POST /api/chat` |

---

## Not exposed as HTTP (in-process only)

| Layer | Location |
|---|---|
| Canon assembly | `src/lib/brain.ts` → `loadStableSystemPrompt()` |
| Voice loop | `src/lib/voice/useVoiceLoop.ts` |
| TTS | `src/lib/voice/speak.ts` (Piper Cori → Web Speech) |
| Memory store | `data/memory.json` |
| Key vault file | `data/keys.json` (gitignored) |

---

*See [`VOICE-INTEGRATION.md`](VOICE-INTEGRATION.md) for Realtime swap. See [`HANDOFF.md`](HANDOFF.md) for operator workflow.*
