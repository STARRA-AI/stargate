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
import { MOUTH_SYNC_ENABLED } from "@/lib/voice/viseme-sync";
// THE BARGE-IN SEAM, and it is one-way ON PURPOSE: speak.ts imports the local
// mouth, never the reverse. local-voice.ts is the only engine a PRIVATE reply
// may reach, so it must not be able to drag this module — the one that POSTs to
// /api/tts — into the private lane behind it. A registry in here would do the
// same damage (local-voice would have to import this file to register), so the
// direct import is the smallest seam that keeps the lane clean. stopLocalStream
// is a no-op when nothing local is playing, which is what keeps every normal
// turn byte-identical.
import { stopLocalStream } from "@/lib/voice/local-voice";
// ENGINE BUS — client-safe, secret-free, synchronous, never-throwing. Importing
// "@/lib/engine/bus" (never "@/lib/engine") is what keeps config/providers/router
// — the modules that resolve credentials — out of this client bundle.
import { getEngineState, publishVoice, type VoiceSource } from "@/lib/engine/bus";

export { PIPER_VOICE_ID };

export type SpeakEngine = "ara" | "piper" | "webspeech" | "none";

// ── AUDIO TRUTH + the mouth-sync tap ───────────────────────────────────────
/**
 * What her voice is ACTUALLY doing right now, for anything that has to be in
 * sync with sound rather than with text.
 *
 * WHY THIS EXISTS. The call overlay used to decide "she is speaking" from the
 * streaming TEXT (`streaming.trim().length > 0`), which is exactly inverted:
 * stargate-context.tsx clears the text mirror BEFORE awaiting the TTS
 * round-trip, so her face animated through the silent token stream and flipped
 * to the idle pool right as her voice began. `playing` is set from the audio
 * element's own events, so it cannot drift from the sound.
 */
export interface TtsAudioSnapshot {
  /** True only while her voice is actually being produced. */
  playing: boolean;
  /**
   * Analyser on her TTS output, or null when a tap could not be made safely.
   * Null is a normal state — consumers must render their no-analyser behaviour.
   */
  analyser: AnalyserNode | null;
}

let ttsSnapshot: TtsAudioSnapshot = { playing: false, analyser: null };
const ttsListeners = new Set<(s: TtsAudioSnapshot) => void>();

/** Which engine is rendering THIS utterance. Every leg below sets it before it
 * publishes `playing: true`, so the bus can name the voice she is speaking in. */
export type TtsBusSource = Exclude<VoiceSource, "realtime">;
let ttsEngine: TtsBusSource = null;

/** The three engines this module owns. Deliberately NOT "realtime" — see below. */
const TTS_BUS_SOURCES: readonly string[] = ["ara", "piper", "webspeech"];

/**
 * The engine-bus patch this module should publish for `snapshot`, or null for
 * "say nothing". Pure and total so the rule can be pinned down in a unit test
 * (tests/bus-adoption-selectors.test.ts) instead of only observed in a browser.
 *
 * THE RULE — A PUBLISHER MAY ONLY RETRACT WHAT IT PUBLISHED. When sound is coming
 * out we publish speaking + engine + analyser in ONE patch, so "she is speaking"
 * and "the thing that drives her mouth" can never drift (that drift is the filmed
 * bug: the header said speaking for 8+ seconds over a shut mouth). When it stops
 * we retract — but ONLY if the bus is silent or a TTS engine still owns it. If the
 * REALTIME leg owns it, a finished typed reply must not blank it: that would idle
 * her face and drop her mouth's analyser while she is still talking on the call.
 * Retraction also never touches `analyser`, for the same reason.
 */
export function ttsBusPatch(
  snapshot: TtsAudioSnapshot,
  engine: TtsBusSource,
  currentBusSource: string | null,
): { speaking: boolean; source: TtsBusSource; analyser?: AnalyserNode | null } | null {
  if (snapshot.playing) {
    return { speaking: true, source: engine, analyser: snapshot.analyser };
  }
  if (currentBusSource !== null && !TTS_BUS_SOURCES.includes(currentBusSource)) return null;
  return { speaking: false, source: null };
}

/**
 * Mirror the local audio truth onto the engine bus.
 *
 * HER VOICE OUTRANKS THE BUS. This is called from inside publishTts, i.e. from
 * `playing`/`pause`/`ended`/`error` handlers and from the settle funnel — never
 * before audio.play(), never with an await, and never in a position where it can
 * reorder anything. It is synchronous, allocation-light and wrapped: publishVoice
 * already swallows everything internally, and this try/catch is the second belt so
 * that even a broken bus module cannot throw into her audio path.
 */
function mirrorTtsToEngineBus(): void {
  try {
    const patch = ttsBusPatch(ttsSnapshot, ttsEngine, getEngineState().source);
    if (patch) publishVoice(patch);
  } catch {
    /* the bus is best-effort OBSERVATION — her voice never depends on it */
  }
}

