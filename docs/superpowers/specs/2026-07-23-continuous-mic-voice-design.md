# Continuous mic — Grok-style full-duplex voice

**Date:** 2026-07-23
**Owner:** Classic (final say). PM: Fable. Build: Opus (engine) + Sonnet (UI).
**Traces to:** `STARRA_STARGATE_UNIFIED.md` §7 Voice interaction model — "continuous
(like ChatGPT/Grok voice). Not push-to-talk-only. Barge-in required."

## Problem

The composer **mic button** (`onMic → useVoiceLoop.wake()`) runs a **single-shot**
Web Speech recognizer (`continuous = false`): tap → one utterance → one reply → mic
closes. That is not a continuous conversation.

A **full-duplex realtime engine already exists** (`useVoiceCall.ts` → xAI Realtime WS,
server VAD, streaming both ways) wired only to the separate wave/"call" button via
`VoiceCallOverlay`. Decision (Classic, final say): **point the mic button at that
engine** and hone the interrupt.

## Design

Rewire the mic affordances to the existing full-duplex overlay; keep the button
**layout identical** (`[mic] [input] [send] [〰 wave]`). Reflect the live session as a
pulse on the mic button. Two integration hazards to close:

1. **Mic contention.** The wake-word listener (Web Speech `getUserMedia`) must stand
   down while the full-duplex call owns the mic. `useVoiceLoop` gains a `suspended`
   option.
2. **Interrupt tuning.** The client-side barge-in cancels playback on a *single* frame
   over `BARGE_IN_RMS_THRESHOLD` (0.02) — trigger-happy (a cough / echo bleed cuts
   STARRA off). Require **N consecutive** over-threshold frames before firing; server
   VAD stays the authoritative backstop.

## Shared contract (both builders honor exactly)

```ts
// useVoiceLoop.ts
export function useVoiceLoop(opts?: { suspended?: boolean }): {
  wake; stopSpeaking; wakeWordOn; setWakeWord
}
// suspended === true  ⇒  wake-word listener does NOT run (stop + no start),
//                        ⌥+Space hotkey does NOT fire wake(). Prevents mic contention.
```

`useVoiceCall`'s public return shape is **unchanged**.

## File ownership (non-overlapping)

- **Opus — engine/interrupt:** `src/lib/voice/useVoiceCall.ts`, `src/lib/voice/useVoiceLoop.ts`
- **Sonnet — UI/wiring:** `src/components/bridge/Bridge.tsx`, `DeckConsole.tsx`,
  `Composer.tsx`, `src/styles/deck.css`
- **Fable — PM/verify:** no edits; typecheck + contract grep + report.

## Done =

`npm run typecheck` clean; mic button (and hero badge) open the continuous overlay;
overlay rendered exactly once (lifted to Bridge); wake-word suspended while call is
live; barge-in requires consecutive frames; layout unchanged. Classic confirms live.
