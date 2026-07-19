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

export type SpeakEngine = "ara" | "piper" | "webspeech" | "none";

let lastEngine: SpeakEngine = "none";

export function getLastSpeakEngine(): SpeakEngine {
  return lastEngine;
}

/** Active Ara audio element, tracked so stopAllSpeech()/barge-in can cancel it. */
let araAudio: HTMLAudioElement | null = null;

function stopAraAudio() {
  if (araAudio) {
    try {
      araAudio.pause();
      araAudio.src = "";
    } catch {
      /* ignore */
    }
    araAudio = null;
  }
}

export function stopAllSpeech() {
  stopAraAudio();
  stopPiperAudio();
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

/**
 * Ara (xAI TTS) via the server /api/tts proxy — preferred online voice.
 * Returns false on any miss (no key → 204, network/offline, aborted, decode
 * failure) so speakStarra falls through to Piper. Key never touches the client.
 */
async function speakAra(text: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok || res.status === 204) return false;
    const blob = await res.blob();
    if (!blob.size || signal?.aborted) return false;

    const url = URL.createObjectURL(blob);
    stopAraAudio();
    const audio = new Audio(url);
    araAudio = audio;

    return await new Promise<boolean>((resolve) => {
      const cleanup = () => URL.revokeObjectURL(url);
      const onAbort = () => {
        try {
          audio.pause();
        } catch {
          /* ignore */
        }
        cleanup();
        resolve(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      audio.onended = () => {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        if (araAudio === audio) araAudio = null;
        resolve(true);
      };
      audio.onerror = () => {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        if (araAudio === audio) araAudio = null;
        resolve(false);
      };
      audio.play().catch(() => {
        cleanup();
        resolve(false);
      });
    });
  } catch {
    return false;
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

  // Ara (xAI) first when reachable; Piper remains the offline fallback below.
  if (!signal?.aborted) {
    const araOk = await speakAra(text, signal);
    if (araOk && !signal?.aborted) {
      lastEngine = "ara";
      return "ara";
    }
  }

  const piperAvailable = await piperModelAvailable();
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
        location: "speak.ts:entry",
        message: "speakStarra start",
        data: {
          textChars: text.length,
          piperAvailable,
          pausedBefore,
          voiceCount: window.speechSynthesis?.getVoices().length ?? 0,
        },
        timestamp: Date.now(),
        hypothesisId: "H-A",
        runId: "post-fix-3",
      }),
    },
  ).catch(() => {});
  // #endregion

  if (piperAvailable) {
    const { speakPiper } = await import("@/lib/voice/piper-runtime");
    const piperOk = await Promise.race<boolean>([
      speakPiper(text, signal),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4_000)),
    ]);
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
          location: "speak.ts:piper-branch",
          message: piperOk ? "piper spoke" : "piper skipped or timed out",
          data: { piperOk, aborted: signal?.aborted ?? false },
          timestamp: Date.now(),
          hypothesisId: "H-E",
          runId: "post-fix-3",
        }),
      },
    ).catch(() => {});
    // #endregion
    if (piperOk && !signal?.aborted) {
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
            runId: "post-fix-3",
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
            runId: "post-fix-3",
          }),
        },
      ).catch(() => {});
      // #endregion
      resolve("none");
    };
    window.speechSynthesis.speak(u);
  });
}