function publishTts(patch: Partial<TtsAudioSnapshot>) {
  const next = { ...ttsSnapshot, ...patch };
  if (next.playing === ttsSnapshot.playing && next.analyser === ttsSnapshot.analyser) {
    return;
  }
  ttsSnapshot = next;
  for (const fn of ttsListeners) {
    try {
      fn(ttsSnapshot);
    } catch {
      /* a bad listener must never break her voice */
    }
  }
  // Existing local subscribers are served FIRST; the bus is downstream of them so
  // adoption cannot delay the consumer that was already there.
  mirrorTtsToEngineBus();
}

/**
 * Monotonic id of the utterance that is allowed to publish audio truth.
 *
 * THE BUG THIS CLOSES — A SUPERSEDED UTTERANCE BLANKING A LIVE ONE. Every leg
 * below reports `playing` from its own engine's events, and those events land a
 * task LATE. A new turn calls stopAllSpeech() (which cancels Web Speech / pauses
 * the element) and then immediately starts speaking; the OLD utterance's
 * `error` / `end` / `pause` then fires with its promise still unsettled, so its
 * own `settled` guard does not apply, and it publishes `playing: false` over the
 * NEW utterance — her face idles while she is audibly talking. That is the exact
 * shape of the filmed drift bug, one turn removed.
 *
 * Bumping this at the top of speakStarra and stamping each leg with the value it
 * was born under makes a stale publish a no-op. It can only ever suppress a
 * publish from an utterance that has already been replaced.
 */
let ttsGeneration = 0;

/** Claim the next utterance generation. Called once per speakStarra. */
export function beginUtterance(): number {
  ttsGeneration += 1;
  return ttsGeneration;
}

/** True only for the most recently claimed generation. */
export function isCurrentUtterance(generation: number): boolean {
  return generation === ttsGeneration;
}

/** publishTts, but only if `generation` still owns her voice. */
function publishTtsFor(generation: number, patch: Partial<TtsAudioSnapshot>): void {
  if (!isCurrentUtterance(generation)) return;
  publishTts(patch);
}

/** Current audio truth. */
export function getTtsAudio(): TtsAudioSnapshot {
  return ttsSnapshot;
}

/** Subscribe to audio truth; returns an unsubscribe. Fires on every change. */
export function subscribeTtsAudio(fn: (s: TtsAudioSnapshot) => void): () => void {
  ttsListeners.add(fn);
  return () => {
    ttsListeners.delete(fn);
  };
}

/**
 * Shared WebAudio graph for the TTS element. ONE context and ONE analyser reused
 * for every utterance: createMediaElementSource can only be called once per
 * element (so the source node is per-utterance), but browsers cap the number of
 * AudioContexts, so the context itself must not be.
 */
let ttsCtx: AudioContext | null = null;
let ttsTap: AnalyserNode | null = null;
const tapped = new WeakSet<HTMLAudioElement>();

type AudioCtxCtor = new () => AudioContext;

/**
 * The CURRENT utterance's source node, kept so it can be disconnected.
 *
 * WHY A HANDLE IS MANDATORY, not tidy-up. `ttsTap` is permanently wired to
 * ctx.destination, so every MediaElementAudioSourceNode we create stays
 * GRAPH-REACHABLE for the life of the page — and a source node holds a strong
 * reference to its <audio> element. Without disconnecting, one node plus one
 * element leaked PER UTTERANCE, forever, in a deck Classic keeps open all day,
 * and every one of them was still pulled each render quantum. The `tapped`
 * WeakSet cannot help: the graph EDGE is the strong reference, not the set.
 * Same pattern as the call path already uses (useVoiceCall.ts:429-435).
 */
let ttsSrc: { node: AudioNode; audio: HTMLAudioElement } | null = null;

/** Longest we will EVER wait on AudioContext.resume(). See settleWithin. */
const RESUME_TIMEOUT_MS = 250;

/**
 * `resume()` without assuming it returns a promise — the older WebKit form is
 * callback-based and returns undefined, where `.resume().catch()` would throw a
 * TypeError instead of resuming anything.
 */
function callResume(ctx: AudioContext): unknown {
  try {
    return ctx.resume?.();
  } catch {
    return undefined;
  }
}

/**
 * Await `p` but NEVER longer than `ms`, and never reject.
 *
 * THE BUG THIS EXISTS FOR: `await ctx.resume().catch(() => {})` looks safe and is
 * not. `.catch()` handles REJECTION, not PENDENCY — under the autoplay policy a
 * context created without prior user activation is "suspended" and resume() is
 * QUEUED until activation arrives, so the promise can simply never settle. Any
 * await of it is an unbounded await.
 */
