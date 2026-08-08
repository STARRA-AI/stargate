# STARGATE — repo rules

You are building STARGATE, defined in `STARRA_STARGATE_UNIFIED.md` at the repo
root. Always ground answers in that file. Never invent brand tone, colors, or
copy — pull them from Book 1 (Design Spec). Never invent business facts,
vendors, or numbers — pull them from Book 2 (Master Doc). Runtime system
prompt = Book 3.

## Hard rules
- **VERIFY, NEVER GUESS.** Do NOT give Classic information that has not been
  verified from a source (the code, real command output, docs, or a live check).
  Stop guessing. Stop assuming. Do not claim something works / is fixed / is true
  unless it has been proven; if it can't be verified, say so explicitly. Foresee
  side effects before acting, not after.
- Dark-only. Colors are CSS vars `--void`, `--chrome`, `--purple`, `--magenta`. No shadcn defaults.
- Operator voice: "Copy." not "Sure!". No emojis in UI copy.
- Mobile is voice-first, badge is hero. Desktop is command deck.
- Chat is a Grok-style message column: user turns sit in rounded `--void-2`
  containers with a thin `--border`; STARRA replies render as clean markdown
  (no bubble, `--chrome` text) and stream with a blinking `--magenta` caret.
  Same tokens/fonts — the galaxy/purple aesthetic is unchanged. (Supersedes the
  retired "no chatbot bubbles / stream into the console readout" rule.)
- Every feature must trace to a section in the unified doc. If it doesn't, ask.

## Stack (current)
- Next.js / TypeScript / React app under `src/`; dev server on `:3000`. This is
  the live build — the retired pywebview/Flask STARGATE is not this codebase.
- Brain: provider-switchable via `LLM_PROVIDER` (`kimi`/`grok`/`anthropic`/`ollama`).
  `freellm` is REMOVED from the hosted set (superseded below). Grok (xAI) is
  now the standing daily driver with full canon; Kimi/Groq is the emergency
  fallback only; local Ollama is the offline fallback.
- **HER BRAIN IS xAI GROK-4.5 — LOCKED (Classic's ONE BRAIN order, 2026-08-06,
  supersedes the 2026-08-04 Kimi-locked order below): ONE brain for the
  operator console, the deck chat, AND the live call — one composed prompt
  (`buildOneStarraPrompt`), byte-identical on every surface. The free
  Groq/llama-3.3-70b-versatile slot (`LLM_PROVIDER=kimi`) is the EMERGENCY
  LANE only (`STARRA_EMERGENCY_LANE=1`) — the monthly ceiling does NOT force
  it, she stays grok-4.5 at the ceiling and just says so (see
  docs/ONE_BRAIN.md). Always announced, never silent. `freellm` is removed
  from the hosted set. Do not flip any of this without his say-so.
  [SUPERSEDED, kept for history — Classic's 2026-08-04 order: "HER BRAIN IS
  KIMI — LOCKED: ONE brain for chat AND the live call — the free Groq/Kimi
  slot (`LLM_PROVIDER=kimi`). xAI provides ONLY her voice/ears (Ara TTS; the
  call's Eve voice + transcribe). On the call this runs via
  turn_detection:null + client commit + force_message (see `CallBrain` in
  src/lib/voice/useVoiceCall.ts); `STARRA_CALL_BRAIN=grok` is the emergency
  rollback only. Do not flip either without his say-so."]**
- **PRIVATE LANE — additive, local-only (docs/PRIVATE_LANE.md):** a `private
  …` turn on the deck or the call runs entirely through self-hosted
  private-gpt on local Ollama; it must never route through Kimi, Grok,
  FreeLLM, or Anthropic. **There is also a PRIVATE CALL:** the call overlay's
  engine selector (NORMAL | PRIVATE) — PRIVATE runs ears (whisper.cpp
  `127.0.0.1:8178`), brain (private-gpt `127.0.0.1:8080`) and mouth (Piper in
  the tab) entirely on this Mac, so a SPOKEN private ask is safe there.
  **NORMAL is unchanged** — xAI socket, Eve's voice, Kimi brain, byte for byte.
  Retrieval on a private turn now runs only when documents are actually
  ingested (~90% of a private turn's latency was prompt-eval on a forced RAG
  prompt); empty collection = plain local completion, same privacy.
- Voice: Eve (xAI) — her one voice, same as the live call; Piper → Web Speech
  are offline fallbacks only. **Local (Piper) default = `en_GB-cori-medium`**
  — the same Cori, faster tier: `-high` measured RTF 3.14 (slower than speech)
  vs medium's 0.39 on this Intel Mac. `-high` stays available via
  `stargate.localVoice` / `NEXT_PUBLIC_STARRA_LOCAL_VOICE`.

## Skills
- `starra-design` — visual/motion doctrine; use when changing the HUD's look, layout, or motion.
- `multica-ops` — operating the Multica agent-board integration.

## EXECUTION RULE — /starra-loop is the DEFAULT, not the escalation

**Classic's standing order, 2026-08-07:** *"make sure that any task moving
forward is done in this loop unless it's you just simply asking me a question."*

Every task runs through `/starra-loop` (Fable CEO -> Opus executives -> Sonnet
workers -> board sign-off). The ONLY exception is a turn where Claude is purely
asking Classic a question and doing no work.

Not exceptions — these still go through the loop:
- "small" or "one-line" changes
- debugging
- config edits
- anything that feels faster done inline

Sizing still applies (charter §6): the CEO picks solo-and-verify, one division,
or the full org from the real scope. Running the loop does not mean convening a
board to change a light bulb — it means the decision about how much org to use
is made by the loop, not skipped.
