/**
 * Piper TTS — Cori en_GB high (Book 1 §7: one consistent voice).
 * Loads ONNX from /brand/voice/ when present; seeds browser OPFS for piper-tts-web.
 * ~1s/sentence on 8GB MacBook 2013 with the high model.
 */

import { PATH_MAP, TtsSession } from "@mintplex-labs/piper-tts-web";

export const PIPER_VOICE_ID = "en_GB-cori-high" as const;
export const PIPER_VOICE_BASE = "/brand/voice";

const LOCAL_ONNX = `${PIPER_VOICE_BASE}/${PIPER_VOICE_ID}.onnx`;
const LOCAL_JSON = `${PIPER_VOICE_BASE}/${PIPER_VOICE_ID}.onnx.json`;

let sessionPromise: Promise<TtsSession> | null = null;
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

/** Copy public/ voice files into OPFS so piper-tts-web reads them offline. */
async function seedOpfsFromPublic(): Promise<boolean> {
  if (!(await piperModelAvailable())) return false;
  if (!navigator.storage?.getDirectory) return false;

  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("piper", { create: true });

  try {
    const existing = await dir.getFileHandle(`${PIPER_VOICE_ID}.onnx`);
    const file = await existing.getFile();
    if (file.size > 0) return true;
  } catch {
    /* seed below */
  }

  const [onnxRes, jsonRes] = await Promise.all([
    fetch(LOCAL_ONNX),
    fetch(LOCAL_JSON),
  ]);
  if (!onnxRes.ok || !jsonRes.ok) return false;

  const pairs: [string, Blob][] = [
    [`${PIPER_VOICE_ID}.onnx`, await onnxRes.blob()],
    [`${PIPER_VOICE_ID}.onnx.json`, await jsonRes.blob()],
  ];

  for (const [name, blob] of pairs) {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  }
  return true;
}

function getSession(): Promise<TtsSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      if (!(PIPER_VOICE_ID in PATH_MAP)) {
        throw new Error(`Unknown Piper voice: ${PIPER_VOICE_ID}`);
      }
      await seedOpfsFromPublic();
      return TtsSession.create({ voiceId: PIPER_VOICE_ID });
    })();
  }
  return sessionPromise;
}

/** Synthesize text to WAV blob via Piper Cori. */
export async function synthesizePiper(text: string): Promise<Blob> {
  const session = await getSession();
  return session.predict(text.trim());
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

/**
 * Speak via Piper. Resolves when playback ends or signal aborts.
 * Returns false if Piper unavailable or synthesis fails.
 */
export async function speakPiper(
  text: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!(await piperModelAvailable())) return false;

  try {
    stopPiperAudio();
    const wav = await synthesizePiper(text);
    if (signal?.aborted) return false;

    return await new Promise<boolean>((resolve) => {
      const url = URL.createObjectURL(wav);
      const audio = new Audio(url);
      activeAudio = audio;

      const cleanup = () => {
        URL.revokeObjectURL(url);
        if (activeAudio === audio) activeAudio = null;
      };

      const onAbort = () => {
        audio.pause();
        cleanup();
        resolve(false);
      };

      signal?.addEventListener("abort", onAbort, { once: true });

      audio.onended = () => {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        resolve(true);
      };
      audio.onerror = () => {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        resolve(false);
      };
      void audio.play().catch(() => {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        resolve(false);
      });
    });
  } catch {
    sessionPromise = null;
    return false;
  }
}
