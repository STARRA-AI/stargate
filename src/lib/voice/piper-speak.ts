/**
 * Piper TTS — Cori en_GB (Book 1 §7: one consistent voice).
 * Model availability checks only; runtime loads @mintplex-labs/piper-tts-web lazily.
 */

/**
 * SAME VOICE, FASTER TIER. `medium` and `high` are both Cori — one speaker, one
 * sound — so Book 1 §7's "one consistent voice" is unbroken by this; only the
 * model's quality tier moved. It moved because `high` is not usable live on
 * this Intel Mac, measured in the real browser on the real code path
 * (.superpowers/sdd/p2-task-4-report.md §7):
 *
 *   RTF (wall time / audio produced), lower is better, <1 = faster than speech
 *     en_GB-cori-high    3.14 / 2.78   — 14.9 s of CPU for 4.7 s of speech
 *     en_GB-cori-medium  0.39 / 0.36   — 1.75 s of CPU for 4.5 s of speech
 *   TtsSession.create     7 783 ms  ->  3 753 ms
 *   OPFS seed             2 369 ms  ->  1 387 ms
 *   model on disk       114 219 352 B -> 63 531 379 B
 *
 * Independently smoked in Classic's own browser: SEED 1.4 s, INIT 3.8 s,
 * PREDICT 1.75 s / 0.94 s, SMOKE_OK.
 *
 * `high` stays fully usable — nothing was removed. The overrides in
 * local-voice.ts:337-371 pick it back up (`stargate.localVoice` in
 * localStorage, or NEXT_PUBLIC_STARRA_LOCAL_VOICE), and both model tiers ship
 * in public/brand/voice/.
 */
export const PIPER_VOICE_ID = "en_GB-cori-medium" as const;
export const PIPER_VOICE_BASE = "/brand/voice";

const LOCAL_ONNX = `${PIPER_VOICE_BASE}/${PIPER_VOICE_ID}.onnx`;

// Cache only the POSITIVE result — a transient HEAD-check miss must not
// permanently disable the offline Piper fallback (it would retry-never).
let localAvailable = false;

/** HEAD-check local Cori model served from public/brand/voice/. */
export async function piperModelAvailable(): Promise<boolean> {
  if (localAvailable) return true; // known present — skip re-check
  if (typeof window === "undefined") return false;
  try {
    const res = await fetch(LOCAL_ONNX, { method: "HEAD" });
    localAvailable = res.ok;
    return res.ok;
  } catch {
    return false; // transient miss — don't cache, retry next call
  }
}

let activeAudio: HTMLAudioElement | null = null;

export function stopPiperAudio() {
  if (activeAudio) {
    activeAudio.pause();
    const url = activeAudio.src;
    activeAudio.src = "";
    if (url.startsWith("blob:")) {
      URL.revokeObjectURL(url);
    }
    activeAudio = null;
  }
}

/** @internal Used by piper-runtime for playback lifecycle. */
export function setActivePiperAudio(audio: HTMLAudioElement | null) {
  activeAudio = audio;
}
