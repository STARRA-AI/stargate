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
- Brain: provider-switchable via `LLM_PROVIDER` (`kimi`/`grok`/`anthropic`/`ollama`/`freellm`).
  Kimi/Groq is the free daily driver (tiered prompt under the 8K cap); Grok
  (xAI) opt-in with full canon; local Ollama is the offline fallback.
- **HER BRAIN IS KIMI — LOCKED (Classic's order, 2026-08-04): ONE brain for
  chat AND the live call — the free Groq/Kimi slot (`LLM_PROVIDER=kimi`). xAI
  provides ONLY her voice/ears (Ara TTS; the call's Eve voice + transcribe).
  On the call this runs via turn_detection:null + client commit + force_message
  (see `CallBrain` in src/lib/voice/useVoiceCall.ts); `STARRA_CALL_BRAIN=grok`
  is the emergency rollback only. Do not flip either without his say-so.**
- **PRIVATE LANE — additive, local-only (docs/PRIVATE_LANE.md):** a `private
  …` turn on the deck or the call runs entirely through self-hosted
  private-gpt on local Ollama; it must never route through Kimi, Grok,
  FreeLLM, or Anthropic.
- Voice: Eve (xAI) — her one voice, same as the live call; Piper → Web Speech
  are offline fallbacks only.

## Skills
- `starra-design` — visual/motion doctrine; use when changing the HUD's look, layout, or motion.
- `multica-ops` — operating the Multica agent-board integration.
