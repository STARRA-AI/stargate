/**
 * Unified STARRA TTS — Piper Cori when model files present, Web Speech fallback.
 * Book 1 §7: one consistent voice; operator register unchanged.
 */

import { applyStarraVoice, voicesReady } from "@/lib/voice/voice-select";
import {
  piperModelAvailable,
  stopPiperAudio,
  PIPER_VOICE_ID,
} from "@/lib/voice/piper-speak";

export { PIPER_VOICE_ID };

export type SpeakEngine = "piper" | "webspeech" | "none";

let lastEngine: SpeakEngine = "none";

export function getLastSpeakEngine(): SpeakEngine {
  return lastEngine;
}

export function stopAllSpeech() {
  stopPiperAudio();
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

/** Speak text; prefers Piper Cori, falls back to browser speechSynthesis. */
export async function speakStarra(
  text: string,
  signal?: AbortSignal,
): Promise<SpeakEngine> {
  if (typeof window === "undefined" || !text.trim()) {
    lastEngine = "none";
    return "none";
  }

  stopAllSpeech();

  if (await piperModelAvailable()) {
    const { speakPiper } = await import("@/lib/voice/piper-runtime");
    const ok = await speakPiper(text, signal);
    if (ok && !signal?.aborted) {
      lastEngine = "piper";
      return "piper";
    }
  }

  if (!window.speechSynthesis) {
    lastEngine = "none";
    return "none";
  }

  await voicesReady();
  if (signal?.aborted) {
    lastEngine = "none";
    return "none";
  }

  return new Promise<SpeakEngine>((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    applyStarraVoice(u);

    const onAbort = () => {
      window.speechSynthesis.cancel();
      lastEngine = "none";
      resolve("none");
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    u.onend = () => {
      signal?.removeEventListener("abort", onAbort);
      lastEngine = "webspeech";
      resolve("webspeech");
    };
    u.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      lastEngine = "none";
      resolve("none");
    };
    window.speechSynthesis.speak(u);
  });
}