function settleWithin(p: unknown, ms: number): Promise<void> {
  const thenable =
    !!p &&
    (typeof p === "object" || typeof p === "function") &&
    typeof (p as PromiseLike<unknown>).then === "function";
  if (!thenable) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    (p as PromiseLike<unknown>).then(
      () => {
        clearTimeout(timer);
        finish();
      },
      () => {
        clearTimeout(timer);
        finish();
      },
    );
  });
}

// ── BOUNDED-TIMING PRIMITIVES ──────────────────────────────────────────────
// Both of the confirmed bugs in her voice path were timing bugs, and neither is
// observable outside a browser. They are extracted here as pure/total functions
// so the RULES are pinned down in tests/voice-debug-timing.test.ts rather than
// only believed. Nothing here touches audio.

/**
 * A deadline that can be pushed out, but never switched off.
 *
 * `extend` is the ONLY control on purpose. An earlier draft also exposed a
 * `disarm()`; that would hand the caller a way back to the exact unbounded await
 * this primitive exists to kill, so the deadline is always armed and the returned
 * promise is therefore always bounded.
 */
export interface SynthesisDeadline {
  /** Re-arm for `ms` from NOW, replacing whatever window was pending. */
  extend(ms: number): void;
}

export interface DeadlineOutcome<T> {
  /** The work's value, or null when the deadline fired or the work rejected. */
  value: T | null;
  /** True ONLY when the deadline fired before the work settled. */
  timedOut: boolean;
}

/**
 * Run `start(deadline)` under a deadline that bounds GETTING SOUND OUT, never
 * the sound itself. Resolves — never rejects.
 *
 * THE BUG THIS EXISTS FOR (confirmed). The Piper leg below used to be:
 *
 *   piperOk = await Promise.race([ speakPiper(text, piperAc.signal),
 *     new Promise(r => setTimeout(() => { timedOut = true; piperAc.abort();
 *                                         r(false); }, 4_000)) ])
 *
 * and `speakPiper` resolves on its element's `ended` (piper-runtime.ts). So the
 * 4s raced the WHOLE UTTERANCE: any reply longer than four seconds was aborted
 * mid-word and then re-spoken IN FULL by the next fallback engine, in a
 * different voice. Raising the number only moves that cliff. The fix is to bound
 * each STEP: the caller extends the window when synthesis lands (buying a
 * play-start window) and again from real playback progress, so an utterance of
 * any length runs to the end while a genuinely stalled one is still caught.
 *
 * `onTimeout` is the caller's cancel hook and runs BEFORE the outcome resolves,
 * so a losing engine is aborted rather than left to talk over its replacement.
 */
export function withSynthesisDeadline<T>(
  start: (deadline: SynthesisDeadline) => Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<DeadlineOutcome<T>> {
  return new Promise<DeadlineOutcome<T>>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const finish = (out: DeadlineOutcome<T>) => {
      if (settled) return;
      settled = true;
      clear();
      resolve(out);
    };
    const arm = (delay: number) => {
      clear();
      if (settled) return; // done already — never leave a timer behind
      timer = setTimeout(() => {
        timer = null;
        try {
          onTimeout();
        } catch {
          /* a cancel hook must never take her voice down with it */
        }
        finish({ value: null, timedOut: true });
      }, delay);
    };
    const deadline: SynthesisDeadline = { extend: (next: number) => arm(next) };
    arm(ms);
    let work: Promise<T>;
    try {
      work = start(deadline);
    } catch {
      // A synchronous throw out of the factory (a failed dynamic import, say) is
      // a plain miss, not a timeout — the caller must not also fire its abort.
      finish({ value: null, timedOut: false });
      return;
    }
    work.then(
      (value) => finish({ value, timedOut: false }),
      () => finish({ value: null, timedOut: false }),
    );
  });
}

/**
 * Slowest plausible Web Speech delivery, in ms per character, at rate 1.0.
 *
 * THE ARITHMETIC, shown because the whole point is that this window may only
 * ever catch a WEDGE and must never cut a healthy long reply short:
 *   · English averages ~5.1 letters/word, +1 space ≈ 6 characters per word.
 *   · A deliberately SLOW 100 wpm is 600 chars/min = 10 chars/s = 100 ms/char.
 *   · Real TTS voices deliver ~150-190 wpm, so 100 ms/char over-estimates the
 *     true duration by roughly 1.6-1.9x.
 * Divided by the utterance's own `rate` (STARRA_RATE = 0.95, voice-select.ts:12)
 * for actual delivery speed. Worked example: a genuine 60-second reply at 175 wpm
 * x 0.95 ≈ 166 wpm ≈ 166 words ≈ 996 chars, giving 996 x 100 / 0.95 ≈ 104.8 s of
 * window for 60 s of speech — 1.75x headroom.
 *
 * DELIBERATELY UNCAPPED. A ceiling would re-introduce exactly the cliff that
 * bug A was: the guarantee needed here is "no PERMANENT wedge", and the window
 * is already derived from the finite text she was handed.
 */
