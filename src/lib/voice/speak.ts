/**
 * Unified STARRA TTS — Piper Cori when model files present, Web Speech fallback.
 * Book 1 §7: one consistent voice; operator register unchanged.
 */

import {
  applyStarraVoice,
  voicesReady,
  isAraSelected,
  isSpecificWebSpeechVoice,
} from "@/lib/voice/voice-select";
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

  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.resume();
  }

  // Ara (xAI) is the default/primary voice. It runs first UNLESS the operator
  // explicitly picked a Web Speech voice or AUTO in Settings. Piper/Web Speech
  // remain the fallback below (offline / Ara unreachable).
  if (isAraSelected() && !signal?.aborted) {
    const araOk = await speakAra(text, signal);
    if (araOk && !signal?.aborted) {
      lastEngine = "ara";
      return "ara";
    }
  }

  // When a specific Web Speech voice is chosen, honor it — skip Piper (which
  // can't render a chosen voiceURI) and go straight to Web Speech below.
  const piperAvailable = isSpecificWebSpeechVoice()
    ? false
    : await piperModelAvailable();

  if (piperAvailable) {
    const { speakPiper } = await import("@/lib/voice/piper-runtime");
    const piperOk = await Promise.race<boolean>([
      speakPiper(text, signal),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4_000)),
    ]);
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
