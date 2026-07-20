/**
 * Piper TTS — Cori en_GB high (Book 1 §7: one consistent voice).
 * Model availability checks only; runtime loads @mintplex-labs/piper-tts-web lazily.
 */

export const PIPER_VOICE_ID = "en_GB-cori-high" as const;
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
