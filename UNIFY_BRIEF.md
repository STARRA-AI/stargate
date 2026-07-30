# ONE PERSON — STARRA unification brief

Classic's order, verbatim (2026-07-30): "it all needs be the same person same voice i
already have set up on the CALL. same continuous chat." One person, one voice, one
continuous conversation, across every surface. The CALL is the reference — everything
else conforms to it.

## The four fractures (verified from source 2026-07-30)

1. **Different person per surface.** The call sends `STARRA_VOICE_PERSONA`
   (`src/lib/persona.ts`, wired at `src/lib/voice/useVoiceCall.ts:48`, sent in
   `session.update` at `:1218`). The chat brain builds its OWN ~7.3K tiered prompt from
   personality files (`src/lib/brain.ts:451`, cache at `:167-223`) and swaps content by
   `LLM_PROVIDER` (Kimi/Groq tiered vs Grok full canon — repo `CLAUDE.md`). Two prompt
   assemblies = two people.
2. **Different voice per surface.** The call speaks as xAI Realtime voice **"eve"**
   (`src/app/api/realtime/route.ts:59,97`). Typed replies — deck chat AND chat during a
   live call — are voiced by `src/lib/voice/speak.ts`: Ara (xAI TTS) → Piper → Web
   Speech, with `src/lib/voice/voice-select.ts` preferring a completely different
   character profile ("Asian woman with a Japanese accent", British female, Kyoko…).
3. **Different conversation per surface.** Deck-chat history lives in the stream context
   and is sent to `src/app/api/chat/route.ts` (clamped for Groq's 8K cap at `:84`); the
   call transcript is separate state inside `useVoiceCall.ts`. They are merged for
   DISPLAY ONLY (`src/components/bridge/VoiceCallOverlay.tsx` `chatMessages` memo). The
   call receives instructions only — no shared history in, no verified fold-back out.
4. **In-call typed messages bypass the call.** `handleSend → sendMessage`
   (`VoiceCallOverlay.tsx:88-89`) answers through the separate brain+TTS path while the
   realtime session — already open, already speaking as her — sits unused for text.

## Target end-state

1. **One persona root.** `src/lib/persona.ts` (+ the canon docs it names) is the single
   source of who she is. `brain.ts`'s tiered prompt becomes a DISTILLATION of that same
   root sized for the 8K cap — never a parallel personality. Provider switches change
   the engine, never the person. Any per-surface wrapper is a thin medium note ("this is
   a spoken call" / "this is chat"), nothing more.
2. **One voice, anchored to the call.** While a call is open: typed messages are
   injected into the live realtime session (`conversation.item.create` +
   `response.create` over the WS `useVoiceCall.ts` already holds) so the SAME session
   answers — same voice, same persona, same context by construction; the brain+TTS
   answer path stands down for the duration. Outside a call: VERIFY the xAI TTS voice
   catalog live (free path only) and pin the single closest voice to "eve", once, in
   code; retire `voice-select.ts`'s character-changing preference chain. Availability
   fallbacks (Piper/Web Speech) may remain as fallbacks, but they speak as the same
   PERSON — they never redefine her character.
3. **One conversation store.** One shared history both legs read and write (VERIFY what
   `src/app/api/context/`, `src/app/api/memory/`, and the stream context already provide
   before building anything new). Deck turns and call turns append to the same store.
   A call opens with a recent-history digest included in `session.update` (VERIFY xAI's
   instruction size limit live before choosing digest length). On hang-up the transcript
   folds back into the store. She walks into every surface already knowing the last one.
4. **Every surface enumerated and proven.** Deck console, voice call, in-call chat, the
   wake-word loop (`src/lib/voice/useVoiceLoop.ts`, `wake-word.ts`), and the dock app
   (WKWebView on macOS 12 — no regex lookbehind in client code) each resolve to the same
   persona root, the same voice policy, and the same store. No fifth person hiding.

## Constraints (hard)

- **Free only.** No new paid APIs, tiers, or subscriptions. Existing xAI + Groq/Kimi +
  local only. If a capability needs money, say so plainly and stop.
- **Verify first.** Every external claim (xAI TTS voices, realtime instruction limits,
  API shapes) is checked live before code depends on it. No stale priors.
- **Do not touch the face/lip-sync engine** (`StarraClipFace.tsx`, `viseme-sync.ts`) —
  just shipped and verified (611/611). The bus contract
  (`tests/bus-adoption-selectors.test.ts`) must keep passing untouched.
- **The suite stays green** (611 tests, tsc 0, eslint 0 new warnings), and the
  unification gets its own pinning tests modeled on
  `tests/no-test-video-engine-only.test.ts`: one-persona-source (no surface assembles
  its own personality text), in-call routing (typed → realtime session), voice pin.
- Precision standard in every agent prompt: quote source lines, cite every claim,
  hunt landmines before handoff, separate verified from unverified out loud.

## Acceptance (all must hold, demonstrated, not claimed)

- a. Grep-provable single persona import graph — exactly one module exports her
  personality; every surface imports it or a distillation derived from it in code.
- b. Typing to her during a live call is answered ALOUD by the realtime session in the
  call voice; the TTS leg provably does not fire (no `speak.ts` playback event).
- c. Open a call after chatting: her first turn reflects the chat. Hang up, type: the
  deck brain reflects the call. Same person, remembering.
- d. Out-of-call replies use the pinned voice. Where a fallback engine can't match the
  voice, she is still the same person in words; the voice substitution is logged, never
  a different character.
- e. `tsc --noEmit` 0 errors · eslint 0 new warnings · full suite green · live smoke on
  :3000.

## Org sizing

Two to three divisions with exclusive file sets: (1) persona root + brain distillation
(`persona.ts`, `brain.ts`, `prompt-structure.ts`); (2) in-call routing + voice pin
(`useVoiceCall.ts`, `VoiceCallOverlay.tsx`, `speak.ts`, `voice-select.ts`,
`api/realtime`, `api/tts`); (3) continuity store (`stargate-context.tsx`, `api/chat`,
`api/context`, `api/memory`). Board sign-off reads the changed files, runs the battery,
and walks acceptance a-e end to end.

## Context packs (built 2026-07-30, repo convention `data/packs/`)

- `data/packs/stargate-voicepack.xml` — 31 files, ~109K tokens: every file this brief
  names. Hand THIS to the working session.
- `data/packs/stargate-repomix.xml` — 199 files, ~433K tokens: the full canonical pack,
  for reference only (too big for most sessions).
