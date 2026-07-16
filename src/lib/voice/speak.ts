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

  const pausedBefore =
    typeof window !== "undefined" ? window.speechSynthesis?.paused : null;
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.resume();
  }

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
      // #region agent log
      fetch(
        "http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Debug-Session-Id": "f8c9f7",
          },
          body: JSON.stringify({
            sessionId: "f8c9f7",
            location: "speak.ts:webspeech-end",
            message: "webspeech utterance ended",
            data: {
              engine: "webspeech",
              textChars: text.length,
              pausedBefore,
              pausedAfter: window.speechSynthesis?.paused ?? null,
            },
            timestamp: Date.now(),
            hypothesisId: "H-A",
            runId: "post-fix-2",
          }),
        },
      ).catch(() => {});
      // #endregion
      resolve("webspeech");
    };
    u.onerror = (ev) => {
      signal?.removeEventListener("abort", onAbort);
      lastEngine = "none";
      // #region agent log
      fetch(
        "http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Debug-Session-Id": "f8c9f7",
          },
          body: JSON.stringify({
            sessionId: "f8c9f7",
            location: "speak.ts:webspeech-error",
            message: "webspeech utterance error",
            data: {
              textChars: text.length,
              pausedBefore,
              error: (ev as SpeechSynthesisErrorEvent).error ?? "unknown",
            },
            timestamp: Date.now(),
            hypothesisId: "H-A",
            runId: "post-fix-2",
          }),
        },
      ).catch(() => {});
      // #endregion
      resolve("none");
    };
    window.speechSynthesis.speak(u);
  });
}