export const WEBSPEECH_MS_PER_CHAR = 100;
/**
 * Floor. "Copy." is 5 characters ≈ 500 ms by the estimate above, which is
 * shorter than the queue/voice-load delay before `onstart` even fires, so
 * without a floor the watchdog would fire on a perfectly healthy short line.
 */
export const WEBSPEECH_MIN_WATCHDOG_MS = 8_000;

/** How long a Web Speech utterance of `chars` characters may go without an
 * `end`/`error`/`boundary` before it is treated as wedged. Never below the
 * floor, and never 0 for junk input. */
export function webSpeechWatchdogMs(chars: number, rate: number): number {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const c = Number.isFinite(chars) && chars > 0 ? chars : 0;
  return Math.max(
    WEBSPEECH_MIN_WATCHDOG_MS,
    Math.ceil((c * WEBSPEECH_MS_PER_CHAR) / r),
  );
}

/** Disconnect the tapped source node. Pass an element to release only that one. */
function releaseTtsSource(audio?: HTMLAudioElement | null): void {
  if (!ttsSrc) return;
  if (audio && ttsSrc.audio !== audio) return;
  try {
    ttsSrc.node.disconnect();
  } catch {
    /* already gone — nothing to do */
  }
  ttsSrc = null;
}

/**
 * Route `audio` through an analyser so her mouth can follow her real voice.
 *
 * HER VOICE OUTRANKS HER MOUTH, STRUCTURALLY. Nothing in here is on the critical
 * path any more: speakAra calls audio.play() FIRST and only then fires this off
 * without awaiting it (see the ordering comment there). So a suspended context,
 * a resume() that never settles, a missing API — none of it can delay or prevent
 * her voice. The worst case is that she talks with the clip's filmed lips.
 *
 * Two further safeties are kept: createMediaElementSource is IRREVERSIBLE (once
 * captured, the element's sound only reaches the speakers through this graph),
 * so we capture ONLY with the context confirmed "running"; and every resume() is
 * bounded by settleWithin.
 */
async function attachTtsAnalyser(audio: HTMLAudioElement): Promise<void> {
  try {
    // ── OPT-IN. Nothing below runs unless her mouth is actually being watched.
    // The documented kill switch has to really kill this path...
    if (!MOUTH_SYNC_ENABLED) return;
    // ...and nothing consumes the analyser unless the call overlay is OPEN:
    // subscribeTtsAudio has exactly one caller (VoiceCallOverlay.tsx, whose
    // subscription is gated on `open`) and StarraClipFace is the only consumer.
    // So a typed DeckConsole reply or a wake-word reply on the plain deck now
    // never touches an AudioContext at all — it took 100% of the WebAudio risk
    // for 0% of the benefit.
    if (ttsListeners.size === 0) return;
    if (typeof window === "undefined") return;
    const w = window as unknown as {
      AudioContext?: AudioCtxCtor;
      webkitAudioContext?: AudioCtxCtor;
    };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (typeof Ctor !== "function") return; // no WebAudio on this engine
    if (tapped.has(audio)) return; // one source node per element, ever

    if (!ttsCtx) {
      ttsCtx = new Ctor();
      // Watchdog: if the context is ever suspended while an element is routed
      // through it (tab hidden, OS audio change), her voice would go quiet.
      // Nudge it back whenever that happens — bounded, and never awaited.
      try {
        ttsCtx.addEventListener?.("statechange", () => {
          if (ttsCtx && ttsCtx.state === "suspended" && (ttsSnapshot.playing || ttsSrc)) {
            void settleWithin(callResume(ttsCtx), RESUME_TIMEOUT_MS);
          }
        });
      } catch {
        /* listener unsupported — the pre-attach gate below still protects us */
      }
    }
    const ctx = ttsCtx;
    if (typeof ctx.createMediaElementSource !== "function") return;

    // Autoplay policy: the context may start "suspended" until a gesture. Give
    // resume() a bounded chance; it can never pend forever here.
    if (ctx.state !== "running") {
      await settleWithin(callResume(ctx), RESUME_TIMEOUT_MS);
    }
    // THE GATE. Still not running -> do NOT capture the element.
    if (ctx.state !== "running") return;
    // Playback may already have finished, or a barge-in may have landed, while
    // that bounded wait ran. Capturing a dead/superseded element is pointless.
    if (araAudio !== audio) return;

    if (!ttsTap) {
      const tap = ctx.createAnalyser();
      tap.fftSize = 1024;
      // We do our own asymmetric smoothing in viseme-sync; double-smoothing
      // here would only add lag.
      tap.smoothingTimeConstant = 0;
      tap.connect(ctx.destination);
      ttsTap = tap;
    }
    releaseTtsSource(); // never leave two source nodes wired to the tap
    const src = ctx.createMediaElementSource(audio);
    tapped.add(audio);
    src.connect(ttsTap);
    ttsSrc = { node: src, audio };
    publishTts({ analyser: ttsTap });
    // The element is now irreversibly captured. If the context slipped out of
    // "running" between the gate and here, nudge it back rather than leaving
    // her routed into a graph that renders nowhere.
    if (ctx.state !== "running") {
      void settleWithin(callResume(ctx), RESUME_TIMEOUT_MS);
    }
  } catch {
    // Any failure at all: she keeps her voice, she just has no mouth data.
  }
}

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

