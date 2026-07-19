# STARGATE — repo rules

You are building STARGATE, defined in `STARRA_STARGATE_UNIFIED.md` at the repo
root. Always ground answers in that file. Never invent brand tone, colors, or
copy — pull them from Book 1 (Design Spec). Never invent business facts,
vendors, or numbers — pull them from Book 2 (Master Doc). Runtime system
prompt = Book 3.

## Hard rules
- Dark-only. Colors are CSS vars `--void`, `--chrome`, `--purple`, `--magenta`. No shadcn defaults.
- Operator voice: "Copy." not "Sure!". No emojis in UI copy.
- Mobile is voice-first, badge is hero. Desktop is command deck.
- No chatbot bubbles. Responses stream into the console readout.
- Every feature must trace to a section in the unified doc. If it doesn't, ask.

## Stack (current)
- Next.js / TypeScript / React app under `src/`; dev server on `:3000`. This is
  the live build — the retired pywebview/Flask STARGATE is not this codebase.
- Brain: provider-switchable via `LLM_PROVIDER` (`kimi`/`grok`/`anthropic`/`ollama`).
  Kimi/Groq is the free daily driver (tiered prompt under the 8K cap); Grok
  (xAI) opt-in with full canon; local Ollama is the offline fallback.
- Voice: Ara (xAI TTS) primary, Piper → Web Speech fallback.

## Skills
- `starra-design` — visual/motion doctrine; use when changing the HUD's look, layout, or motion.
- `multica-ops` — operating the Multica agent-board integration.
