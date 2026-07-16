/**
 * Browser-only Piper runtime — lazy-loads @mintplex-labs/piper-tts-web after model check.
 * Kept separate from piper-speak.ts so the client bundle never statically pulls Emscripten/fs.
 */

import {
  PIPER_VOICE_BASE,
  PIPER_VOICE_ID,
  piperModelAvailable,
  setActivePiperAudio,
  stopPiperAudio,
} from "@/lib/voice/piper-speak";

const LOCAL_ONNX = `${PIPER_VOICE_BASE}/${PIPER_VOICE_ID}.onnx`;
const LOCAL_JSON = `${PIPER_VOICE_BASE}/${PIPER_VOICE_ID}.onnx.json`;

type PiperModule = typeof import("@mintplex-labs/piper-tts-web");
type TtsSession = Awaited<ReturnType<PiperModule["TtsSession"]["create"]>>;

let piperModulePromise: Promise<PiperModule> | null = null;
let sessionPromise: Promise<TtsSession> | null = null;

async function loadPiperModule(): Promise<PiperModule> {
  if (!piperModulePromise) {
    piperModulePromise = import("@mintplex-labs/piper-tts-web");
  }
  return piperModulePromise;
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
      const { PATH_MAP, TtsSession } = await loadPiperModule();
      if (!(PIPER_VOICE_ID in PATH_MAP)) {
        throw new Error(`Unknown Piper voice: ${PIPER_VOICE_ID}`);
      }
      await seedOpfsFromPublic();
      return TtsSession.create({ voiceId: PIPER_VOICE_ID });
    })();
  }
  return sessionPromise;
}

async function synthesizePiper(text: string): Promise<Blob> {
  const session = await getSession();
  return session.predict(text.trim());
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
      setActivePiperAudio(audio);

      const cleanup = () => {
        URL.revokeObjectURL(url);
        setActivePiperAudio(null);
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
