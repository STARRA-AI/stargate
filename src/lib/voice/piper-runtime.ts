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
// ONE definition of "where the runtime binaries live" and ONE definition of
// "is the OPFS seed complete", shared with the local mouth. Two copies of
// either is two places the same privacy bug can live — and it already did.
import { LOCAL_WASM_PATHS, seedComplete } from "@/lib/voice/local-voice";

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
    // BOTH files, BOTH non-empty. Checking only the .onnx declared an
    // INTERRUPTED seed good (the .onnx.json is written second, below), and a
    // missing json sends the library's getBlob to huggingface.co instead of
    // OPFS — dist:288 -> :369-375 -> readBlob :168-183 miss -> fetchBlob. The
    // local mouth shares this exact seed directory, so a half-seed here armed
    // the PRIVATE lane too. See seedComplete.
    const [onnxHandle, jsonHandle] = await Promise.all([
      dir.getFileHandle(`${PIPER_VOICE_ID}.onnx`),
      dir.getFileHandle(`${PIPER_VOICE_ID}.onnx.json`),
    ]);
    const [onnxFile, jsonFile] = await Promise.all([
      onnxHandle.getFile(),
      jsonHandle.getFile(),
    ]);
    if (seedComplete(onnxFile.size, jsonFile.size)) return true;
  } catch {
    /* not seeded, or seeded incompletely — write both below */
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
      // THE LEAK THIS CLOSES. Created with no wasmPaths, this session takes the
      // library's CDN defaults (onnxruntime from cdnjs, piper_phonemize from
      // jsdelivr — dist:235-239), and TtsSession is a PROCESS-WIDE singleton
      // whose constructor returns the existing instance and ignores later
      // options (dist:259-263). So this normal-lane session, if it is built
      // first, arms every later synthesis — including a PRIVATE turn's, since
      // predict() re-creates the phonemizer from #wasmPaths on every call
      // (dist:301-315). Same local paths here means there is no CDN-configured
      // session for the private lane to inherit in the first place.
      //
      // Piper is the OFFLINE fallback (CLAUDE.md, Stack): requiring its runtime
      // binaries to be present locally is what "offline" was supposed to mean.
      return TtsSession.create({
        voiceId: PIPER_VOICE_ID,
        wasmPaths: LOCAL_WASM_PATHS,
      });
    })();
  }
  return sessionPromise;
}

async function synthesizePiper(text: string): Promise<Blob> {
  const session = await getSession();
  return session.predict(text.trim());
}

/**
 * Audio still owed on an element, in milliseconds.
 *
 * Returns 0 when the duration is not known yet (`duration` is NaN until enough
 * of the blob is parsed) so a caller can fall back to its own floor instead of
 * arming a timer off a NaN. Never negative: `currentTime` can legitimately sit a
 * hair past `duration` at the end of playback.
 *
 * Pure and total on purpose — tests/voice-debug-timing.test.ts pins it down,
 * because the bug it serves (see PiperPlaybackProgress) is otherwise only
 * observable with a real audio element.
 */
export function remainingAudioMs(duration: number, currentTime: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(currentTime) || currentTime < 0) return duration * 1000;
  const left = (duration - currentTime) * 1000;
  return left > 0 ? left : 0;
}

/**
 * Progress hooks so a CALLER can bound synthesis and playback SEPARATELY.
 *
 * THE BUG THIS EXISTS FOR (confirmed, speak.ts's Piper leg). speakPiper resolves
 * on the element's `ended` — see audio.onended below — so it reports the end of
 * PLAYBACK, not the end of synthesis. speak.ts raced it against a flat 4s
 * timeout, which therefore bounded the WHOLE UTTERANCE: every reply longer than
 * 4 seconds was aborted mid-word and then re-spoken from the top by the next
 * fallback engine, in a different voice. There was no signal a caller could use
 * to tell "still synthesising" from "already talking" — these two are it.
 *
 * Both are best-effort observation. Neither is awaited, both are wrapped, and a
 * caller that throws inside one cannot affect her audio (see `notify`).
 */
export interface PiperPlaybackProgress {
  /** Synthesis finished: the WAV exists, and NO sound has been produced yet. */
  onSynthesized?: () => void;
  /**
   * Sound is actually coming out. Fires on `playing` and on every `timeupdate`
   * (~4x/second during playback) with the audio still owed, so a caller can
   * re-arm a stall watchdog from real progress rather than from a fixed ceiling.
   */
  onProgress?: (remainingMs: number) => void;
}

/** Call a caller's hook without ever letting it reach her audio path. */
function notify(fn: (() => void) | undefined): void {
  if (!fn) return;
  try {
    fn();
  } catch {
    /* a caller's bookkeeping must never break her voice */
  }
}

/**
 * Speak via Piper. Resolves when playback ends or signal aborts.
 * Returns false if Piper unavailable or synthesis fails.
 *
 * `progress` is optional and purely observational — see PiperPlaybackProgress.
 */
export async function speakPiper(
  text: string,
  signal?: AbortSignal,
  progress?: PiperPlaybackProgress,
): Promise<boolean> {
  if (!(await piperModelAvailable())) return false;

  try {
    stopPiperAudio();
    const wav = await synthesizePiper(text);
    if (signal?.aborted) return false;
    // THE SEAM: everything above is synthesis, everything below is playback.
    // Announced before the element exists so the caller can swap a synthesis
    // bound for a play-start bound with no window where neither applies.
    notify(progress?.onSynthesized);

    return await new Promise<boolean>((resolve) => {
      const url = URL.createObjectURL(wav);
      const audio = new Audio(url);
      setActivePiperAudio(audio);

      // Progress is reported from the element's OWN events, so it cannot drift
      // from the sound. `playing` (not `play`) is the one that means audio is
      // actually being rendered — `play` fires on the attempt.
      const onProgress = () => {
        const fn = progress?.onProgress;
        if (!fn) return;
        try {
          fn(remainingAudioMs(audio.duration, audio.currentTime));
        } catch {
          /* observation only */
        }
      };
      audio.addEventListener("playing", onProgress);
      audio.addEventListener("timeupdate", onProgress);

      const cleanup = () => {
        // Drop our own listeners on every terminal path, so a discarded element
        // cannot keep reporting progress for an utterance that is over.
        try {
          audio.removeEventListener("playing", onProgress);
          audio.removeEventListener("timeupdate", onProgress);
        } catch {
          /* ignore */
        }
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
