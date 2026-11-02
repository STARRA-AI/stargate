/**
 * HER VOICE, AS THREE NUMBERS.
 *
 * The deck's reactor is supposed to move when STARRA speaks. This is the whole
 * bridge between "she is talking" and "the sphere is alive" — everything above
 * it is drawing, everything below it is audio.
 *
 * WHY THERE IS NO NEW AUDIO PLUMBING HERE. Her speech already flows through an
 * AnalyserNode bus that this deck maintains:
 *   - `speak.ts:471` taps her TTS output (Ara / Piper / Web Speech),
 *   - `useVoiceCall.ts:2501` taps the live xAI Realtime call, and
 *     `mirrorAnalyserToEngineBus` (useVoiceCall.ts:451) publishes it onto the
 *     SAME bus, so a call and a spoken reply look identical from up here,
 *   - `StarraClipFace.tsx` already consumes exactly this to move her mouth.
 * So this module only ever READS. It never calls connect(), never reorders a
 * node, never creates a context. The live call is her most-used feature and it
 * is not worth a prettier reactor — a read-only consumer cannot break it.
 *
 * The band→motion mapping is ported from the reference implementation
 * (vendor/jarvis-realtime-agentic/analyser.ts + visual-3d.ts:227-236,
 * Apache-2.0): fftSize 32, and bins 0/1/2 carry amplitude, rotation rate and
 * displacement frequency respectively.
 */

import { useEffect, useRef, useState } from "react";

/** Bins 0, 1, 2 — amplitude, rotation, displacement frequency. */
export const BAND_COUNT = 3;

/**
 * How much of the previous frame survives when there is nothing to read.
 *
 * NOT symmetric with attack, and that asymmetry is the point. Attack is
 * instant: if her first syllable were smoothed the sphere would visibly lag
 * behind her voice. Release is smoothed: when the bus hands back null mid-word,
 * snapping to zero reads as a glitch, and HOLDING the last loud frame is worse
 * — the sphere freezes deformed and just looks broken. So it settles.
 */
const DECAY = 0.9;

/**
 * REUSED FFT SCRATCH. `readBands` runs once per animation frame, forever, for
 * every consumer of this bus at once — it used to allocate a fresh
 * `new Uint8Array(analyser.frequencyBinCount)` on each of those calls, which at
 * a 1024-point FFT is 512 bytes of garbage 60x a second per consumer, to read
 * THREE bins.
 *
 * Grown on demand, never shrunk, never reallocated in the steady state. Safe to
 * share across analysers: it is filled by `getByteFrequencyData` and read out
 * within the same synchronous call, so nothing can observe another consumer's
 * bytes. The one thing that MUST NOT be assumed is that `binScratch.length`
 * equals the current analyser's bin count — it is a high-water mark. The loop
 * below bounds itself on `analyser.frequencyBinCount` for exactly that reason.
 */
let binScratch = new Uint8Array(0);

/** Below this, call it silence. Stops a permanent sub-visible twitch. */
const REST = 1e-4;

/**
 * Fill `out` with the current bands, 0..1. Reads the node, writes `out`, and
 * reuses the module-level `binScratch` above; allocates nothing per frame.
 *
 * Exported separately from the hook so the behavior that actually matters —
 * decay, attack, NaN-safety — is testable without a browser AudioContext.
 */
export function readBands(analyser: AnalyserNode | null, out: Float32Array): void {
  if (!analyser) {
    // Nothing to read: settle toward rest rather than freezing or snapping.
    for (let b = 0; b < out.length; b++) {
      const decayed = out[b] * DECAY;
      out[b] = decayed < REST ? 0 : decayed;
    }
    return;
  }

  const binCount = analyser.frequencyBinCount;
  if (binScratch.length < binCount) binScratch = new Uint8Array(binCount);
  analyser.getByteFrequencyData(binScratch);

  for (let b = 0; b < out.length; b++) {
    // An analyser with fewer bins than we want is not an error — it is a
    // smaller FFT. Missing bins read as silence, never as NaN: a single NaN
    // reaching the canvas makes it draw nothing at all, which looks exactly
    // like the feature being broken.
    //
    // BOUNDED ON `binCount`, NOT ON `binScratch.length`. The scratch is shared
    // and only ever grows, so its length is a high-water mark from whatever
    // analyser had the most bins — indexing past `binCount` would return that
    // analyser's STALE bytes instead of silence. This bound keeps the returned
    // values bit-for-bit what the old per-frame allocation produced.
    const raw = b < binCount ? binScratch[b] : 0;
    const next = raw / 255;
    out[b] = Number.isFinite(next) ? next : 0;
  }
}

/**
 * Subscribe to the engine bus and expose her live speaking level.
 *
 * Seeds from `getTtsAudio()` before subscribing so a reply ALREADY in flight is
 * caught — the same ordering `VoiceCallOverlay.tsx:355` relies on. Without it,
 * mounting mid-sentence would show a dead sphere until she next started
 * speaking.
 */
export function useAudioBands(): {
  bands: Float32Array;
  playing: boolean;
  /** Pull the newest frame into `bands`. Call once per animation frame. */
  read: () => void;
} {
  const bandsRef = useRef<Float32Array>(new Float32Array(BAND_COUNT));
  const analyserRef = useRef<AnalyserNode | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    // Dynamic import for the same reason its other consumers use one: this
    // module reaches WebAudio, and the deck must render fine without it.
    void import("./speak")
      .then(({ subscribeTtsAudio, getTtsAudio }) => {
        if (cancelled) return;
        const apply = (s: { playing: boolean; analyser: AnalyserNode | null }) => {
          analyserRef.current = s.analyser;
          setPlaying(s.playing);
        };
        apply(getTtsAudio()); // a reply already in flight
        unsubscribe = subscribeTtsAudio(apply);
      })
      .catch(() => {
        // No bus is a normal resting state, not a failure worth surfacing: the
        // sphere simply breathes on its own. Nothing is silently swallowed here
        // that any operator could act on.
        if (!cancelled) setPlaying(false);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
      analyserRef.current = null;
    };
  }, []);

  // `read` closes over the refs rather than over state, so the rAF loop that
  // calls it 60x/second never re-subscribes and never re-renders. A frame now
  // genuinely costs no allocation: the output buffer is `bandsRef`, and the FFT
  // input buffer is the shared `binScratch` above. (This comment used to claim
  // zero allocation while `readBands` was allocating a fresh Uint8Array on
  // every single call — fixed 2026-09-30.)
  const read = useRef(() => {
    readBands(analyserRef.current, bandsRef.current);
  }).current;

  return { bands: bandsRef.current, playing, read };
}
