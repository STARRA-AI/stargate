/**
 * LOCAL MOUTH — her voice, synthesised on this Mac, sentence by sentence.
 *
 * WHAT THIS IS FOR. The private lane (docs/PRIVATE_LANE.md) answers a
 * `private …` turn entirely on loopback, and until now the price of that was
 * SILENCE: speakStarra POSTs the reply to /api/tts, which is xAI, so a private
 * reply could not be spoken at all. This module is the other half — a mouth
 * that never leaves the machine, so the private lane stops being text-only and
 * the all-local call has something to talk with.
 *
 * ── THE PRIVACY CONTRACT (the whole reason this file is separate) ───────────
 * NOTHING here may make a request off this machine. That is not automatic:
 * @mintplex-labs/piper-tts-web ships CDN defaults —
 *   ONNX_BASE  = https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/
 *   WASM_BASE  = https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/…
 *   HF_BASE    = https://huggingface.co/diffusionstudio/piper-voices/…
 * (node_modules/@mintplex-labs/piper-tts-web/dist/piper-tts-web.js:12-14), and
 * TtsSession.init() assigns `ort.env.wasm.wasmPaths = #wasmPaths.onnxWasm`
 * (same file:286) and loads the phonemizer's .wasm/.data from #wasmPaths
 * (:310-311). So THREE things keep a private reply on loopback, and all three
 * are here rather than anywhere else:
 *   1. LOCAL_WASM_PATHS is passed explicitly to TtsSession.create, so the CDN
 *      defaults are never used.
 *   2. The model is seeded into OPFS from the deck's own /brand/voice before
 *      the session is created, so getBlob(`${HF_BASE}/…`) reads OPFS by
 *      filename and never fetches huggingface (:143,:170 — the OPFS key is the
 *      URL's last path segment, which is why the seed writes exactly
 *      `<voiceId>.onnx` / `<voiceId>.onnx.json` into the "piper" directory).
 *   3. localVoiceReady() HEAD-checks every one of those local files FIRST and
 *      refuses to start when any is missing. Missing assets therefore mean
 *      SILENCE — today's behaviour — never a fallback that phones out.
 * We deliberately do NOT reuse piper-runtime.ts's session: TtsSession keeps a
 * process-wide singleton (`_instance`, :259-272) and piper-runtime creates it
 * with no wasmPaths, i.e. CDN-configured. A private reply must not inherit it.
 *
 * ── THE ASSETS (all free, all one-time, none of them run-time downloads) ────
 *   public/brand/voice/<voiceId>.onnx          Piper model  (Cori en_GB high)
 *   public/brand/voice/<voiceId>.onnx.json     its config
 *   public/brand/voice/wasm/ort/*.wasm         cp node_modules/onnxruntime-web/dist/*.wasm
 *   public/brand/voice/wasm/piper_phonemize.wasm|.data   from the piper-wasm package
 * Until they are all present this module reports "not ready" and she stays
 * silent — see localVoiceReady().
 *
 * ── HOW IT SOUNDS ──────────────────────────────────────────────────────────
 * Synthesis of a whole reply is seconds of dead air. So the reply is split into
 * sentences and sentence N+1 is synthesised WHILE sentence N plays, through ONE
 * persistent audio element (one element = one irreversible
 * createMediaElementSource = one stable analyser for her face). Audio truth on
 * the engine bus comes from that element's own `playing`/`ended`/`pause`/
 * `error` events — never from synthesis state, the same rule speak.ts documents
 * at speak.ts:36-38, because publishing "speaking" through a synth is
 * publishing it over silence.
 *
 * No regex lookbehind anywhere — macOS 12 WebKit.
 */

import { speakableText } from "@/lib/voice/code-speech";
import { PIPER_VOICE_BASE, PIPER_VOICE_ID } from "@/lib/voice/piper-speak";
import { MOUTH_SYNC_ENABLED } from "@/lib/voice/viseme-sync";
import { getEngineState, publishVoice } from "@/lib/engine/bus";

// ── THE SPLITTER ───────────────────────────────────────────────────────────

/**
 * Shortest chunk worth its own synthesis pass. Under this it is merged with a
 * neighbour: "Copy." on its own is a clipped 300ms file plus a full session
 * round-trip, and the gap it opens is more audible than the fragment it saves.
 */
export const MIN_SENTENCE_CHARS = 12;

