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

/** Active Ara audio element, tracked so stopAllSpeech()/barge-in can cancel it. */
let araAudio: HTMLAudioElement | null = null;
/**
 * Resolver for whatever speakAra() promise is currently pending. Pausing the
 * audio element alone does not fire `ended`/`error`, so without this a
 * barge-in (stopAraAudio called from outside speakAra's own signal/listener
 * plumbing) would leave that promise hanging forever — and, upstream, the
 * awaiting speakStarra()/sendMessage() turn stuck too.
 */
let araSettle: (() => void) | null = null;

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
  if (araSettle) {
    const settle = araSettle;
    araSettle = null;
    settle();
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
      let settled = false;
      const cleanup = () => URL.revokeObjectURL(url);
      // Settles this promise exactly once, from any path (ended/error/abort/
      // play-failure/external stopAraAudio), and clears the shared resolver
      // so a later, unrelated stopAraAudio() call is a no-op.
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (araSettle === settleFalse) araSettle = null;
        cleanup();
        resolve(ok);
      };
      const settleFalse = () => settle(false);
      araSettle = settleFalse;
      const onAbort = () => {
        try {
          audio.pause();
        } catch {
          /* ignore */
        }
        settle(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      audio.onended = () => {
        if (araAudio === audio) araAudio = null;
        settle(true);
      };
      audio.onerror = () => {
        if (araAudio === audio) araAudio = null;
        settle(false);
      };
      audio.play().catch(() => {
        settle(false);
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
      return "ara";
    }
  }

  if (signal?.aborted) {
    return "none";
  }

  // When a specific Web Speech voice is chosen, honor it — skip Piper (which
  // can't render a chosen voiceURI) and go straight to Web Speech below.
  //
  // KNOWN GAP (audit item, not fixed here — out of ownership scope): once
  // piperModelAvailable() (lib/voice/piper-speak.ts) records a failed HEAD
  // check it caches `false` for the rest of the session with no retry/TTL,
  // so a transient miss disables Piper until reload. Fixing it means
  // touching piper-speak.ts's module-level `localAvailable` cache, which is
  // outside this file's ownership for this change — flagged for follow-up.
  const piperAvailable = isSpecificWebSpeechVoice()
    ? false
    : await piperModelAvailable();

  if (piperAvailable) {
    const { speakPiper } = await import("@/lib/voice/piper-runtime");
    // Piper gets its own AbortController, chained off the caller's `signal`,
    // so the 4s timeout below can cancel the LOSING synthesis instead of
    // just walking away from it. Without this, a slow Piper call that wins
    // the race after the timeout would still play — overlapping whatever
    // WebSpeech fallback already started (dual-voice playback).
    const piperAc = new AbortController();
    const forwardAbort = () => piperAc.abort();
    if (signal?.aborted) {
      // Already aborted before we got here — `addEventListener("abort", …)`
      // below would never fire for an event that already happened, so seed
      // piperAc's state directly instead of relying on it.
      piperAc.abort();
    } else {
      signal?.addEventListener("abort", forwardAbort, { once: true });
    }

    let timedOut = false;
    const piperOk = await Promise.race<boolean>([
      speakPiper(text, piperAc.signal),
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          timedOut = true;
          piperAc.abort();
          resolve(false);
        }, 4_000),
      ),
    ]);

    signal?.removeEventListener("abort", forwardAbort);

    if (piperOk && !signal?.aborted) {
      return "piper";
    }
    if (timedOut) {
      // Belt-and-suspenders: speakPiper's own abort listener already stops
      // playback if it had started, but make sure nothing lingers before
      // falling through to Web Speech.
      stopPiperAudio();
    }
  }

  if (!window.speechSynthesis) {
    return "none";
  }

  await voicesReady();
  if (signal?.aborted) {
    return "none";
  }

  return new Promise<SpeakEngine>((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    applyStarraVoice(u);

    const onAbort = () => {
      window.speechSynthesis.cancel();
      resolve("none");
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    u.onend = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve("webspeech");
    };
    u.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve("none");
    };
    window.speechSynthesis.speak(u);
  });
}
