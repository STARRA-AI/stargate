/**
 * Piper TTS — Cori en_GB high (Book 1 §7: one consistent voice).
 * Model availability checks only; runtime loads @mintplex-labs/piper-tts-web lazily.
 */

export const PIPER_VOICE_ID = "en_GB-cori-high" as const;
export const PIPER_VOICE_BASE = "/brand/voice";

const LOCAL_ONNX = `${PIPER_VOICE_BASE}/${PIPER_VOICE_ID}.onnx`;

let localAvailable: boolean | null = null;

/** HEAD-check local Cori model served from public/brand/voice/. */
export async function piperModelAvailable(): Promise<boolean> {
  if (localAvailable !== null) return localAvailable;
  if (typeof window === "undefined") {
    localAvailable = false;
    return false;
  }
  try {
    const res = await fetch(LOCAL_ONNX, { method: "HEAD" });
    localAvailable = res.ok;
  } catch {
    localAvailable = false;
  }
  return localAvailable;
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