/**
 * Longest chunk we will hand to Piper in one go. This is a LATENCY cap, not a
 * grammar rule: the first sentence's synthesis is the whole time-to-first-word,
 * so a 900-character run-on with no full stop must still be broken up or she
 * says nothing for several seconds.
 */
export const MAX_SENTENCE_CHARS = 240;

/** Sentence-ending punctuation. `…` is here to be RECOGNISED, not to end one. */
const TERMINATORS = ".!?…";
/** Punctuation that belongs to the sentence it closes, after the terminator. */
const CLOSERS = "\"')]}»”’";
/** Where a run-on may be broken when nothing else offers a boundary. */
const SOFT_BREAKS = ",;:—–";

/**
 * Dotless abbreviations that must not end a sentence.
 *
 * Deliberately TIGHT. Every entry costs a real missed boundary when the word is
 * used normally, so "no", "min", "max" and the weekday names are OUT — "The
 * answer is no." is a sentence Classic will hear far more often than "No. 5".
 * Dotted forms (U.S., a.m., e.g.) need no entry at all: the interior-dot rule
 * in isAbbreviation covers every one of them.
 */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc",
  "inc", "ltd", "co", "corp", "dept", "fig", "approx", "ave", "rd", "mt",
  "rev", "gen", "capt", "sgt", "jan", "feb", "mar", "apr", "jun", "jul",
  "aug", "sep", "sept", "oct", "nov", "dec",
]);

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function isLetter(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

/**
 * Is the `.` at `dot` the tail of an abbreviation rather than a full stop?
 *
 * Walks BACKWARDS over letters and dots — a loop, not a lookbehind, because
 * lookbehind is a syntax error in the WKWebView this deck runs in.
 *
 * Two rules, in order:
 *   - a token with an INTERIOR dot is an initialism (e.g / i.e / U.S / a.m),
 *   - a single-letter token is an initial (J. R. R. Tolkien).
 * Then the explicit list above, for the dotless ones.
 */
function isAbbreviation(s: string, dot: number): boolean {
  let i = dot - 1;
  while (i >= 0 && (isLetter(s[i]) || s[i] === ".")) i -= 1;
  const token = s.slice(i + 1, dot);
  if (!token) return false;
  if (token.indexOf(".") >= 0) return true;
  if (token.length === 1) return true;
  return ABBREVIATIONS.has(token.toLowerCase());
}

interface Span {
  text: string;
  /** Index in the source buffer where this chunk starts. */
  start: number;
  /** Index just past the chunk — where the next one begins. */
  end: number;
}

/**
 * Find every COMPLETE sentence in `s`, plus the index where the unfinished tail
 * begins. Pure, and index-carrying so the streaming caller can hand the tail
 * back verbatim instead of re-joining a guess at the whitespace.
 */
function scan(s: string): { spans: Span[]; restStart: number } {
  const spans: Span[] = [];
  let start = 0;

  const emit = (from: number, to: number) => {
    const text = s.slice(from, to).trim();
    if (text) spans.push({ text, start: from, end: to });
  };

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];

    // A line break is a hard boundary: her replies are markdown, and a bullet
    // is its own breath whether or not it carries a full stop.
    if (c === "\n") {
      emit(start, i);
      start = i + 1;
      continue;
    }

    if (TERMINATORS.indexOf(c) < 0) continue;

    // Consume a RUN of terminators, so "..." and "?!" are considered as one.
    let j = i;
    while (j + 1 < s.length && TERMINATORS.indexOf(s[j + 1]) >= 0) j += 1;

    // An ellipsis is a trailing-off pause inside a thought, not an end. Both
    // spellings: "..." and the single character.
    if ((c === "." && j > i) || c === "…") {
      i = j;
      continue;
    }

    // Take any closing quote/bracket with the sentence it closes.
    let k = j;
    while (k + 1 < s.length && CLOSERS.indexOf(s[k + 1]) >= 0) k += 1;

    const next = k + 1 < s.length ? s[k + 1] : "";
    // Mid-token dot: "3.14", "v1.2", "file.ts". Nothing to decide — a real
    // boundary is always followed by whitespace or the end of the text.
    if (next !== "" && !isSpace(next)) {
      i = k;
      continue;
    }
    if (c === "." && isAbbreviation(s, i)) {
      i = k;
      continue;
    }

    emit(start, k + 1);
    start = k + 1;
    i = k;
  }

  return { spans, restStart: start };
}