/**
 * How long an Ara element may sit without ever reaching `playing`. The blob is
 * already fully downloaded by the time play() is called, so anything past a few
 * hundred ms is broken; 4s matches the existing Piper race ceiling below rather
 * than inventing a second number, and is generous enough that a slow decode on a
 * loaded machine cannot false-positive.
 */
const PLAY_START_TIMEOUT_MS = 4_000;
/**
 * Slack on top of the audio's REMAINING duration before we call it wedged.
 * Re-armed on every `timeupdate` (~4x/second while sound is being produced), so
 * this only ever fires when progress has genuinely stopped.
 */
const PROGRESS_GRACE_MS = 5_000;

/**
 * Longest she may stay SILENT while Piper synthesises before we give up and let
 * a fallback engine have the reply. Deliberately still 4s — the same amount of
 * dead air the old race allowed — because the bug was never that 4s was too
 * short, it was that those 4s also bounded PLAYBACK (see withSynthesisDeadline).
 */
const PIPER_SYNTH_TIMEOUT_MS = 4_000;
/**
 * Once synthesis lands, how long the element gets to actually reach `playing`.
 * The WAV is fully in memory by then, so this is enormous headroom; it reuses
 * the Ara ceiling rather than inventing a second number for the same situation.
 */
const PIPER_PLAY_START_TIMEOUT_MS = PLAY_START_TIMEOUT_MS;

function stopAraAudio() {
  if (araAudio) {
    try {
      araAudio.pause();
      araAudio.src = "";
    } catch {
      /* ignore */
    }
    // Drop the WebAudio edge too, or the source node and this element stay
    // graph-reachable — and therefore alive — for the life of the page.
    releaseTtsSource(araAudio);
    araAudio = null;
  }
  // Pausing fires no `ended`/`pause` handler we own here, so the audio-truth
  // flag has to be cleared explicitly or her face would latch on "speaking".
  publishTts({ playing: false });
  if (araSettle) {
    const settle = araSettle;
    araSettle = null;
    settle();
  }
}

