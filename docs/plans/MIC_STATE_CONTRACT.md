# MIC STATE — the one source of truth

**Status:** shipped on `addendum/gaps` (G4).
**Module:** `src/lib/voice/mic-state.ts`
**Owner of the state machine:** the voice core. Everything else is a consumer.

---

## Why this note is in *this* file and not in `LIPSYNC_MOTION_PLAN.md`

This note exists to tell the **listening-pulse animation** on the
`design/lipsync-motion` branch where to get its state. The obvious home for it
would be `docs/plans/LIPSYNC_MOTION_PLAN.md` — except that file **does not
exist on this branch**:

```
$ git cat-file -e 20cac82:docs/plans/LIPSYNC_MOTION_PLAN.md
fatal: path 'docs/plans/LIPSYNC_MOTION_PLAN.md' does not exist in '20cac82'
```

It was added by `941f8f1` on `design/lipsync-motion` only. Creating it here
would mean two branches independently authoring the same path, which is a
guaranteed merge conflict on a file that is pure prose — the worst kind to
resolve, because git cannot tell which paragraphs are the real ones.

So the contract lives here, in a file only this branch creates, and the motion
branch picks it up with a one-line pointer. That keeps the merge to an
append-only edit on their side.

> **ACTION FOR THE MOTION BRANCH:** add a single line to
> `docs/plans/LIPSYNC_MOTION_PLAN.md` pointing at this file. Something like:
> `Mic state comes from src/lib/voice/mic-state.ts — see docs/plans/MIC_STATE_CONTRACT.md. Do not derive it.`

---

## The rule

`src/lib/voice/mic-state.ts` is the **ONE** exported mic-state source of truth.

The listening-pulse animation — and any other indicator, badge, glow, or
waveform that wants to know whether the deck is listening — **consumes this
module. It does not derive its own state.**

Deriving is what to avoid: reading `getWakeWordEnabled()`, watching the HUD
state, sniffing `navigator.mediaDevices`, or tracking a local `isListening`
boolean will all disagree with the real machine at some point. When the
indicator disagrees with the microphone, the indicator is worse than nothing —
it tells Classic the mic is off while it is on.

---

## The API

```ts
export type MicMode = "muted" | "wake" | "open";

/** CustomEvent<{ mode: MicMode }> on window. */
export const MIC_MODE_EVENT = "stargate-mic-mode";

export function getMicMode(): MicMode;                              // default "wake"
export function setMicMode(m: MicMode): void;                       // dispatches MIC_MODE_EVENT
export function subscribeMicMode(fn: (m: MicMode) => void): () => void;  // returns unsubscribe
```

### The three states

| Mode | Meaning | Pulse should read as |
|---|---|---|
| `"muted"` | No recognizer runs at all. Nothing is listening. | Off / dead |
| `"wake"` | **Default.** Wake-word listener runs while idle; only a wake phrase opens a turn. | Idle / dormant |
| `"open"` | Continuous transcription. Every final result becomes a turn. | Actively listening — loud, unmissable |

### Two ways to observe it, both valid

```ts
// 1. Module subscriber — preferred when you already import the module.
const unsubscribe = subscribeMicMode((mode) => { /* ... */ });

// 2. Window event — for a surface that would rather not import.
window.addEventListener(MIC_MODE_EVENT, (e) => {
  const mode = (e as CustomEvent<{ mode: MicMode }>).detail.mode;
});
```

`subscribeMicMode` does **not** fire on subscribe. Seed with `getMicMode()`
first, then subscribe.

---

## Hard rules the consumer must not break

1. **`"open"` is in-memory only.** Never `localStorage`, never
   `sessionStorage`, never a cookie. It is never the initial value and never
   survives a reload. An always-listening mic must be re-armed by a person,
   every session, on purpose. `tests/mic-state.test.ts` asserts that no storage
   write happens — do not add one anywhere in the chain.

2. **Arming is a deliberate operator action.** `setMicMode("open")` is reached
   only from an explicit two-step control (see `MicStateBadge`'s ARM/CONFIRM
   pair). An animation must never call `setMicMode` at all — it reads, it does
   not write.

3. **`wake-word.ts` is not the mode.** `getWakeWordEnabled()`
   (localStorage `stargate.wakeWord`, default ON) is the *sub-preference* that
   applies while the machine is in `"wake"`. It is not the outer state and must
   not be used as a stand-in for one.

4. **The live call takes the microphone whole.** When the full-duplex call is
   up, `useVoiceLoop` yields the mic in every mode, `"open"` included. A pulse
   driven purely off `getMicMode()` will therefore show "listening" while the
   call owns the device — if that matters for the visual, gate on the call's
   own state as well, but still take the *mode* from here.

---

## Where it is already wired

| File | Role |
|---|---|
| `src/lib/voice/mic-state.ts` | The machine. |
| `src/lib/voice/useVoiceLoop.ts` | The consumer that actually starts/stops recognizers per mode. |
| `src/components/bridge/MicStateBadge.tsx` | Three-way control + persistent OPEN MIC banner. |
| `src/app/settings/page.tsx` | Mic-mode selector, same ARM/CONFIRM gate. |
| `tests/mic-state.test.ts` | Defaults, transitions, event, and the no-storage guarantee. |