/**
 * Merge chunks that are too short to be worth a synthesis pass.
 *
 * `mergeTail` is the difference between the two callers: a complete text merges
 * a short LAST chunk backwards into its neighbour ("… green now. Copy."), while
 * the streaming caller must leave it alone so it can be rolled back into the
 * buffer and merged with whatever arrives next.
 */
function coalesce(spans: Span[], mergeTail: boolean): Span[] {
  const out: Span[] = [];
  let pending: Span | null = null;
  for (const span of spans) {
    pending = pending
      ? { text: `${pending.text} ${span.text}`, start: pending.start, end: span.end }
      : span;
    if (pending.text.length >= MIN_SENTENCE_CHARS) {
      out.push(pending);
      pending = null;
    }
  }
  if (pending) {
    const prev = mergeTail ? out.pop() : undefined;
    out.push(
      prev
        ? { text: `${prev.text} ${pending.text}`, start: prev.start, end: pending.end }
        : pending,
    );
  }
  return out;
}

/**
 * Break a chunk that is over the latency cap at the last soft break (or space)
 * before it. Never drops or reorders a character — the pieces re-join to the
 * original, which the unit test pins.
 */
function capLength(text: string): string[] {
  if (text.length <= MAX_SENTENCE_CHARS) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_SENTENCE_CHARS) {
    const window = rest.slice(0, MAX_SENTENCE_CHARS);
    let cut = -1;
    for (let i = window.length - 1; i > 0; i -= 1) {
      if (SOFT_BREAKS.indexOf(window[i]) >= 0) {
        cut = i + 1;
        break;
      }
    }
    if (cut < 0) cut = window.lastIndexOf(" ");
    // No break at all inside the window — a single enormous token. Hard-cut it
    // rather than looping forever.
    if (cut <= 0) cut = MAX_SENTENCE_CHARS;
    const head = rest.slice(0, cut).trim();
    if (head) out.push(head);
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Split PROSE into the chunks her voice will speak, in order. Pure and total.
 *
 * Input is expected to be speakable already — use toSpeakableSentences for a
 * raw brain reply, which strips fenced code first.
 */
export function splitSentences(prose: string): string[] {
  if (!prose || !prose.trim()) return [];
  const normalised = prose.replace(/\r\n/g, "\n");
  const { spans, restStart } = scan(normalised);
  const tail = normalised.slice(restStart).trim();
  const all = tail
    ? [...spans, { text: tail, start: restStart, end: normalised.length }]
    : spans;
  const out: string[] = [];
  for (const span of coalesce(all, true)) {
    for (const piece of capLength(span.text)) out.push(piece);
  }
  return out;
}

/**
 * The streaming form: everything that can be spoken NOW, plus the buffer tail
 * that is still arriving. `rest` is a verbatim slice of the input, so a caller
 * can append the next delta to it and call again with nothing lost.
 */
export function takeSentences(buffer: string): { sentences: string[]; rest: string } {
  if (!buffer) return { sentences: [], rest: "" };
  const { spans, restStart } = scan(buffer);
  const merged = coalesce(spans, false);
  let cut = restStart;
  const last = merged[merged.length - 1];
  // A complete-but-tiny final chunk is held back rather than spoken alone —
  // more text is on its way and will merge with it.
  if (last && last.text.length < MIN_SENTENCE_CHARS) {
    merged.pop();
    cut = last.start;
  }
  const sentences: string[] = [];
  for (const span of merged) {
    for (const piece of capLength(span.text)) sentences.push(piece);
  }
  return { sentences, rest: buffer.slice(cut) };
}

/**
 * A brain reply reduced to the chunks her voice may say: fenced code dropped by
 * speakableText (code-speech.ts — the SAME rule markdown.tsx sections the deck
 * by, so what is shown as code and what is skipped can never disagree), then
 * split.
 */
export function toSpeakableSentences(reply: string): string[] {
  return splitSentences(speakableText(reply));
}

// ── VOICE SELECTION ────────────────────────────────────────────────────────

/**
 * Operator override for the local voice, following deck-prefs.ts exactly: a
 * `stargate.*` localStorage key, every read wrapped (a disabled/full storage
 * throws on access and is not worth breaking her voice over), and a
 * `typeof window === "undefined"` guard so importing this on the server is
 * harmless (deck-prefs.ts:28-35).
 *
 * Precedence: localStorage (the live operator choice) beats
 * NEXT_PUBLIC_STARRA_LOCAL_VOICE (baked at build time) beats Cori.
 */
export const LOCAL_VOICE_KEY = "stargate.localVoice";

/** `en_GB-cori-high` — the shape every Piper voice id has. */
const VOICE_ID_SHAPE = /^[a-z]{2}_[A-Z]{2}-[a-z0-9_]+-(x_low|low|medium|high)$/;

function envVoice(): string | null {
  try {
    if (typeof process === "undefined") return null;
    const v = process.env.NEXT_PUBLIC_STARRA_LOCAL_VOICE;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

function storedVoice(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(LOCAL_VOICE_KEY);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null; // storage disabled — fall through to the default
  }
}

/**
 * The voice id to synthesise with. An override that is not shaped like a Piper
 * voice id is IGNORED rather than tried: a bad id makes TtsSession.create throw
 * on an unknown PATH_MAP key, and a typo in a setting must not cost her voice.
 */
export function getLocalVoiceId(): string {
  const override = storedVoice() ?? envVoice();
  if (override && VOICE_ID_SHAPE.test(override)) return override;
  return PIPER_VOICE_ID;
}

/** Set (or clear, with null) the local-voice override. deck-prefs.ts:37-49. */
export function setLocalVoiceId(voiceId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (voiceId) window.localStorage.setItem(LOCAL_VOICE_KEY, voiceId);
    else window.localStorage.removeItem(LOCAL_VOICE_KEY);
  } catch {
    /* quota/private mode — the setting just won't persist */
  }
}

// ── LOCAL ASSETS ───────────────────────────────────────────────────────────

const WASM_BASE = `${PIPER_VOICE_BASE}/wasm`;

/**
 * Where the runtime's own binaries live, on the deck, same-origin. Passing this
 * is what stops the library reaching cdnjs/jsdelivr — see the header.
 * The trailing slash on onnxWasm is required: onnxruntime joins a filename onto
 * it (`ort.env.wasm.wasmPaths` is a DIRECTORY).
 */
const LOCAL_WASM_PATHS = {
  onnxWasm: `${WASM_BASE}/ort/`,
  piperWasm: `${WASM_BASE}/piper_phonemize.wasm`,
  piperData: `${WASM_BASE}/piper_phonemize.data`,
};

/** Positive-only cache, per voice. piper-speak.ts:11-13 documents the rule: a
 * transient HEAD miss must not permanently disable her local voice. */
const assetsReady = new Set<string>();

async function headOk(path: string): Promise<boolean> {
  try {
    const res = await fetch(path, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Is every local asset in place for `voiceId`?
 *
 * All five checks are same-origin HEADs against the deck itself. A miss means
 * she stays SILENT — which is exactly today's private-lane behaviour — and
 * never that some other engine has a go.
 */
export async function localAssetsAvailable(
  voiceId: string = getLocalVoiceId(),
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (assetsReady.has(voiceId)) return true;
  const ok = await Promise.all([
    headOk(`${PIPER_VOICE_BASE}/${voiceId}.onnx`),
    headOk(`${PIPER_VOICE_BASE}/${voiceId}.onnx.json`),
    headOk(LOCAL_WASM_PATHS.piperWasm),
    headOk(LOCAL_WASM_PATHS.piperData),
  ]);
  const ready = ok.every(Boolean);
  if (ready) assetsReady.add(voiceId);
  return ready;
}

/**
 * Will a call to speakLocalStream actually produce sound?
 *
 * Assets present AND nothing else owns her voice. Callers use it to avoid
 * announcing "speaking" for audio that is never coming (a status line that
 * lies is the bug the private branch's own comment was written against).
 */
export async function localVoiceReady(): Promise<boolean> {
  if (getEngineState().callLive) return false;
  return localAssetsAvailable();
}

// ── SYNTHESIS ──────────────────────────────────────────────────────────────

type PiperModule = typeof import("@mintplex-labs/piper-tts-web");
type TtsSession = Awaited<ReturnType<PiperModule["TtsSession"]["create"]>>;

let modulePromise: Promise<PiperModule> | null = null;
let sessionPromise: Promise<TtsSession> | null = null;

/**
 * Copy the model out of the deck's public/ into OPFS under the exact filenames
 * the library reads by (`<voiceId>.onnx`, `<voiceId>.onnx.json` in the "piper"
 * directory — dist/piper-tts-web.js:143-183), so its getBlob finds them there
 * and the huggingface fetch never happens.
 */
async function seedOpfs(voiceId: string): Promise<boolean> {
  try {
    if (!navigator.storage?.getDirectory) return false;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("piper", { create: true });

    try {
      const existing = await dir.getFileHandle(`${voiceId}.onnx`);
      const file = await existing.getFile();
      if (file.size > 0) return true;
    } catch {
      /* not seeded yet — write it below */
    }

    const [onnx, json] = await Promise.all([
      fetch(`${PIPER_VOICE_BASE}/${voiceId}.onnx`),
      fetch(`${PIPER_VOICE_BASE}/${voiceId}.onnx.json`),
    ]);
    if (!onnx.ok || !json.ok) return false;

    const pairs: Array<[string, Blob]> = [
      [`${voiceId}.onnx`, await onnx.blob()],
      [`${voiceId}.onnx.json`, await json.blob()],
    ];
    for (const [name, blob] of pairs) {
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The ONE session, created with LOCAL paths.
 *
 * NOTE, and it is a real limitation rather than a preference: TtsSession keeps
 * a process-wide singleton and its constructor RETURNS the existing instance
 * with only `voiceId` swapped — `init()` never re-runs, so the loaded ONNX
 * model does not change (dist/piper-tts-web.js:259-272). Changing the
 * STARRA_LOCAL_VOICE override therefore takes effect on the next page load,
 * not mid-session.
 */
async function getSession(voiceId: string): Promise<TtsSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      if (!modulePromise) modulePromise = import("@mintplex-labs/piper-tts-web");
      const { PATH_MAP, TtsSession } = await modulePromise;
      const id = voiceId in PATH_MAP ? voiceId : PIPER_VOICE_ID;
      const seeded = await seedOpfs(id);
      if (!seeded) {
        // Without the model in OPFS the library would fetch huggingface. Refuse.
        throw new Error("local voice: model not seeded");
      }
      return TtsSession.create({
        voiceId: id,
        wasmPaths: LOCAL_WASM_PATHS,
      });
    })().catch((err) => {
      sessionPromise = null; // a failed init must not be cached forever
      throw err;
    });
  }
  return sessionPromise;
}

/** One sentence -> one WAV blob. Null on any failure; she just skips it. */
async function synthesize(text: string, voiceId: string): Promise<Blob | null> {
  try {
    const session = await getSession(voiceId);
    const wav = await session.predict(text.trim());
    return wav && wav.size > 0 ? wav : null;
  } catch {
    sessionPromise = null;
    return null;
  }
}

// ── PLAYBACK ───────────────────────────────────────────────────────────────

/**
 * ONE element for the life of the page. createMediaElementSource is
 * irreversible and may be called once PER ELEMENT, so a new element per
 * sentence would mean a new source node per sentence — and every one of them
 * stays graph-reachable, i.e. alive, in a deck Classic keeps open all day
 * (speak.ts:183-193 documents that leak). One element also means ONE analyser
 * that her face can hold onto across the whole reply.
 */
let el: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let ctx: AudioContext | null = null;
let tap: AnalyserNode | null = null;
let tapped = false;

/**
 * Monotonic id of the utterance allowed to play and to publish. Same device as
 * speak.ts's ttsGeneration (speak.ts:123-138): a stop bumps it, so a sentence
 * whose synthesis lands late can never start over a newer turn, and a late
 * `pause`/`error` from a killed element can never blank a live one.
 */
let generation = 0;
/** Settles the in-flight playback promise when a stop pauses the element. */
let settleActive: ((ok: boolean) => void) | null = null;
/**
 * True when the NEXT sentence's audio is already in hand. Consulted in the
 * `ended` handler: mid-reply the gap to the next sentence is a buffered
 * hand-off, not a stop, and blanking the bus for it would strobe her face.
 */
let nextReady = false;

function isCurrent(gen: number): boolean {
  return gen === generation;
}

function raise(): void {
  publishVoice({ speaking: true, source: "piper", analyser: tap });
}

/**
 * Retract, but only what we published. If the REALTIME leg owns the bus, a
 * finished local reply must not idle her face while she is still talking on the
 * call — the rule ttsBusPatch states at speak.ts:65-72.
 */
function retract(): void {
  const source = getEngineState().source;
  if (source !== null && source !== "piper") return;
  publishVoice({ speaking: false, source: null });
}

function ensureElement(): HTMLAudioElement | null {
  if (typeof window === "undefined" || typeof Audio !== "function") return null;
  if (!el) {
    el = new Audio();
    el.preload = "auto";
  }
  return el;
}

function revokeCurrent(): void {
  if (!currentUrl) return;
  try {
    URL.revokeObjectURL(currentUrl);
  } catch {
    /* already gone */
  }
  currentUrl = null;
}

/**
 * Route the element through an analyser so her mouth can follow her real voice.
 *
 * HER VOICE OUTRANKS HER MOUTH. This is never awaited before play() and every
 * failure path leaves her talking with no analyser rather than not talking —
 * the ordering speak.ts:397-410 argues for. Capture happens ONCE, only with the
 * context confirmed "running" (createMediaElementSource is irreversible: after
 * it, the element's sound reaches the speakers only through this graph, so
 * capturing into a suspended context would mute her).
 */
async function attachAnalyser(audio: HTMLAudioElement, gen: number): Promise<void> {
  try {
    if (!MOUTH_SYNC_ENABLED) return;
    if (tapped) return;
    if (typeof window === "undefined") return;
    const w = window as unknown as {
      AudioContext?: new () => AudioContext;
      webkitAudioContext?: new () => AudioContext;
    };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (typeof Ctor !== "function") return;
    if (!ctx) {
      ctx = new Ctor();
      try {
        ctx.addEventListener?.("statechange", () => {
          if (ctx && ctx.state === "suspended" && tapped) {
            try {
              void ctx.resume?.();
            } catch {
              /* best effort */
            }
          }
        });
      } catch {
        /* listener unsupported — the gate below still protects us */
      }
    }
    const audioCtx = ctx;
    if (typeof audioCtx.createMediaElementSource !== "function") return;
    if (audioCtx.state !== "running") {
      try {
        await audioCtx.resume?.();
      } catch {
        /* fall through to the gate */
      }
    }
    if (audioCtx.state !== "running") return; // THE GATE — do not capture
    if (!tap) {
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      // viseme-sync does its own asymmetric smoothing; double-smoothing here
      // would only add lag (speak.ts:464-466).
      analyser.smoothingTimeConstant = 0;
      analyser.connect(audioCtx.destination);
      tap = analyser;
    }
    audioCtx.createMediaElementSource(audio).connect(tap);
    tapped = true;
    // The analyser exists now — republish so her face picks it up mid-sentence
    // rather than at the next one. Guarded on BOTH the generation and the
    // element's real state: everything above is awaited, so this can land after
    // a barge-in, and an unguarded raise() here would announce "speaking" over
    // silence — the exact drift the bus exists to prevent (speak.ts:65-72).
    if (isCurrent(gen) && !audio.paused && !audio.ended) raise();
  } catch {
    /* she keeps her voice, she just has no mouth data */
  }
}

/**
 * Play one WAV to its end. Resolves true when it finished, false on stop,
 * error, or a play() the browser refused.
 *
 * EVERY publish in here comes from the element's own events. `playing` (not
 * `play`) is the one that means sound is actually being rendered.
 */
function playBlob(wav: Blob, gen: number): Promise<boolean> {
  const audio = ensureElement();
  if (!audio) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    // Re-bound inside the executor: the handlers below are hoisted function
    // declarations, and TypeScript will not carry the outer null-narrowing into
    // one of those (it can be called before the check, as far as CFA knows).
    const media: HTMLAudioElement = audio;
    let settled = false;

    const detach = () => {
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("error", onError);
      if (settleActive === finish) settleActive = null;
    };

    function finish(ok: boolean) {
      if (settled) return;
      settled = true;
      detach();
      resolve(ok);
    }

    function onPlaying() {
      if (!isCurrent(gen)) return;
      raise();
      void attachAnalyser(media, gen);
    }

    function onEnded() {
      // Mid-reply this is a hand-off, not a stop: hold the bus if the next
      // sentence is already in hand, so her face does not strobe between them.
      if (isCurrent(gen) && !nextReady) retract();
      finish(true);
    }

    function onPause() {
      // A stop pauses the element; the end of a file also pauses it in some
      // engines. `ended` disambiguates, and finish() is idempotent either way.
      if (isCurrent(gen) && !nextReady) retract();
      finish(media.ended === true);
    }

    function onError() {
      if (isCurrent(gen)) retract();
      finish(false);
    }

    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("error", onError);
    settleActive = finish;

    const url = URL.createObjectURL(wav);
    revokeCurrent();
    currentUrl = url;
    try {
      audio.src = url;
      audio.currentTime = 0;
    } catch {
      /* a fresh element can refuse currentTime before metadata — harmless */
    }
    void audio.play().catch(() => finish(false));
  });
}

/**
 * BARGE-IN. Kill the queue, the element and the bus claim.
 *
 * Called by speak.ts's stopAllSpeech (the one-way seam: speak.ts imports this,
 * never the reverse — importing speak.ts here would drag the /api/tts module
 * into the private lane) and by speakLocalStream itself before a new reply.
 *
 * HONEST LIMIT: TtsSession.predict exposes no cancellation, so synthesis
 * already in flight runs to completion in its worker. What the generation bump
 * guarantees is that its result is DISCARDED — a stale sentence can never reach
 * the element, which is the part that would be audible.
 */
export function stopLocalStream(): void {
  generation += 1;
  nextReady = false;
  try {
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
  } catch {
    /* ignore */
  }
  revokeCurrent();
  const settle = settleActive;
  settleActive = null;
  if (settle) settle(false);
  retract();
}

/** What speakLocalStream did, in the same shape speak.ts reports engines. */
export type LocalSpeakResult = "piper" | "none";

export interface LocalSpeakOptions {
  /**
   * Only the engine that RAISED the call claim may speak during a call — the
   * all-local call speaks its own replies through here. Everything else
   * (the deck's chat lane) must stay silent while a call is live: ONE VOICE,
   * the same gate speakStarra takes at speak.ts:764.
   */
  allowDuringCall?: boolean;
}

/**
 * Speak `text` in her local voice, sentence by sentence, synthesising the next
 * one while the current one plays.
 *
 * Returns "piper" only if sound actually came out. Everything else — missing
 * assets, a live call, an abort, a synthesis failure — returns "none" and she
 * is simply silent, which is the private lane's existing behaviour and never a
 * fallback that leaves the machine.
 */
export async function speakLocalStream(
  text: string,
  signal?: AbortSignal,
  options?: LocalSpeakOptions,
): Promise<LocalSpeakResult> {
  if (typeof window === "undefined") return "none";
  const sentences = toSpeakableSentences(text);
  if (sentences.length === 0) return "none";

  if (!options?.allowDuringCall && getEngineState().callLive) {
    stopLocalStream();
    return "none";
  }

  const voiceId = getLocalVoiceId();
  if (!(await localAssetsAvailable(voiceId))) return "none";
  if (signal?.aborted) return "none";

  // Claim her voice. Bumped AFTER the availability check so a turn that was
  // never going to speak cannot cancel one that is speaking.
  stopLocalStream();
  const gen = generation;

  const onAbort = () => {
    if (isCurrent(gen)) stopLocalStream();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  let spoke = false;
  try {
    // THE PIPELINE: sentence N+1 is queued for synthesis before sentence N is
    // played, so the synth worker and the speakers are busy at the same time.
    let pending: Promise<Blob | null> | null = synthesize(sentences[0], voiceId);
    for (let i = 0; i < sentences.length; i += 1) {
      const wav = await pending;
      if (!isCurrent(gen) || signal?.aborted) break;

      nextReady = false;
      if (i + 1 < sentences.length) {
        pending = synthesize(sentences[i + 1], voiceId).then((next) => {
          if (isCurrent(gen) && next) nextReady = true;
          return next;
        });
      } else {
        pending = null;
      }

      if (!wav) continue; // one sentence failed to synthesise — keep going
      const played = await playBlob(wav, gen);
      if (played) spoke = true;
      if (!isCurrent(gen) || signal?.aborted) break;
    }
    // Nothing more is coming: whatever the last `ended` held for the hand-off
    // is released here, from a real end of playback.
    if (isCurrent(gen)) {
      nextReady = false;
      retract();
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  return spoke ? "piper" : "none";
}