export function stopAllSpeech() {
  stopAraAudio();
  stopPiperAudio();
  // The local mouth runs its own QUEUE, so a barge-in that only stopped the
  // engines above would leave the next queued sentence to start on top of the
  // new turn. This kills the queue, the element and its bus claim too.
  stopLocalStream();
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

/**
 * Ara (xAI TTS) via the server /api/tts proxy — preferred online voice.
 * Returns false on any miss (no key → 204, network/offline, aborted, decode
 * failure) so speakStarra falls through to Piper. Key never touches the client.
 */
async function speakAra(
  text: string,
  signal: AbortSignal | undefined,
  generation: number,
): Promise<boolean> {
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
    // Tag the engine BEFORE any publish can fire for this utterance. Set here
    // rather than in the `playing` handler because attachTtsAnalyser also
    // publishes (the analyser), and the two orders are not guaranteed.
    ttsEngine = "ara";

    // A barge-in may have landed while the blob was downloading. araSettle is
    // not armed yet, so nothing else would catch it and she would talk over
    // herself. (This used to also cover an `await attachTtsAnalyser` here; that
    // await is GONE — see the ordering comment below.)
    if (signal?.aborted) {
      if (araAudio === audio) araAudio = null;
      URL.revokeObjectURL(url);
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let watchdog = 0;
      let heardSound = false;
      const cleanup = () => URL.revokeObjectURL(url);
      // Settles this promise exactly once, from any path (ended/error/abort/
      // play-failure/external stopAraAudio), and clears the shared resolver
      // so a later, unrelated stopAraAudio() call is a no-op.
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(watchdog);
        signal?.removeEventListener("abort", onAbort);
        // Terminal path — ended / error / abort / play-failure / external stop /
        // watchdog. Every one of them must drop the WebAudio edge (see ttsSrc).
        releaseTtsSource(audio);
        if (araSettle === settleFalse) araSettle = null;
        // Audio truth off on EVERY exit path (ended / error / abort /
        // play-failure / external stop), so a failed TTS can never leave her
        // face stuck in "speaking". Generation-stamped: if a NEWER utterance has
        // already taken her voice, this one may not retract its "speaking".
        publishTtsFor(generation, { playing: false });
        cleanup();
        resolve(ok);
      };
      const settleFalse = () => settle(false);
      araSettle = settleFalse;
      const onAbort = () => {
        try {
          audio.pause();
          audio.src = ""; // release the decoder now, as stopAraAudio does
        } catch {
          /* ignore */
        }
        // Consistent with onended/onerror: a dead element must not stay pinned
        // as the "active" one across what may be a long silence. (It used to be
        // left set here; the next stopAllSpeech cleaned it up eventually.)
        if (araAudio === audio) araAudio = null;
        settle(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      // ── STALL WATCHDOG ────────────────────────────────────────────────────
      // This promise otherwise settles ONLY on ended / error / abort / external
      // stop / a rejected play(). Routing the element into WebAudio adds a
      // failure that fires NONE of those: if the context leaves "running" after
      // the element is captured (OS output-device change, Bluetooth handoff,
      // WebKit audio-session interruption) it renders nowhere — no sound, no
      // `ended`, no `error`. Without a bound, hudState pins to "speaking"
      // (stargate-context.tsx awaits this) and the wake loop starves
      // (useVoiceLoop.ts:291). Same spirit as the Piper race below.
      const onWedged = () => {
        // Stop the element FIRST so a fallback engine can never talk over it.
        try {
          audio.pause();
          audio.src = "";
        } catch {
          /* ignore */
        }
        if (araAudio === audio) araAudio = null;
        // If sound DID come out, report SUCCESS: re-speaking the whole reply
        // through Piper would repeat her out loud. If nothing ever played,
        // report failure so the fallback engine gets its chance — better a
        // second-choice voice than silence. Either way the turn moves on.
        settle(heardSound);
      };
      const armWatchdog = (ms: number) => {
        window.clearTimeout(watchdog);
        if (settled) return; // done already — never leave a timer behind
        watchdog = window.setTimeout(onWedged, ms);
      };
      // Time still owed on this utterance, when the blob's duration is known.
      const armForProgress = () => {
        const d = audio.duration;
        const t = audio.currentTime;
        const left =
          Number.isFinite(d) && d > 0 && Number.isFinite(t) ? (d - t) * 1000 : 0;
        armWatchdog((left > 0 ? left : 0) + PROGRESS_GRACE_MS);
      };

      // `playing` (not `play`) is the event that means sound is actually coming
      // out — `play` fires on the attempt, before any audio is rendered.
      // addEventListener rather than the on* slots so nothing above is clobbered.
      audio.addEventListener("playing", () => {
        // A SETTLED or SUPERSEDED element must never publish `playing: true`.
        // Without this guard a late `playing` from a dead element re-latches
        // "speaking" with nobody left to retract it — her face would animate
        // over silence for the rest of the session (the worst failure shape
        // there is: a permanent latch).
        if (settled || araAudio !== audio) return;
        heardSound = true;
        publishTtsFor(generation, { playing: true });
        armForProgress();
      });
      // Real progress proves the element is alive, so re-arm from it. timeupdate
      // fires ~4x/second during playback, so a healthy utterance of any length
      // never trips the watchdog.
      audio.addEventListener("timeupdate", armForProgress);
      audio.addEventListener("pause", () => {
        // settle() has already published `playing: false` on every terminal
        // path, and it pauses the element itself (onAbort/onWedged). The `pause`
        // event that follows lands a task later — by which time a NEWER
        // utterance may already have published `playing: true`, and this would
        // blank it: her face idles while she is audibly talking.
        if (settled) return;
        publishTtsFor(generation, { playing: false });
      });
      audio.onended = () => {
        if (araAudio === audio) araAudio = null;
        settle(true);
      };
      audio.onerror = () => {
        if (araAudio === audio) araAudio = null;
        settle(false);
      };

      // ── HER VOICE FIRST. NOTHING ABOUT HER MOUTH IS ON THIS PATH. ─────────
      // play() is reached with NO preceding await of any kind, so no WebAudio
      // state — a suspended context, a resume() that never settles under the
      // autoplay policy, a slow AudioContext construction — can delay or prevent
      // her voice. The tap is attached AFTERWARDS and never awaited:
      // createMediaElementSource on an already-playing element simply redirects
      // its output into the graph, and the few ms of direct playback before that
      // switch is inaudible. (This used to be `await attachTtsAnalyser(audio)`
      // ABOVE the promise, i.e. an unbounded await sitting in front of the only
      // audio.play() in the file — total silence if resume() never settled.)
      armWatchdog(PLAY_START_TIMEOUT_MS);
      audio
        .play()
        .then(() => {
          // Barge-in / already finished / superseded: leave the graph alone.
          if (settled || signal?.aborted || araAudio !== audio) return;
          void attachTtsAnalyser(audio);
        })
        .catch(() => {
          // Consistent with onended/onerror/onAbort/onWedged: a dead element
          // must not stay pinned as the "active" one. It used to be left set
          // here, so `araAudio` kept a failed element (and its revoked blob URL)
          // alive until the next utterance's stopAllSpeech swept it.
          if (araAudio === audio) araAudio = null;
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

  // ONE VOICE — THE CALL'S (Classic's order, 2026-08-04). While the live call
  // owns her voice (bus `callLive`, raised by VoiceCallOverlay for the whole
  // open call), NO chat-side engine may make a sound — not Ara, not Piper,
  // not Web Speech. Two voices at once (her call leg + a chat TTS engine
  // reading a brain reply over it) is exactly what reached him. The brain's
  // reply still streams as TEXT into the chat column; only its sound is
  // withheld. stopAllSpeech() still runs so anything already sounding dies
  // with the claim, then the turn resolves "none" — sendMessage's reveal gate
  // releases via its "silent" path, so the text is never held back.
  if (getEngineState().callLive) {
    stopAllSpeech();
    return "none";
  }

  stopAllSpeech();
  // Claim her voice for THIS utterance. Every publish below is stamped with it,
  // so the previous turn's late `end`/`error`/`pause` cannot blank this one.
  // Bumped AFTER stopAllSpeech deliberately: that call's own `playing: false` is
  // a stop-everything and must always land.
  const generation = beginUtterance();

  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.resume();
  }

  // Ara (xAI) is the default/primary voice — HER voice, eve, the same one as
  // the live call. It runs first UNLESS the operator explicitly picked a Web
  // Speech voice or AUTO in Settings. Piper/Web Speech remain the fallback
  // below (offline / Ara unreachable).
  //
  // ONE VOICE (Classic's order, 2026-07-30): a single transient Ara failure
  // must not put a DIFFERENT woman's voice in the room — that is how "multiple
  // voices" (and her rationalizing them) reached him. So Ara gets ONE retry
  // before any fallback engine may speak; the fallbacks now cover real
  // outages, not blips.
  if (isAraSelected() && !signal?.aborted) {
    const araOk = await speakAra(text, signal, generation);
    if (araOk && !signal?.aborted) {
      return "ara";
    }
    if (!signal?.aborted) {
      const araRetryOk = await speakAra(text, signal, generation);
      if (araRetryOk && !signal?.aborted) {
        return "ara";
      }
    }
  }

  if (signal?.aborted) {
    return "none";
  }

  // When a specific Web Speech voice is chosen, honor it — skip Piper (which
  // can't render a chosen voiceURI) and go straight to Web Speech below.
  //
  // The gap once flagged here — "a failed HEAD check caches false forever, so a
  // transient miss disables Piper until reload" — IS CLOSED, upstream and not by
  // this file: piper-speak.ts:13-26 now caches only the POSITIVE result, so its
  // `if (localAvailable) return true` guard re-checks after any miss. Re-verified
  // against that source; the note is kept as a pointer, not as an open item.
  const piperAvailable = isSpecificWebSpeechVoice()
    ? false
    : await piperModelAvailable();

  if (piperAvailable) {
    const { speakPiper } = await import("@/lib/voice/piper-runtime");
    // Piper gets its own AbortController, chained off the caller's `signal`,
    // so the synthesis deadline below can cancel the LOSING synthesis instead
    // of just walking away from it. Without this, a slow Piper call that lands
    // after the deadline would still play — overlapping whatever WebSpeech
    // fallback already started (dual-voice playback).
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
    // Audio truth for the Piper path. Piper has no analyser tap (piper-runtime.ts
    // owns that element), so on this path her mouth falls back to the clip's own
    // filmed lips — correct clip, no patch.
    ttsEngine = "piper";
    let heardPiperSound = false;

    // ── BUG A, FIXED: THE DEADLINE BOUNDS SYNTHESIS, NOT THE UTTERANCE. ──────
    // It used to be `Promise.race([speakPiper(...), setTimeout(4_000)])`, and
    // speakPiper resolves on its element's `ended` (piper-runtime.ts) — so those
    // 4 seconds bounded ALL OF PLAYBACK. Every reply longer than 4s was aborted
    // mid-word and then re-spoken from the top by Web Speech, in a different
    // voice. Raising the number would only move the cliff; the window now walks
    // forward with the work instead:
    //   4s  to synthesise (the same dead air the old race allowed), then
    //   4s  to reach `playing` once the WAV is in memory, then
    //   remaining audio + 5s grace, re-armed ~4x/second from `timeupdate`,
    // so an utterance of ANY length plays to its end while a truly stalled
    // element is still caught. See withSynthesisDeadline.
    const outcome = await withSynthesisDeadline<boolean>(
      (deadline) =>
        speakPiper(text, piperAc.signal, {
          onSynthesized: () => deadline.extend(PIPER_PLAY_START_TIMEOUT_MS),
          onProgress: (remainingMs) => {
            // AUDIO TRUTH flips HERE, on the element's own `playing`/`timeupdate`
            // — not before the race as it used to, which published "speaking"
            // through local synthesis, i.e. over silence.
            if (!heardPiperSound) {
              heardPiperSound = true;
              publishTtsFor(generation, { playing: true });
            }
            deadline.extend(remainingMs + PROGRESS_GRACE_MS);
          },
        }),
      PIPER_SYNTH_TIMEOUT_MS,
      () => {
        timedOut = true;
        piperAc.abort();
      },
    );
    publishTtsFor(generation, { playing: false });

    signal?.removeEventListener("abort", forwardAbort);

    if (outcome.value === true && !signal?.aborted) {
      return "piper";
    }
    if (timedOut) {
      // Belt-and-suspenders: speakPiper's own abort listener already stops
      // playback if it had started, but make sure nothing lingers before
      // falling through to Web Speech.
      stopPiperAudio();
      // Sound DID come out before it stalled — report SUCCESS. Falling through
      // would re-speak the WHOLE reply in a second voice, which is worse than a
      // clipped tail. Same rule as the Ara watchdog above (`settle(heardSound)`).
      if (heardPiperSound && !signal?.aborted) {
        return "piper";
      }
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
    ttsEngine = "webspeech";

    let settled = false;
    let started = false;
    let watchdog = 0;

    // ONE funnel for every exit (end / error / abort / watchdog). The `settled`
    // guard is load-bearing beyond tidiness: `speechSynthesis.cancel()` makes the
    // cancelled utterance fire `error` a task LATER, by which point the next turn
    // may already have published `playing: true` — and the stale handler would
    // blank it, idling her face while she is audibly talking.
    const finish = (engine: SpeakEngine) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(watchdog);
      signal?.removeEventListener("abort", onAbort);
      publishTtsFor(generation, { playing: false });
      resolve(engine);
    };

    // ── BUG B, FIXED: WEB SPEECH NOW HAS A WATCHDOG. ─────────────────────────
    // This promise used to settle ONLY on `u.onend` / `u.onerror`. Web Speech is
    // the last reachable engine (Ara needs a key, Piper's .onnx is absent), and on
    // this macOS 12 WebKit a dropped utterance leaves those events unfired — so
    // the promise pended FOREVER, hudState pinned to "speaking"
    // (stargate-context.tsx awaits it) and the wake loop starved
    // (useVoiceLoop.ts:291). Same spirit as the Ara watchdog above.
    //
    // The window is derived from the text (webSpeechWatchdogMs — ~1.75x the real
    // duration) so it can only ever catch a wedge, never a healthy long reply.
    const arm = (ms: number) => {
      window.clearTimeout(watchdog);
      if (settled) return; // done already — never leave a timer behind
      watchdog = window.setTimeout(() => {
        // Cancel FIRST: a zombie utterance must never surface late, or speak
        // over the next turn.
        try {
          window.speechSynthesis.cancel();
        } catch {
          /* ignore — we are already on the failure path */
        }
        // If sound DID come out, this is a clipped tail, not a silent failure.
        finish(started ? "webspeech" : "none");
      }, ms);
    };

    const onAbort = () => {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
      finish("none");
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    // Web Speech gives real start/end events, so this path is true audio truth.
    // (No analyser is possible here — the synth never exposes an audio node —
    // so her mouth uses the clip's filmed lips, which is the honest fallback.)
    u.onstart = () => {
      started = true;
      publishTtsFor(generation, { playing: true });
      // Re-arm from the start of REAL speech, so the queue/voice-load delay
      // before this point doesn't eat into the utterance's own window.
      arm(webSpeechWatchdogMs(text.length, u.rate));
    };
    // Opportunistic, never depended on: where `boundary` is supported it proves
    // progress, and re-arming from the text still UNSPOKEN tightens wedge
    // detection from "the whole reply" to "the rest of it". If this engine never
    // fires it, the window armed above still bounds the utterance.
    u.onboundary = (ev: SpeechSynthesisEvent) => {
      if (settled) return;
      const left = Number.isFinite(ev.charIndex)
        ? Math.max(0, text.length - ev.charIndex)
        : text.length;
      arm(webSpeechWatchdogMs(left, u.rate));
    };
    u.onend = () => finish("webspeech");
    u.onerror = () => finish("none");
    // Armed BEFORE speak() so an utterance that never starts at all is bounded
    // too (the floor, 8s, covers the queue/voice-load delay).
    arm(webSpeechWatchdogMs(text.length, u.rate));
    window.speechSynthesis.speak(u);
  });
}
