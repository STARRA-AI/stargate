"use client";

import { useEffect, useRef } from "react";
import {
  STARRA_CLIPS,
  SPEAKING_CLIP,
  CONTINUOUS_BODY_CLIP,
  SPEAKING_BODY_CLIP,
  SPEAKING_BODY_HOLD_MS,
  SPEAKING_BODY_POLL_MS,
  pickBodyClip,
  aliveShouldAdvance,
  nextQuietTicks,
  ALIVE_POOL,
  ALIVE_SPEAKING_CLIP,
  type BodyMode,
  CROSSFADE_MS,
  type StarraClipKey,
} from "@/lib/voice/starra-clip-map";
import {
  TONE_RESAMPLE_MS,
  effectiveMouthSync,
  anchorAt,
  applyToneOffsets,
  audioOutputDelayMs,
  bodyBoxAt,
  bodyFrameAt,
  bodyPatchRawConfidence,
  bodyMotionFromEnergy,
  BODY_MOTION_TAU_FAST_MS,
  BODY_MOTION_TAU_SLOW_MS,
  cellDistance,
  createReleaseGate,
  createSpeakGate,
  type BodyKind,
  channelMeans,
  containRect,
  createCrossfadeGate,
  createMouthSmoother,
  createOpennessGate,
  createOpennessRing,
  createRoundnessSmoother,
  createStallGate,
  frameIndexAt,
  loadMouthPatchAssets,
  mouthBlendMs,
  MOUTH_BLEND_MAX_MS,
  patchPlacement,
  pickVisemeFrame,
  pickVisemeFrame2,
  pickVisemeFrame4,
  poseVisibility,
  roundnessFromAudio,
  toneMatchOffsets,
  type MouthPatchAssets,
  type VisemeBaseBox,
} from "@/lib/voice/viseme-sync";
// HER MOUTH FROM THE WORDS, not only from loudness. speak.ts arms a timeline
// of shapes from the text she is about to say and starts its clock the instant
// sound comes out; this is the only consumer. When nothing is armed shapeMouth
// returns the audio values UNCHANGED, so the audio-only behaviour is still the
// floor — never a silent degrade into something else.
import { sampleArmedTextViseme, shapeMouth } from "@/lib/voice/text-visemes";
// ENGINE BUS — client-safe, secret-free. Never "@/lib/engine" (that barrel
// reaches the credential resolvers); the bus module is the client's only door.
import { useEngineBus } from "@/lib/engine/bus";
// LIVE COSMETICS — the operator's Options toggles, read at RUNTIME. Also
// client-safe and secret-free (it imports react + the bus and nothing else), and
// it returns its DEFAULTS SYNCHRONOUSLY, so nothing below ever waits on it.
import { useCosmetics } from "@/lib/engine/useCosmetics";

type Mode = "speaking" | "listening" | "idle";

// ── BUS ADOPTION: the selectors that make ONE truth drive her face ──────────
// Pure, total, exported so tests/bus-adoption-selectors.test.ts can pin them
// down (React + WebAudio wiring is not unit-testable here; these decisions are).
// EVERY ONE OF THEM IS ADDITIVE: with the bus silent (busSpeaking false,
// busAnalyser null) each returns exactly what the pre-bus expression returned.

/**
 * Which clip is on screen. The bus can only ever ADD a speaking face, never take
 * one away, so a bus that is empty, stale or broken degrades to today's inputs.
 *
 * `callState` is typed as the plain string it is compared against rather than
 * VoiceCallState, so this module does not import the call hook (it must stay
 * cheap to load and free of that graph).
 */
export function selectFaceMode(input: {
  callState: string;
  ttsPlaying: boolean;
  busSpeaking: boolean;
}): Mode {
  if (input.callState === "speaking" || input.ttsPlaying || input.busSpeaking) {
    return "speaking";
  }
  if (input.callState === "listening") return "listening";
  return "idle";
}

/**
 * Which analyser drives her mouth. THE BUS WINS WHEN IT HAS BOTH HALVES —
 * whoever published `speaking: true` published its analyser in the SAME patch, so
 * "she is speaking" and "this is the sound" cannot disagree. That disagreement is
 * the filmed bug. A bus that says speaking with NO tap (Piper, Web Speech — neither
 * exposes an audio node) must not blank the mouth's only input, so it falls
 * through to the local handles instead of returning null.
 */
export function selectFaceAnalyser(input: {
  busSpeaking: boolean;
  busAnalyser: AnalyserNode | null;
  ttsPlaying: boolean;
  ttsAnalyser: AnalyserNode | null;
  callAnalyser: AnalyserNode | null;
}): AnalyserNode | null {
  if (input.busSpeaking && input.busAnalyser) return input.busAnalyser;
  if (input.ttsPlaying && input.ttsAnalyser) return input.ttsAnalyser;
  return input.callAnalyser ?? input.ttsAnalyser;
}

/**
 * This component's own fallback: the `analyser` prop is authoritative, and the bus
 * only fills a gap — and only while the bus says sound is actually being produced.
 * Reading a bus analyser during silence would hand the mouth a tap from a finished
 * turn, which is how a frozen half-open frame gets stamped over her real mouth.
 */
export function resolveMouthAnalyser(
  prop: AnalyserNode | null | undefined,
  busSpeaking: boolean,
  busAnalyser: AnalyserNode | null,
): AnalyserNode | null {
  if (prop) return prop;
  return busSpeaking ? (busAnalyser ?? null) : null;
}

/**
 * May the mouth ENGINE run? AUDIO TRUTH ONLY — the input type has no mode field
 * on purpose (no-test-video-engine-only.test.ts pins this). The call's analyser
 * tap lives for the WHOLE call, so the engine is live in every mode; the moment
 * speech audio exists — mid-"listening", barge-in, a lagging state machine — the
 * mouth follows it. Real silence is the engine's own decision: the stall gate
 * hides the patch, showing her filmed mouth, without any clip switch.
 */
export function shouldRunMouthEngine(input: {
  mouthSyncOn: boolean;
  active: boolean;
  analyser: AnalyserNode | null;
}): boolean {
  return input.mouthSyncOn && input.active && input.analyser !== null;
}

/**
 * How long to wait before re-trying a failed base_loop.mp4 load. There is NO
 * other failure response — no talking.mp4, no idle pool (Classic's order,
 * 2026-07-30: "No test video, no fallback to idle"). 1s, 2s, 4s, then 8s forever;
 * total so a junk attempt count can never produce a NaN/0ms hot loop.
 */
export function nextBodyRetryDelay(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(8000, 1000 * 2 ** Math.min(n, 3));
}

/**
 * FLOOR on how often the retry path may actually MUTATE a layer, independent of
 * the backoff above.
 *
 * The backoff alone is not enough, and the gap is what Classic filmed as
 * "flickering worse": `bodyAttempts` was reset to 0 by every healthy check, so
 * a FLAPPING decoder (error, heal, error, heal — the shape memory pressure
 * actually produces on this machine) restarted the ladder at 1000ms every
 * single time and never climbed. Each mutation is a src drop + reload +
 * crossfade, so a flap became a visible re-blend roughly once a second,
 * forever. Two changes close it: mutations are spaced by at least this floor,
 * and a healthy check now DECAYS the attempt count by one instead of zeroing it
 * — so a burst keeps climbing the ladder and a genuinely recovered face still
 * walks back down to a fast first retry.
 */
export const MIN_BODY_RETRY_GAP_MS = 1500;

/**
 * How often the body loop's health is re-checked, and how many consecutive
 * checks a frozen `currentTime` must survive before it is treated as a real
 * freeze rather than a sampling artifact.
 *
 * THIS IS THE RECOVERY PATH FOR "everything else frozen or gone" (Classic,
 * live call 2026-07-31, with her own reply confirming "the only thing moving is
 * your lips sometimes"). That symptom is a body loop that stopped advancing
 * while the mouth canvas — which has its own rAF and is driven by AUDIO, not by
 * the video clock — kept animating on top of it.
 *
 * Before this, the readiness watchdog was a ONE-SHOT `setTimeout`: it fired
 * once 6s after the first load attempt, found the front layer healthy, took the
 * `bodyAttempts = 0` branch and was NEVER RE-ARMED. From that moment the only
 * failure detector left on the whole face was the `error` event — and a stalled
 * or suspended decoder does not fire `error`. It fires `stalled` / `waiting` /
 * `suspend`, or simply stops advancing with `paused` still false. So a freeze
 * was permanent for the rest of the call, with nothing watching.
 */
export const BODY_HEALTH_TICK_MS = 2000;
/**
 * THE GHOSTED MOUTH — how long a new mouth shape dissolves in over the previous
 * one (v4 draw), and why it is no longer one number.
 *
 * WAS `MOUTH_BLEND_MS = 80`. A dissolve between two PHOTOGRAPHS of a mouth is not
 * motion: for the middle of it there are two mouths on her face at once. At 80ms
 * that band (alpha 0.25..0.75) lasted 40ms on EVERY shape change, and ~30% of
 * speaking frames were measured inside it — the "puppet" read.
 *
 * The length now follows the JUMP, from the bank's own openness/roundness
 * coordinates: adjacent cells dissolve in MOUTH_BLEND_MIN_MS (16ms), a multi-row
 * jump in MOUTH_BLEND_MAX_MS (30ms), linear between. See `mouthBlendMs` and
 * `cellDistance` in viseme-sync.ts — both pure and unit-tested. Worst case now
 * leaves 15ms in the ghosted band instead of 40ms.
 *
 * WHAT THIS DEPENDS ON. A shorter dissolve only reads as motion if the shape
 * parameter itself moves in small steps. That driver is text-visemes.ts's
 * coarticulation walk, and UPDATED 2026-09-30 it IS in this tree: this file
 * imports `sampleArmedTextViseme`/`shapeMouth` at :63 and the mouth tick calls it
 * at :1588, while text-visemes.ts exports the reach machinery
 * (`coarticulationReach`, `admissibleShapes`, `nearestAdmissible`, COART_SHORT_MS/
 * COART_LONG_MS/COART_MIN_REACH/COART_ROUND_REACH/COART_ANTICIPATION) with
 * tests/mouth-clock-coarticulation.test.ts green over it. This comment used to say
 * the driver had "not landed yet"; that precondition is met.
 *
 * DO NOT READ THAT AS "SHE GLIDES". The bank is a 5x5 grid — five roundness
 * columns requested at 0.05/0.275/0.5/0.725/0.95 and five openness rungs, read off
 * bank.json's `coverage.cells` 2026-09-30 — so the walk cannot land between
 * columns. The honest ceiling is ONE OR TWO INTERMEDIATE FRAMES on a shape change
 * instead of a hard jump. Nobody has watched this on a live turn.
 */
export const MOUTH_BLEND_CEILING_MS = MOUTH_BLEND_MAX_MS;
/**
 * MID-CROSSFADE: how opaque the INCOMING body layer must be before the mouth
 * patch is allowed to paint on it.
 *
 * WHY IT IS NOT 0. During a body crossfade the incoming layer rises 0 -> 1 while
 * the OUTGOING layer stays pinned at opacity 1 underneath (crossfadeToBack). The
 * patch box is derived from the incoming layer's own src and currentTime, so it
 * is correct for the incoming picture and WRONG for the outgoing one: the two
 * bodies' measured drift tables differ by up to 31px vertically (SPEAK_DRIFT_Y
 * spans -31..+13px, BASE_DRIFT_Y -2..+3px). Painting from the first frame of the
 * blend therefore puts her mouth up to 31px off the face the viewer is mostly
 * looking at on a speak -> base switch.
 *
 * 0.5 = "the incoming layer is now the dominant picture". With the shipped
 * `opacity ${CROSSFADE_MS}ms ease` transition, CSS `ease` is
 * cubic-bezier(0.25, 0.1, 0.25, 1) and its output crosses 0.5 at ~29.3% of the
 * duration (solved on the curve, not eyeballed) — about 94ms of 320ms. So this
 * costs ~94ms of the window and keeps ~226ms of it synced, with the
 * misregistration case removed rather than traded.
 */
export const PATCH_FADE_MIN_OPACITY = 0.5;
/** Minimum time the speaking-body patch gate holds a state before it may switch again. */
// The speaking-body gate itself lives in viseme-sync.ts (createSpeakGate,
// GATE_OFF_DEBOUNCE_MS, GATE_CLEARLY_TURNED) so it is unit-tested on the table.
export const BODY_STUCK_TICKS = 2;

/**
 * THE ONE DIAL for how much her body answers her voice. 0 turns it off entirely
 * (byte-for-byte today's still body); 1 is the shipped amplitude — at full speech
 * energy a 0.5% scale, 2px of rise and 0.12deg of lean, all of it under the CSS
 * presence layer's own camera motion (deck.css `starra-handheld` /
 * `starra-breathe`). Raise it if Classic wants more; the shapes are in
 * `bodyMotionFromEnergy` (viseme-sync.ts) and nothing else has to change.
 */
export const BODY_MOTION_GAIN = 1;

/**
 * FRAME 0 OF base_loop.mp4, as a real image.
 *
 * REAL FOOTAGE — a literal `ffmpeg -vf "select=eq(n\,0)" -frames:v 1` grab of
 * the shipped clip (552x840 — CORRECTED 2026-09-30, `ffprobe` says 552x840 for
 * both base_loop.mp4 and this JPEG; the old text said 552x720. The CLAIM it
 * supports is unchanged and still true: it matches the clip's own pixel size
 * exactly, so it
 * registers with the live layers under the same `object-fit: contain`). Nothing
 * about it is generated; her face is never synthesized.
 *
 * WHY IT EXISTS: the hero backstop and the blurred letterbox fill used to be
 * two more <video> elements pointed at base_loop.mp4, taking the stage to FOUR
 * simultaneous decoders of the same file. Both are STATIC by design — one is
 * pinned at frame 0, the other is blurred 28px and dimmed to 42% — so neither
 * needs a decoder at all. As <img> they cannot stall, cannot error into the
 * retry path, and cannot be reclaimed by the media engine mid-call.
 */
export const BODY_HERO_STILL = "/avatar/body/base_loop_frame0.jpg";

/**
 * The v4 patch mask — the feather that hides the rectangle seam.
 *
 * MEASURED, not styled by eye. The PERCENTAGES are the mask and they rescale with
 * the canvas, so they did not change when the bank did. Every ABSOLUTE number
 * below was stated in the RETIRED bank's coordinate space and is RECOMPUTED here
 * 2026-09-30 against the shipped asset — canvas 152x102, ONE uniform baseBox at
 * (248,278), 24 entries (`jq` on public/avatar/visemes3/bank.json). The text that
 * stood here (131x78 canvas, baseBox (212,242), nose baseline 238..241, "all 16
 * patches") described the first v4 bank and nothing in it was checkable any more.
 *
 * THE LIP UNION IT HAS TO HOLD, in this canvas' own coordinates, derived from the
 * MEASURED constants at tests/anatomy-v4-bank.test.ts:510-512 (LIP_TOP_MIN 287,
 * PATCH_LIP_BOTTOM_MAX 353, PATCH_LIP_X 284..364 — all in base_loop space) minus
 * the box origin (248,278): the lips span canvas y 9..75, x 36..116.
 *   - centre at 50% 39.6%: cy = 40.4px, ry = 54.3px, so cy/ry = 0.744 and alpha at
 *     the canvas TOP edge is ~0.84 (the 0.844 stop sits at 74.5%) — high, because
 *     her upper lip is only 9 rows below the canvas top and must read. The nose is
 *     safe NOT because of alpha but because no patch pixel exists above the box top
 *     at all, and that top clears the measured nose baseline on 266/266 frames —
 *     asserted per entry at that same test file :527.
 *   - ry 53.2% (54.3px of 102): the solid 66% stop spans canvas y 4.6..76.2, which
 *     holds the deepest measured lip bottom (y 75) inside full alpha; alpha reaches
 *     zero at y 94.7, fully faded 7.3px before the canvas bottom.
 *   - rx 42.7% (64.9px of 152): solid spans x 33.2..118.8, holding the widest
 *     measured lip corners (36..116) with margin; zero 11.1px inside each side edge.
 * Those three containments were RECOMPUTED from the mask string and those test
 * constants — arithmetic, not a look. What is pinned green is the box-vs-lips
 * invariant at tests/anatomy-v4-bank.test.ts:541; the feather itself has no test.
 * Stops remain smoothstep sampled at quarter points (0.844 / 0.5 / 0.156),
 * because CSS gradients interpolate linearly and a straight ramp has a faintly
 * visible onset.
 *
 * Kept separate from `patchMask` (the legacy default in the JSX) so the fallback
 * path's appearance is untouched. Applied via setProperty with the -webkit- prefix
 * first, for the macOS 12 WKWebView.
 */
const V4_PATCH_MASK =
  "radial-gradient(ellipse 42.7% 53.2% at 50% 39.6%, rgba(0,0,0,1) 66%," +
  " rgba(0,0,0,0.844) 74.5%, rgba(0,0,0,0.5) 83%, rgba(0,0,0,0.156) 91.5%," +
  " rgba(0,0,0,0) 100%)";

/**
 * The rAF clock, or NaN where it cannot be read.
 *
 * The mouth tick is driven by requestAnimationFrame, whose timestamp is on the
 * performance.now() timeline, and the crossfade has to hand it a deadline on the
 * SAME timeline (see frontFadingUntilRef). NaN is the deliberate degradation:
 * every comparison against it is false.
 *
 * THAT DOES NOT MEAN EVERY CALLER DEGRADES THE SAME WAY, and assuming it did was
 * a real defect here. The mouth tick asks "is the fade window still open?", so
 * NaN reads CLOSED and the patch falls back to requiring a fully opaque layer —
 * exactly today's behaviour. The body heartbeat asks the opposite question ("is a
 * fade in flight, so do not judge this layer?"), where a false answer is the
 * DANGEROUS one: it would hand the heartbeat a mid-blend layer and let
 * scheduleBodyRetry drop the src of the outgoing layer still on screen. So it is
 * written `!(rafNow() >= deadline)`, which is true under NaN. Any new caller must
 * decide which of those two it is before comparing against this.
 */
function rafNow(): number {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch {
    /* fall through */
  }
  return NaN;
}

/**
 * This layer's LIVE animated opacity, or null when it cannot be read.
 *
 * Reads the COMPUTED value on purpose. `el.style.opacity` is the INLINE value,
 * which crossfadeToBack sets synchronously to the fade's TARGET, so it reads "1"
 * for the whole 320ms blend and can never tell you where in the blend you are.
 * Computed style follows the running transition.
 *
 * null is NOT 0 and NOT 1 — it means "no measurement", so each caller picks its
 * own safe degradation instead of inheriting one. getComputedStyle is
 * missing/throwing in enough odd embeddings to make that worth separating:
 * isFullyOpaque falls back to the inline value ("assume opaque" = today's
 * behaviour, and the null-ing of frontElRef is the real crossfade protection
 * either way), while the mid-fade patch gate treats null as "do not paint",
 * which is ALSO today's behaviour because today it never paints mid-fade.
 */
function computedOpacity(el: HTMLElement): number | null {
  try {
    if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
      return null;
    }
    const raw = window.getComputedStyle(el).opacity;
    if (raw === "" || raw === undefined || raw === null) return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Is this layer ACTUALLY fully opaque right now — i.e. is it the only thing the
 * viewer is seeing?
 */
function isFullyOpaque(el: HTMLElement): boolean {
  const v = computedOpacity(el);
  if (v === null) return el.style.opacity === "1";
  return v >= 0.999;
}

/**
 * StarraClipFace — her PHOTOREAL self, from her real footage.
 *
 * ONE VIDEO, ONE ENGINE (2026-07-30). The video layer plays exactly one clip —
 * CONTINUOUS_BODY_CLIP (base_loop.mp4) — looping forever through every state:
 * idle, listening, speaking. The ENGINE (the v4 viseme bank, cut from that same
 * clip) composites her mouth on a canvas above it, synced to the LIVE AUDIO via
 * the analyser, on every speech event; the stall gate hides the patch in real
 * silence. Per Classic's order there is NO test video (talking.mp4 never plays —
 * it has a measured wink and 60% closed eyes) and NO fallback to the idle pool:
 * if base_loop fails to load, it is retried on a capped backoff, nothing else.
 * Clips are SILENT — her voice is the xAI call audio; the video is just her face.
 * $0, in-deck, no GPU, no tunnel.
 *
 * The engine is strictly ADDITIVE: omit `analyser`, or let any asset / canvas /
 * pose check fail, and the untouched base clip is what renders — the patch
 * simply never appears. She never goes black, and the call never breaks.
 */
export function StarraClipFace({
  active,
  analyser: analyserProp,
}: {
  active: boolean;
  /** Kept for the overlay's CSS/status; the face itself no longer branches on it —
   *  the video layer is ONE clip and the engine runs on audio truth. */
  mode: Mode;
  analyser?: AnalyserNode | null;
}) {
  // BUS ADOPTION. The prop still wins, exactly as before; the bus only fills a
  // null prop, and only while it says sound is genuinely being produced. Cheap:
  // the bus notifies on real voice transitions (a few per turn), never per
  // animation frame.
  const bus = useEngineBus();
  const analyser = resolveMouthAnalyser(analyserProp, bus.speaking, bus.analyser);

  // LIVE COSMETICS. Defaults arrive SYNCHRONOUSLY on the first render (mouthSync
  // true), so this component's first paint and her mouth loop are byte-for-byte
  // today's behaviour; a successful read swaps the operator's real choices in
  // afterwards. A failed read changes nothing.
  const { cosmetics } = useCosmetics();
  // env kill switch AND the runtime toggle. NEXT_PUBLIC_MOUTH_SYNC=0 still wins
  // outright; cosmetics can only turn the mouth off, never force it on.
  const mouthSyncOn = effectiveMouthSync(cosmetics.mouthSync);
  // WHICH BODY. "still" is the shipped behaviour and the fallback for anything
  // unrecognised, so a bad stored value can never strand her on the new path.
  //
  // READ THROUGH A REF, never a dependency. cosmetics-live-hook.test.ts pins the
  // invariant that no cosmetics value may reach the clip effect's deps: doing so
  // tears both video layers down and rebuilds them, which is a black flash in
  // the middle of a live call. The mode is therefore LATCHED when the body
  // starts, and a change takes effect on her next call rather than instantly.
  // That is also why switching cannot produce a cross-family cut mid-sentence.
  const bodyModeRef = useRef<BodyMode>("still");
  bodyModeRef.current = cosmetics.bodyMode === "alive" ? "alive" : "still";

  // Is she producing sound right now? Kept in a REF, not a dep: the alive
  // scheduler reads it at handover time, and putting it in the effect's deps
  // would tear the video layers down and rebuild them on every voice
  // transition — a black flash on every single turn.
  //
  // AUDIO TRUTH ONLY — `bus.speaking`, never the analyser's presence. This read
  // used to be `bus.speaking || analyser !== null`, which is permanently TRUE
  // inside a live call: resolveMouthAnalyser returns `analyserProp` outright,
  // and the call's tap "lives for the WHOLE call" (see shouldRunMouthEngine
  // above), so she would have counted as speaking for the entire call and never
  // gestured once. The bus is the right source and it already covers the call —
  // useVoiceCall publishes the realtime leg through publishVoice, and
  // ttsBusPatch deliberately refuses to blank a realtime-owned bus.
  const speakingRef = useRef(false);
  speakingRef.current = bus.speaking;

  const aRef = useRef<HTMLVideoElement>(null);
  const bRef = useRef<HTMLVideoElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Which <video> layer is currently the visible one — the mouth patch reads
  // ITS currentTime to know which source frame is on screen right now.
  const frontElRef = useRef<HTMLVideoElement | null>(null);
  // WHILE A BODY CROSSFADE IS RUNNING the published front layer is deliberately
  // PARTIALLY opaque, and the mouth patch must keep painting through it (see
  // crossfadeToBack). This is the rAF-clock deadline of that window; 0 (or NaN,
  // when the clock is unreadable) means "no fade in flight", i.e. the old rule —
  // fully opaque or no patch at all.
  const frontFadingUntilRef = useRef(0);

  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    const a = aRef.current;
    const b = bRef.current;
    if (!a || !b) return;

    let front = a;
    let back = b;
    let fadeTimer = 0;
    let disposed = false;
    frontElRef.current = a;

    // Hoisted above the crossfade because settleFront needs it: the ONE
    // definition of "this element is actually showing the body clip right now".
    // `!el.paused` is deliberate — a paused layer is the freeze symptom, not a
    // healthy one — and `!el.error` catches a decoder that failed after the
    // canplay that let it in.
    // WHICH FILE COUNTS AS "landed" MOVES IN ALIVE MODE. In still mode this is
    // one file for the life of the effect, exactly as before. In alive mode the
    // scheduler advances through the pool, so health has to be judged against
    // the clip currently scheduled — pinning it to base_loop would make every
    // alive clip look like a failed load and trip the retry/watchdog path.
    // Latched ONCE for the life of this effect — see bodyModeRef above.
    const bodyMode: BodyMode = bodyModeRef.current;
    let scheduledFile = STARRA_CLIPS[
      bodyMode === "alive" ? pickBodyClip("alive", false, null, 0) : CONTINUOUS_BODY_CLIP
    ].file;
    // ...BUT THE NEWEST SCHEDULED FILE ALONE IS TOO STRICT DURING A HANDOVER.
    // `play()` advances `scheduledFile` synchronously, while the incoming clip
    // is still loading on the hidden layer. For that whole window the OUTGOING
    // layer — still visible, still playing, perfectly healthy — carries the
    // previous file and would read as "not landed", which sends the 2s
    // heartbeat straight down `scheduleBodyRetry()` and yanks the clip that is
    // loading. Alive clips run 1.2-3.1s, so handovers land at almost exactly
    // the heartbeat cadence and this would fire constantly.
    //
    // In alive mode EVERY pool member is a legitimate thing to be showing, so
    // health is judged against the family. In still mode the set is empty and
    // this is byte-for-byte the old single-file check.
    const aliveFiles = new Set<string>(
      bodyMode === "alive"
        ? [...ALIVE_POOL, ALIVE_SPEAKING_CLIP].map((k) => STARRA_CLIPS[k].file)
        : // STILL MODE HAS TWO BODIES (2026-09-22): the listening loop and the
          // speaking loop, swapped on her speech state. Either is a legitimate
          // landed layer, otherwise the crossfade rollback would undo every switch.
          [CONTINUOUS_BODY_CLIP, SPEAKING_BODY_CLIP].map((k) => STARRA_CLIPS[k].file),
    );
    const layerLanded = (el: HTMLVideoElement): boolean => {
      const src = el.getAttribute("src");
      if (src === null) return false;
      if (src !== scheduledFile && !aliveFiles.has(src)) return false;
      return el.readyState >= 2 && !el.error;
    };
    const layerHealthy = (el: HTMLVideoElement): boolean => layerLanded(el) && !el.paused;

    /** The clip currently scheduled onto a layer (alive mode advances it). */
    let playingKey: StarraClipKey | null = null;
    /**
     * What `playingKey`/`scheduledFile` were BEFORE the in-flight play(), so a
     * crossfade that rolls back can rewind them. Without this the rollback
     * leaves the scheduler believing it is showing the clip that failed to
     * land: if the talking loop stayed on screen while `playingKey` said
     * "gesture", `aliveShouldAdvance` would return false forever and the
     * looping clip fires no `ended` — a permanent stall, the exact class this
     * scheduler exists to prevent.
     */
    let prevPlayingKey: StarraClipKey | null = null;
    let prevScheduledFile: typeof scheduledFile | null = null;
    /** Consecutive body-heartbeat ticks with no audio. See aliveShouldAdvance. */
    let quietTicks = 0;

    // One crossfade may own the layers at a time. See createCrossfadeGate.
    const fades = createCrossfadeGate();
    let fadeSettle: (() => void) | null = null;
    let fadeSettleEl: HTMLVideoElement | null = null;
    const dropFadeListener = () => {
      if (fadeSettle && fadeSettleEl) {
        fadeSettleEl.removeEventListener("transitionend", fadeSettle);
      }
      fadeSettle = null;
      fadeSettleEl = null;
    };

    const crossfadeToBack = () => {
      // INCOMING FADES IN OVER OUTGOING (2026-07-31 fix — hero-frame invariant:
      // "no code path may leave both video layers at opacity<1 over the blurred
      // backdrop at once"). The OLD code faded BOTH layers at once (back 0->1
      // AND front 1->0 simultaneously), which meant that for the entire
      // CROSSFADE_MS blend BOTH layers sat below opacity 1 together — a real
      // double-exposure over the blurred backdrop, and exactly the "flickers to
      // a blurred close-up" shape of bug. Fix: stack the incoming layer ABOVE
      // the outgoing one (z-index), fade ONLY the incoming in, and leave the
      // outgoing PINNED at opacity 1 for the whole blend — it is only dropped
      // to 0 once the incoming has actually finished landing (settleFront,
      // below). The composite is fully opaque at every instant: either the
      // outgoing alone (start), or the incoming opaque on top of the still-
      // opaque outgoing (mid-blend), or the incoming alone (end).
      back.style.zIndex = "2";
      front.style.zIndex = "1";
      back.style.opacity = "1";
      const incoming = back;
      const outgoing = front;
      front = back;
      back = outgoing;

      // THE MOUTH STAYS SYNCED THROUGH THE FADE (2026-09-30).
      //
      // WHAT THIS REPLACES, and it was the most "dubbed" moment in the whole face:
      // the incoming layer was published only once the fade had LANDED, so for the
      // entire CROSSFADE_MS (320ms) at the start of every single turn frontElRef
      // was null, the patch hid itself, and her REAL speak_loop footage mouthed
      // completely different words — then the mouth visibly changed character when
      // the patch came back. 320ms is a syllable and a half.
      //
      // Both bodies are 266 frames at 24fps with identical 552x840 geometry, and
      // each has its OWN measured drift table (bodyDriftAt), so the patch can be
      // placed correctly on whichever layer is showing. The tick indexes
      // bodyFrameAt off the published element's own currentTime and picks the drift
      // table from its own src, so publishing the incoming layer early is enough.
      //
      // THE ROLLBACK PATH IS UNCHANGED. If the incoming cannot paint yet
      // (readyState < 2, or it errored), nothing is published and the behaviour is
      // byte-for-byte today's; settleFront still verifies the landing and still
      // rolls the swap back if it never happened.
      if (incoming.readyState >= 2 && !incoming.error) {
        frontElRef.current = incoming;
        frontFadingUntilRef.current = rafNow() + CROSSFADE_MS + 80;
      } else {
        frontElRef.current = null;
        frontFadingUntilRef.current = 0;
      }
      window.clearTimeout(fadeTimer);
      // STALE-LISTENER FIX: cancel the PREVIOUS crossfade completely — drop its
      // transitionend listener AND invalidate its token. Before this, a settle
      // removed only itself, so a second crossfade inside CROSSFADE_MS left the
      // first one armed; fading that element back out from 1 -> 0 fired it and
      // published a now-HIDDEN layer as the front element, which killed the mouth
      // patch for the rest of the turn (it then failed the src/opacity checks
      // every frame). Two layers, so B's `incoming` IS A's outgoing element.
      dropFadeListener();
      const myGen = fades.begin();
      const settleFront = () => {
        window.clearTimeout(fadeTimer);
        incoming.removeEventListener("transitionend", settleFront);
        if (fadeSettle === settleFront) {
          fadeSettle = null;
          fadeSettleEl = null;
        }
        // A newer crossfade (or teardown) owns the layers now — say nothing.
        if (disposed || !fades.isCurrent(myGen)) return;
        // THE HERO-FRAME INVARIANT, ENFORCED RATHER THAN ASSUMED (2026-07-31,
        // second pass). The block below hides the outgoing layer on the
        // strength of a comment that says the incoming "is already opaque on
        // top of it". Opaque in CSS is not the same as PAINTING: `go()` only
        // gates on readyState>=2 at the moment the fade STARTS, and the
        // incoming has the whole CROSSFADE_MS blend in which to error, get its
        // decoder reclaimed, or drop back to readyState 0. Hiding a healthy,
        // visible outgoing layer for an incoming one that is showing nothing
        // blanks the stage down to the backstop — which is precisely the
        // invariant this file claims to hold. So: verify the incoming actually
        // landed, and if it did not, ROLL THE SWAP BACK and keep the layer that
        // is genuinely on screen. No dimming, no gap, no churn.
        if (!layerLanded(incoming)) {
          incoming.style.opacity = "0";
          incoming.style.zIndex = "1";
          outgoing.style.opacity = "1";
          outgoing.style.zIndex = "2";
          front = outgoing;
          back = incoming;
          frontElRef.current = layerLanded(outgoing) ? outgoing : null;
          // The fade is over (rolled back): the published layer is the opaque
          // outgoing one again, so partial opacity is no longer legitimate.
          frontFadingUntilRef.current = 0;
          // ROLL THE SCHEDULER BACK TOO, not just the pixels. `play()` advanced
          // playingKey/scheduledFile synchronously; leaving them advanced after
          // a failed landing makes the scheduler believe it is showing a clip
          // that never arrived. In alive mode that is a PERMANENT stall: the
          // talking loop is still on screen with `ended` cleared (it loops), so
          // nothing fires it, while playingKey says "gesture" and
          // aliveShouldAdvance therefore never nudges it either.
          if (prevScheduledFile !== null) {
            playingKey = prevPlayingKey;
            scheduledFile = prevScheduledFile;
          }
          return;
        }
        frontElRef.current = incoming;
        // The fade has landed; the incoming layer is fully opaque from here, so
        // close the partial-opacity window and restore the strict rule.
        frontFadingUntilRef.current = 0;
        // STOP DECODING THE LAYER NOBODY CAN SEE. Two <video> elements both
        // playing h264 is double the decode cost for one visible picture.
        // Safe by construction: bodyPlaybackHealthy() only consults layers
        // passing layerShowing (opacity !== "0"), the heartbeat's paused check
        // reads only frontElRef, play() already resets back.currentTime = 0,
        // and pause() does not lower readyState, so the readyState >= 2 fast
        // path still fires on the next swap.
        try {
          outgoing.pause();
        } catch {
          /* a layer that will not pause is not worth failing the swap over */
        }
        // Only now hide the outgoing layer. It has stayed fully opaque and
        // covering nothing new (the incoming is already opaque on top of it),
        // so dropping it is invisible — state hygiene, never a visible pop —
        // and it frees `outgoing` to be reused as the next hidden back layer.
        outgoing.style.opacity = "0";
        outgoing.style.zIndex = "1";
      };
      // transitionend is the accurate signal; the timer is the fallback for the
      // case where the transition never runs (reduced motion, opacity already 1,
      // element not yet in the layout tree).
      fadeSettle = settleFront;
      fadeSettleEl = incoming;
      incoming.addEventListener("transitionend", settleFront);
      fadeTimer = window.setTimeout(settleFront, CROSSFADE_MS + 80);
    };

    // play `key` on the hidden layer, then crossfade it in (no black flash).
    const play = (key: StarraClipKey) => {
      const clip = STARRA_CLIPS[key];
      // Remember what was showing, so a rolled-back crossfade can restore the
      // scheduler's idea of reality along with the pixels.
      prevPlayingKey = playingKey;
      prevScheduledFile = scheduledFile;
      scheduledFile = clip.file;
      playingKey = key;
      back.loop = clip.loop;
      // HANDOVER. In still mode there is nothing to hand over to — one clip
      // loops forever — so `ended` stays cleared exactly as it shipped. In alive
      // mode this element IS the next clip, and clearing its `ended` here is
      // what would freeze her on the first gesture: the handler armed before the
      // first play() lives on whichever layer plays FIRST, and every subsequent
      // play() targets the other one. Arm it per play, on the element that will
      // actually carry the clip.
      back.onended =
        bodyMode === "alive" && !clip.loop
          ? () => {
              if (disposed || bodyMode !== "alive") return;
              scheduleNextAlive();
            }
          : null;
      back.oncanplay = null;
      if (back.getAttribute("src") !== clip.file) back.src = clip.file;
      // FRAME 0, DELIBERATELY — the seam-matched seek was MEASURED AND REJECTED.
      //
      // The idea was to start the incoming body on the frame that looks most like
      // the frame the outgoing body is showing, so the switch stops reading as a
      // pose cut. I built the full 266x266 matrix between base_loop.mp4 and
      // speak_loop.mp4 in the repo's own metric (full-resolution greyscale
      // mean-abs-diff 0..255, exactly scripts/qc-poselock-clip.py:62-76, which is
      // the metric the 2.025 figure in starra-clip-map.ts was quoted in).
      //
      // MEASURED 2026-09-30, 552x840, 266 frames each:
      //   base_loop's own loop seam (265 -> 0):               1.687
      //   base_loop's natural inter-frame motion:      median 0.677, MAX 2.461
      //   today's cut, base[i] -> speak[0]:      min 7.852  median  9.992
      //   BEST POSSIBLE pair, base[i] -> speak[j]: min 4.424  median  7.009
      //   BEST POSSIBLE pair, speak[j] -> base[i]: min 4.471  median  9.168
      //
      // So the best pairing in the entire matrix is still 2.62x the loop seam the
      // repo already ships as invisible and 1.80x base_loop's MAX natural motion —
      // the bar clip-compat-matrix.py:20-22 states ("a seam is invisible when it is
      // below the clip's MAX natural inter-frame motion"). It FAILS. A matched seek
      // would have cut the seam by ~30-44% and still popped, while adding a seek to
      // a non-keyframe on every body switch. So: today's behaviour is kept, and the
      // honest options for killing this pop are ONE BODY (base_loop only, the mouth
      // patch carrying all the speech, which is what shipped before 2026-09-22) or
      // a baked motion-compensated bridge clip between the two. Both are Classic's
      // call, not a code change.
      //
      // ALSO MEASURED, and it corrects the record: the "2.025" seam attributed to
      // base_loop in starra-clip-map.ts is NOT this file's seam (1.687). 2.026 is
      // SPEAK_LOOP's own loop seam. Neither reproduces the "1.64x median / 0.52x
      // max" ratio quoted there, so that figure was measured on an earlier cut of
      // the file. base_loop's current loop seam is 0.69x its own max natural motion,
      // so the shipped loop still passes the stated criterion.
      try {
        back.currentTime = 0;
      } catch {
        /* not seekable yet — fine */
      }
      const playingEl = back; // this element will carry this clip
      const go = () => {
        // ONE-SHOT. Left armed, a later canplay on this layer (a stall that
        // recovers while it loops hidden) would fade in whichever layer is
        // hidden — an unrequested body switch. Disarm before anything else.
        playingEl.oncanplay = null;
        if (disposed) return;
        void playingEl.play().catch(() => {});
        crossfadeToBack();
      };
      if (back.readyState >= 2) go();
      else back.oncanplay = go;
    };

    // ── THE CONTINUOUS BODY ──────────────────────────────────────────────────
    // Classic's complaint, verbatim: "the moving mouth is over top of the video
    // of her moving like an idiot winking and turning her head... what do you
    // call someone who your talking to who just starts twitching everywhere and
    // not making eye contact."
    //
    // Both halves of that were real and MEASURED:
    //   1. talking.mp4 — what SPEAKING_CLIP points at — has her eyes closed or
    //      downcast for ~60% of its length, 121x73px of head travel, and an
    //      actual WINK at t=1.33-1.43s (left eye shut, right open).
    //   2. The idle -> talking CROSSFADE is itself a cut. Two clips generated at
    //      different moments never resume the same pose, so blending them always
    //      shows a jump, and the eye is looking straight at her face when it lands.
    //
    // So the video layer plays ONE clip (CONTINUOUS_BODY_CLIP = base_loop.mp4),
    // looping forever — idle, listening and speaking alike — and only the
    // composited mouth changes. There is no state transition in the video layer,
    // so there is nothing to cut.
    //
    // NO OTHER CLIP EXISTS ON THIS PATH (Classic's order, 2026-07-30: "No test
    // video, no fallback to idle"). The old failure response — switch to
    // talking.mp4 / the idle pool — is GONE; a failed or stalled load RETRIES
    // base_loop itself on nextBodyRetryDelay's capped backoff, forever. The
    // watchdog re-arms on every attempt, so a load that hangs without firing
    // `error` is retried too, and an attempt that lands resets the backoff.
    // no-test-video-engine-only.test.ts pins all of this on the source.
    let bodyWatchdog = 0;
    let bodyRetryTimer = 0;
    let bodyAttempts = 0;
    let lastBodyMutateAt = 0;
    let lastFrontTime = -1;
    let stuckTicks = 0;

    // Is the body clip healthy on EITHER physical element right now? Checked
    // against the raw `a`/`b` elements, never the `front`/`back` aliases —
    // those are reassigned SYNCHRONOUSLY the instant a crossfade begins (see
    // crossfadeToBack), so asking the aliases "is the hidden one OK?" mid-blend
    // could actually be asking about the element that is currently the
    // visible, healthy front. Testing `a`/`b` directly is immune to that.
    // (`clipFile` / `layerHealthy` are hoisted to the top of this effect —
    // settleFront needs them too.)
    // A LAYER THAT HAS BEEN HIDDEN MAY NOT VOUCH FOR THE VISIBLE ONE. After a
    // completed crossfade the outgoing layer is set to opacity 0 but is never
    // PAUSED, so in alive mode it keeps playing its old pool clip invisibly for
    // the rest of that clip's duration. Since layerLanded now accepts any
    // family file, such a layer would satisfy `some(layerHealthy)` and tell the
    // retry path "the visible face is fine" while the front layer was actually
    // broken — suppressing recovery for up to ~3s, or forever if the hidden
    // layer happened to be the looping talking clip.
    //
    // Only the INLINE "0" counts as hidden — that is the exact value settleFront
    // and the rollback set. An unset opacity reads as visible, so this can only
    // ever exclude a layer deliberately put away, never a fresh one.
    const layerShowing = (el: HTMLVideoElement): boolean => el.style.opacity !== "0";
    const bodyPlaybackHealthy = () => [a, b].some((el) => layerShowing(el) && layerHealthy(el));

    const scheduleBodyRetry = () => {
      if (disposed) return;
      // SPURIOUS-ERROR GUARD (2026-07-31, Classic's field report: "flickers to
      // a blurred close-up"): a/b/back all route their `error` events here,
      // so a transient hiccup on the HIDDEN layer used to trigger a full
      // retry → re-crossfade — both layers mid-blend, patch hidden, the
      // blurred backdrop flashing through. If EITHER layer is currently
      // healthy on the body clip, the visible face is fine: DECAY the backoff
      // (never reset it — see MIN_BODY_RETRY_GAP_MS for why a reset is what
      // let a flapping decoder re-blend once a second forever) and do nothing.
      if (bodyPlaybackHealthy()) {
        bodyAttempts = Math.max(0, bodyAttempts - 1);
        return;
      }
      window.clearTimeout(bodyRetryTimer);
      bodyRetryTimer = window.setTimeout(() => {
        if (disposed) return;
        // RE-CHECK AT FIRE TIME — this is the guard EXTENDED (2026-07-31): the
        // backoff delay is up to 8s, and the world can heal inside that
        // window (a different retry landing, a stalled decoder recovering on
        // its own). Retries touch ONLY the hidden back layer, and only while
        // it is STILL actually unhealthy at the moment of mutation — never
        // blank/reload a layer that has since become the healthy, visible
        // front.
        if (bodyPlaybackHealthy()) {
          bodyAttempts = Math.max(0, bodyAttempts - 1);
          return;
        }
        lastBodyMutateAt = Date.now();
        // Re-setting the same src is a no-op, and this element just FAILED with
        // that src — drop it first so play() assigns fresh and the browser
        // actually refetches.
        back.removeAttribute("src");
        startContinuousBody();
        // CHURN FLOOR, applied to the DELAY rather than as a second timer so
        // the fire-time health re-check above stays the first thing the retry
        // path does. Whatever the backoff says, two mutations can never land
        // closer together than MIN_BODY_RETRY_GAP_MS.
      }, Math.max(
        nextBodyRetryDelay(bodyAttempts++),
        MIN_BODY_RETRY_GAP_MS - (Date.now() - lastBodyMutateAt),
      ));
    };

    /**
     * THE HEARTBEAT. A REPEATING interval, deliberately — the thing it replaced
     * was a one-shot `setTimeout` that fired once 6s after the first attempt,
     * found the face healthy, and was never re-armed, leaving the `error` event
     * as the only failure detector on the whole face for the rest of the call.
     * A frozen or media-engine-suspended decoder never fires `error`, so
     * "everything else frozen or gone" had nothing watching it. See
     * BODY_HEALTH_TICK_MS.
     *
     * Three escalating outcomes, cheapest first, and NONE of them ever pauses
     * or unmounts the loop:
     *   - advancing        -> decay the backoff, do nothing.
     *   - paused / stalled -> ask it to resume in place (`play()`); no reload,
     *                         no crossfade, nothing visible.
     *   - still stuck      -> only then hand it to the retry path.
     */
    const bodyHeartbeat = () => {
      if (disposed) return;

      // ALIVE MODE'S ONLY WAY OFF THE TALKING CLIP. `ALIVE_SPEAKING_CLIP` has
      // `loop: true`, so it fires no `ended` — and `ended` is the sole trigger
      // that advances the alive scheduler. Without this check the FIRST time she
      // speaks in alive mode she locks onto talking footage for the rest of the
      // session and plays it through every silence.
      //
      // Done on the heartbeat rather than a new timer, and rather than forcing
      // `loop = false`: the heartbeat already ticks at the cadence this needs,
      // and leaving the clip looping means no crossfade churn every 2s while
      // she is actually talking. Worst-case latency back to a gesture is one
      // tick.
      // The counter, not a single read: bus.speaking drops to false in the gap
      // between every chunk of a chunked reply, so one quiet sample is not the
      // end of her turn. nextQuietTicks owns the accumulation rule — crucially
      // it resets unless the TALKING CLIP is what is on screen, so quiet time
      // spent on gestures cannot bank up and satisfy the guard in advance.
      quietTicks = nextQuietTicks(quietTicks, bodyMode, playingKey, speakingRef.current);
      if (aliveShouldAdvance(bodyMode, playingKey, quietTicks)) {
        quietTicks = 0;
        scheduleNextAlive();
        return;
      }

      // A CROSSFADE IN FLIGHT IS STILL NOT A SINGLE FRONT TO MEASURE, and that
      // has to be said explicitly now. frontElRef carries the INCOMING layer for
      // the whole blend so the mouth patch can keep painting (see
      // crossfadeToBack) — but this heartbeat must keep exactly the behaviour it
      // had: a layer whose decoder drops mid-blend is settleFront's business (it
      // rolls the swap back), NOT the retry path's, because scheduleBodyRetry
      // drops `back`'s src and during a blend `back` is the OUTGOING layer that
      // is still on screen underneath. Dropping it there is the blank-frame class
      // of bug this file exists to prevent.
      // NEGATED ON PURPOSE — the ONE place rafNow()'s NaN changes the answer.
      // `NaN < deadline` is false, which reads as "the fade finished" and hands
      // this heartbeat the blend's incoming layer to judge: the exact opposite of
      // the byte-for-byte behaviour promised just above, and a route into
      // scheduleBodyRetry dropping the src of the OUTGOING layer still on screen.
      // `!(NaN >= deadline)` is true, so an unreadable clock means "assume a fade
      // is running" — which lands on the lenient pre-2026-09-30 path below,
      // because back then frontElRef was null for the whole blend anyway.
      const fadeInFlight =
        frontFadingUntilRef.current > 0 && !(rafNow() >= frontFadingUntilRef.current);
      const el = fadeInFlight ? null : frontElRef.current;
      // No single front (never published, or a blend is running): fall back to
      // "is anything alive", and never accuse a blend of freezing.
      if (!el) {
        if (!bodyPlaybackHealthy()) scheduleBodyRetry();
        return;
      }
      if (!layerLanded(el)) {
        stuckTicks = 0;
        scheduleBodyRetry();
        return;
      }
      if (el.paused) {
        stuckTicks = 0;
        void el.play().catch(() => scheduleBodyRetry());
        return;
      }
      // Playing, but is the clock actually moving? This is the freeze that
      // reports no error and leaves `paused` false. The loop is 11.08s and the
      // tick is 2s, so a healthy layer always advances by ~2s between samples
      // (a loop wrap changes it too); two consecutive samples inside 50ms of
      // each other is a real stall, not sampling noise.
      const t = el.currentTime;
      if (Math.abs(t - lastFrontTime) < 0.05) {
        stuckTicks += 1;
        if (stuckTicks >= BODY_STUCK_TICKS) {
          stuckTicks = 0;
          void el.play().catch(() => {});
          scheduleBodyRetry();
        }
      } else {
        stuckTicks = 0;
        bodyAttempts = Math.max(0, bodyAttempts - 1);
      }
      lastFrontTime = t;
    };

    // ── ALIVE MODE ───────────────────────────────────────────────────────────
    // She actually moves between turns. Every clip in the pool begins and ends
    // on the same anchor pose, measured, so handing over at `ended` is seamless
    // — the chain's worst seam is 2.36, which clears the stated bar because
    // base_loop's MAX natural inter-frame motion is 2.461 (re-measured 2026-09-30;
    // the "2.025" this line used to compare against is speak_loop's loop seam, not
    // base_loop's 1.687 — see starra-clip-map.ts, CONTINUOUS_BODY_CLIP). The margin
    // is 4%, not the comfortable gap the old wording implied.
    //
    // Speech is deliberately NOT interrupted: `speakingRef` is read at handover
    // time, so a clip finishes its gesture and the next choice reflects whatever
    // she is doing by then. Cutting mid-gesture to answer is the twitchy look
    // Classic objected to in the first place.
    const scheduleNextAlive = () => {
      if (disposed) return;
      const next = pickBodyClip("alive", speakingRef.current, playingKey, Math.random());
      play(next);
    };

    const startContinuousBody = () => {
      // The heartbeat is armed ONCE and runs for the life of the effect; every
      // attempt just resets the stall sampler so a fresh layer is not judged on
      // the previous one's clock.
      lastFrontTime = -1;
      stuckTicks = 0;
      if (!bodyWatchdog) bodyWatchdog = window.setInterval(bodyHeartbeat, BODY_HEALTH_TICK_MS);
      back.onerror = scheduleBodyRetry;
      a.onerror = scheduleBodyRetry;
      b.onerror = scheduleBodyRetry;
      if (bodyMode === "alive") {
        // play() arms the handover on whichever layer carries each clip.
        scheduleNextAlive();
      } else {
        play(CONTINUOUS_BODY_CLIP);
      }
    };

    // ── THE SPEAKING BODY SWITCH (still mode) ────────────────────────────────
    // Her voice starts -> crossfade to speak_loop (jaw, cheeks, brows, nods: the
    // whole face talks). Her voice stops -> hold SPEAKING_BODY_HOLD_MS so a breath
    // between sentences does not flick her back, then crossfade to base_loop.
    // Polled at SPEAKING_BODY_POLL_MS: the 2s body heartbeat is far too slow for
    // speech onset. Both switches go through the SAME play()/crossfade gate the
    // alive scheduler uses, so a failed load rolls back exactly as before.
    let speakPoll = 0;
    let quietSince = 0;
    let wantSpeak = false;
    if (bodyMode !== "alive") {
      speakPoll = window.setInterval(() => {
        if (disposed) return;
        const speaking = speakingRef.current;
        const now = Date.now();
        if (speaking) {
          quietSince = 0;
          wantSpeak = true;
          // Re-issued on EVERY speaking tick, not once per reply: a rolled-back
          // crossfade restores playingKey to the listening body, and a once-
          // only switch left her listening for the whole reply. play() advances
          // playingKey synchronously, so an in-flight switch is never doubled.
          if (playingKey !== SPEAKING_BODY_CLIP) play(SPEAKING_BODY_CLIP);
          return;
        }
        if (wantSpeak) {
          if (!quietSince) quietSince = now;
          if (now - quietSince >= SPEAKING_BODY_HOLD_MS) {
            wantSpeak = false;
            quietSince = 0;
          }
          return;
        }
        // Quiet and past the hold: the listening body, re-issued the same way.
        if (playingKey !== CONTINUOUS_BODY_CLIP) play(CONTINUOUS_BODY_CLIP);
      }, SPEAKING_BODY_POLL_MS);
    }

    startContinuousBody();

    return () => {
      disposed = true;
      window.clearInterval(speakPoll);
      window.clearTimeout(fadeTimer);
      window.clearInterval(bodyWatchdog);
      bodyWatchdog = 0;
      window.clearTimeout(bodyRetryTimer);
      fades.cancelAll();
      dropFadeListener();
      a.onended = a.oncanplay = b.onended = b.oncanplay = null;
      a.onerror = b.onerror = back.onerror = null;
      a.pause();
      b.pause();
      frontElRef.current = null;
      frontFadingUntilRef.current = 0;
    };
  }, [active]);

  // Prime her talking clip the moment the call opens, so the FIRST time she
  // speaks there is no canplay wait before the crossfade (that wait is what
  // made her first turn start on the idle clip). Warms the HTTP cache only —
  // this element is never displayed and never plays.
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    // ALSO warm the mouth bank here (2026-07-30). loadMouthPatchAssets used to
    // fire first inside the mouth-sync effect, i.e. at the FIRST ENGINE START —
    // so her first spoken words raced ~100-200ms of bank.json + 16 PNG fetch +
    // decode. It memoizes its promise (one flight per page, every failure is a
    // silent null), so invoking it early is free and the engine's own call
    // resolves instantly from the same promise.
    void loadMouthPatchAssets();
    let pre: HTMLVideoElement | null = null;
    try {
      pre = document.createElement("video");
      pre.preload = "auto";
      pre.muted = true;
      // Prime the SPEAKING body. The listening body is already loading on a
      // live layer (startContinuousBody), so warming it here bought nothing —
      // and speak_loop.mp4 (2.67MB) was fetched on demand at her FIRST WORD,
      // which is exactly the canplay wait this effect exists to remove.
      pre.src = STARRA_CLIPS[SPEAKING_BODY_CLIP].file;
      pre.load();
    } catch {
      pre = null; // preloading is a nicety; never let it break the face
    }
    return () => {
      try {
        pre?.removeAttribute("src");
        pre?.load();
      } catch {
        /* ignore */
      }
    };
  }, [active]);

  // ── MOUTH SYNC ───────────────────────────────────────────────────────────
  // Paints her mouth to match the live audio, over the untouched base clip.
  // EVERY precondition below is a silent no-op: nothing here throws into the
  // call, and when anything is unavailable she just plays the clip as before.
  useEffect(() => {
    const canvas = canvasRef.current;
    const hide = () => {
      if (canvas) canvas.style.opacity = "0";
    };
    // `mouthSyncOn` = NEXT_PUBLIC_MOUTH_SYNC (build-time kill switch) AND the
    // operator's live cosmetic. Turning the toggle OFF re-runs this effect, whose
    // cleanup already clears the canvas and hides the patch — so her real filmed
    // mouth takes over immediately and her AUDIO is untouched either way.
    //
    // NO MODE IN THIS GATE — shouldRunMouthEngine is audio truth only. The
    // engine is live for the whole call (the realtime analyser exists from
    // connect), so speech is animated the moment its sound exists, whatever the
    // state machine currently claims; in real silence the stall gate below
    // hides the patch. That is what "engine output on every speech event" means.
    // (`!analyser` repeats one of the selector's inputs purely so the compiler
    // narrows it non-null for the loop below — it cannot disagree with the gate.)
    if (!shouldRunMouthEngine({ mouthSyncOn, active, analyser }) || !analyser || !canvas) {
      hide();
      return;
    }
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      hide();
      return;
    }

    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) {
      hide();
      return; // no 2d context on this engine — behave exactly as before
    }
    const draw2d = ctx;

    let disposed = false;
    let raf = 0;
    let patch: MouthPatchAssets | null = null;
    const smoother = createMouthSmoother();
    // Hysteresis gate on the raw openness (2026-07-31): opens above
    // SILENCE_FLOOR, only closes below the lower SILENCE_RELEASE_FLOOR, so
    // level hovering right at the floor (mic noise, a fading breath) cannot
    // chatter the raw signal open/closed block to block. One instance per
    // engine run, matching every other per-run smoother/ring below.
    const opennessGate = createOpennessGate();
    // Lip ROUNDING gets its own, SLOWER smoother (see ROUNDNESS_TAU_MS): the jaw
    // can drop between two frames but lips purse over a syllable, so sharing the
    // jaw's 35ms attack would make her lip width flicker. It rests at NEUTRAL
    // 0.5, not 0, because 0 asserts "fully spread".
    const roundSmoother = createRoundnessSmoother();
    // Openness is buffered by timestamp and read back from `now - outputDelay`,
    // because an AnalyserNode taps the graph BEFORE the DAC — without this her
    // mouth LEADS the sound (barely on wired output, 150-300ms on Bluetooth).
    const ring = createOpennessRing(96);
    // Roundness needs the SAME latency compensation: on Bluetooth the 150-300ms
    // delay is comparable to its own 120ms time constant, so reading it live
    // would put her lip shape ahead of the sound even while openness was correct.
    const roundRing = createOpennessRing(96);
    // ── THE BODY ANSWERS HER VOICE (2026-09-30) ──────────────────────────────
    // Before this, the body layer reacted to exactly ONE BIT — speaking or not —
    // and between the two clip switches nothing about her moved with what she was
    // saying. This rides the SAME analyser the mouth already reads (the repo's
    // rule: never start a second one) through two one-poles, and composites the
    // result as a transform, so it costs no repaint and no decode.
    //
    // WHY THE VIDEO LAYERS AND THE CANVAS, NEVER THE HOST. deck.css animates
    // `.call-face-portrait` itself with `starra-handheld` / `starra-breathe` using
    // the INDIVIDUAL transform properties, and `.is-collapsed .call-face-portrait`
    // sets `transform: scale(2.05)` for the small-window mode. An inline transform
    // on the host would silently defeat that collapse zoom. The layers' own
    // `transform` is free, so her body moves UNDER the camera motion, which is the
    // right way round: handheld is the lens, this is the subject.
    //
    // Reduced motion and low-power both mean "hold her still" here, exactly as
    // deck.css's own guards do for the presence layer.
    // The two body layers, captured ONCE for the life of this effect. Read from
    // the refs on every frame (and worse, in the cleanup) they could point at a
    // different node than the one that was transformed —
    // react-hooks/exhaustive-deps flags exactly that. The elements are rendered
    // unconditionally by this component, so they exist by the time an effect runs.
    const motionLayers: (HTMLVideoElement | null)[] = [aRef.current, bRef.current];
    let motionOff = !(BODY_MOTION_GAIN > 0);
    try {
      if (!motionOff && typeof window.matchMedia === "function") {
        motionOff = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      }
      if (!motionOff && typeof document !== "undefined" && document.body) {
        motionOff = document.body.classList.contains("low-power");
      }
    } catch {
      motionOff = true; // an environment we cannot read gets today's still body
    }
    // Symmetric one-poles: this is an envelope follower, not a jaw, so it has no
    // fast-attack/slow-release asymmetry.
    const motionFast = createMouthSmoother(BODY_MOTION_TAU_FAST_MS, BODY_MOTION_TAU_FAST_MS);
    const motionSlow = createMouthSmoother(BODY_MOTION_TAU_SLOW_MS, BODY_MOTION_TAU_SLOW_MS);
    /** Her body motion as a transform in HOST pixels with origin 0 0. "" = none. */
    let motionCss = "";
    let motionApplied = "";
    const stepBodyMotion = (energy: number, dtMs: number): void => {
      if (motionOff) return;
      const host = hostRef.current;
      const cw = host ? host.clientWidth : 0;
      const ch = host ? host.clientHeight : 0;
      const fast = motionFast.step(energy, dtMs);
      const slow = motionSlow.step(energy, dtMs);
      if (!(cw > 0 && ch > 0)) return;
      const m = bodyMotionFromEnergy(fast, slow, BODY_MOTION_GAIN);
      const cx = cw / 2;
      const cy = ch / 2;
      // Scale and lean about the CENTRE of the stage, then translate. Written as
      // an explicit centring pair rather than `transform-origin: 50% 50%` because
      // the mouth canvas has to reuse the identical string, and it is pinned to
      // origin 0 0 (its own transform is absolute in host pixels).
      motionCss =
        `translate(${m.tx.toFixed(3)}px, ${m.ty.toFixed(3)}px) ` +
        `translate(${cx.toFixed(1)}px, ${cy.toFixed(1)}px) ` +
        `rotate(${m.rotate.toFixed(4)}deg) scale(${m.scale.toFixed(5)}) ` +
        `translate(${(-cx).toFixed(1)}px, ${(-cy).toFixed(1)}px) `;
      if (motionCss === motionApplied) return;
      motionApplied = motionCss;
      for (const el of motionLayers) {
        if (!el) continue;
        try {
          el.style.transformOrigin = "0 0";
          el.style.transform = motionCss;
        } catch {
          /* a layer that will not take a transform is not worth failing a frame */
        }
      }
    };

    // Watchdog for an analyser that never sees audio: hide the patch instead of
    // stamping the bank's half-open floor frame over her real mouth.
    const stall = createStallGate();
    // THE RELEASE AFTER EVERY TURN. The stall gate above only starts counting once
    // openness has decayed past 1e-3 (~680ms from a normal speaking level), so a
    // still photograph of a shut mouth sat on her face for ~1.4s after she stopped
    // — and the body crossfade landed in the middle of that and flickered it off
    // then on. This gate measures from the REST crossing instead and LATCHES until
    // real sound returns. See createReleaseGate for the timing derivation.
    const release = createReleaseGate();
    let last = 0;

    // AnalyserNode buffers. getFloatTimeDomainData is the clean read but is the
    // newer API; fall back to the byte call and convert when it is missing
    // (macOS 12 WKWebView — guard newer APIs, degrade silently).
    const bins = analyser.fftSize > 0 ? analyser.fftSize : 1024;
    const timeF = new Float32Array(bins);
    const timeB = new Uint8Array(bins);
    const freq = new Uint8Array(analyser.frequencyBinCount);
    const hasFloatTime = typeof analyser.getFloatTimeDomainData === "function";
    // Bin -> Hz needs the real sample rate for the F2 bands to land on the right
    // bins. Duck-typed: read it defensively and let roundnessFromAudio fall back
    // to its 48kHz assumption rather than produce NaN if it is ever missing.
    const ctxRate = (analyser.context as { sampleRate?: unknown } | null)?.sampleRate;
    const sampleRate =
      typeof ctxRate === "number" && Number.isFinite(ctxRate) && ctxRate > 0
        ? ctxRate
        : 48000;

    const readTime = (): Float32Array => {
      if (hasFloatTime) {
        analyser.getFloatTimeDomainData(timeF);
        return timeF;
      }
      analyser.getByteTimeDomainData(timeB);
      for (let i = 0; i < timeB.length; i++) timeF[i] = (timeB[i] - 128) / 128;
      return timeF;
    };

    const readFreq = (): Uint8Array | null => {
      try {
        analyser.getByteFrequencyData(freq);
        return freq;
      } catch {
        return null; // amplitude-only is a fine degradation
      }
    };

    // ── LOCAL TONE MATCH (v4 path only) ──────────────────────────────────────
    // The patches were resampled to base scale offline, and two of them ("oo":
    // m05, m07) came from a slightly different source crop. MEASURED over base
    // frames 0/66/132/199/265 (2026-07-30), the shift this needs reaches +15.5 on
    // m07's red channel and +13.4 on m05's; most entries sit inside +-7. A
    // 15-level channel offset on a mouth-sized patch reads as a different
    // exposure — a visible rectangle. So the patch's channel MEANS are slid onto
    // the base region's before it is drawn (see toneMatchOffsets).
    //
    // NOTHING HERE ALLOCATES PER FRAME in the steady state. The base tone is
    // re-measured at most every TONE_RESAMPLE_MS (the mouth anchor travels 8px in
    // x and 5px in y across all 266 frames of the shipped base_loop — BASE_DRIFT_X
    // spans 0..+8, BASE_DRIFT_Y -2..+3 — so the region under the patch changes
    // slowly. The "head travels 10x18px" figure this used to cite was measured on
    // the take base_loop.mp4 REPLACED on 2026-09-22), each entry's raw pixels and
    // mean are measured ONCE, and the corrected bitmap is rebuilt only when the
    // rounded offset actually changes. A steady frame is one drawImage.
    //
    // EVERY failure here costs the TONE MATCH ONLY. `toneOff` latches so a
    // refusing canvas is not retried 60 times a second, and the caller then draws
    // the RAW patch — which is exactly the appearance before this existed.
    const rawById = new Map<string, ImageData>();
    const meansById = new Map<string, [number, number, number]>();
    const tonedById = new Map<
      string,
      { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; data: ImageData; key: string }
    >();
    let probe: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
    let baseMeans: [number, number, number] | null = null;
    // mouth crossfade state (see the v4 draw)
    let lastPickId: string | null = null;
    let prevPickId: string | null = null;
    let lastPickBase: { x: number; y: number } | null = null;
    let prevPick: HTMLImageElement | null = null;
    // THE OUTGOING PATCH'S OWN PLACEMENT. Today every entry shares one baseBox,
    // so this is the identity and changes nothing. It exists because the moment
    // entries get per-entry boxes (re-registration measures them up to 29px
    // apart) the 80ms crossfade would otherwise draw the OUTGOING patch at the
    // INCOMING one's position, teleporting the old shape on every viseme change
    // — a new artifact created by the fix meant to remove artifacts.
    let prevPickBase: { x: number; y: number } | null = null;
    /** The bank coordinates of the pick on screen — the distance the next
     *  dissolve is scaled by (see mouthBlendMs). */
    let lastPickCell: { openness: number; roundness: number } | null = null;
    /** This dissolve's length, recomputed only when the pick actually changes. */
    let blendMs = MOUTH_BLEND_CEILING_MS;
    let pickChangedAt = 0;
    const speakGate = createSpeakGate();
    let baseMeansAt = 0;
    let lastToneKind: BodyKind | null = null;
    let toneOff = false;

    const make2d = (
      w: number,
      h: number,
      /** Set ONLY for surfaces we call getImageData on. A readback-hinted
       *  canvas is CPU-backed: right for the tone probe, which is read and
       *  never shown, and WRONG for the per-entry toned patches, which are
       *  drawImage'd onto the visible canvas every frame and would get
       *  slower on a CPU surface. */
      readback = false,
    ): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null => {
      try {
        if (typeof document === "undefined" || !(w > 0) || !(h > 0)) return null;
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const g = readback
          ? c.getContext("2d", { willReadFrequently: true })
          : c.getContext("2d");
        return g ? { canvas: c, ctx: g } : null;
      } catch {
        return null;
      }
    };

    /** Is this box wholly inside the video? A partly-outside source rect would
     *  read transparent black and drag the measured base mean toward 0. */
    const insideVideo = (box: VisemeBaseBox, v: HTMLVideoElement): boolean =>
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.w <= v.videoWidth &&
      box.y + box.h <= v.videoHeight;

    const sampleBaseMeans = (
      v: HTMLVideoElement,
      box: VisemeBaseBox,
    ): [number, number, number] | null => {
      try {
        if (!probe) probe = make2d(canvas.width, canvas.height, true);
        if (!probe) {
          toneOff = true;
          return null;
        }
        const w = Math.min(box.w, probe.canvas.width);
        const h = Math.min(box.h, probe.canvas.height);
        if (!(w > 0 && h > 0)) return null;
        probe.ctx.drawImage(v, box.x, box.y, w, h, 0, 0, w, h);
        return channelMeans(probe.ctx.getImageData(0, 0, w, h).data);
      } catch {
        toneOff = true; // tainted canvas / decoder refusal — patch stays, tone goes
        return null;
      }
    };

    /** Tone-corrected bitmap for one entry, cached. Null = draw the raw patch. */
    const tonedPatch = (
      id: string,
      img: HTMLImageElement,
      w: number,
      h: number,
    ): HTMLCanvasElement | null => {
      if (toneOff || !baseMeans) return null;
      try {
        let slot = tonedById.get(id);
        if (!slot) {
          const made = make2d(w, h);
          if (!made) {
            toneOff = true;
            return null;
          }
          // 1:1 — NEVER a rescale. The caller has already proven the image's
          // pixel size equals this box.
          made.ctx.drawImage(img, 0, 0);
          const raw = made.ctx.getImageData(0, 0, w, h);
          const means = channelMeans(raw.data);
          if (!means) return null;
          slot = {
            canvas: made.canvas,
            ctx: made.ctx,
            data: made.ctx.createImageData(w, h),
            key: "",
          };
          rawById.set(id, raw);
          meansById.set(id, means);
          tonedById.set(id, slot);
        }
        const raw = rawById.get(id);
        const means = meansById.get(id);
        if (!raw || !means) return null;
        const offs = toneMatchOffsets(means, baseMeans);
        const key = `${Math.round(offs[0])}|${Math.round(offs[1])}|${Math.round(offs[2])}`;
        if (slot.key !== key) {
          slot.data.data.set(raw.data);
          applyToneOffsets(slot.data.data, offs);
          slot.ctx.putImageData(slot.data, 0, 0);
          slot.key = key;
        }
        return slot.canvas;
      } catch {
        toneOff = true;
        return null;
      }
    };

    const tick = (now: number) => {
      if (disposed) return;
      raf = window.requestAnimationFrame(tick);

      // STALE-DT FIX: `last = now` used to sit BELOW every `return hide()`
      // guard, so a guard that fired for ~0.5s left dt at half a second. The
      // smoother clamps dt to 250ms, giving alpha = 1 - exp(-250/35) = 0.9992 —
      // an instant snap, i.e. a visible mouth POP the moment the patch came
      // back. dt must measure real elapsed frame time no matter which guard
      // fires, so it is computed FIRST and unconditionally.
      const dt = last ? now - last : 16;
      last = now;

      try {
        // Also advance the ANALYSIS unconditionally. Keeping the envelope and
        // the ring warm through a hidden stretch is what lets the patch fade
        // back in at the right openness instead of from zero.
        // Read the spectrum ONCE and feed BOTH axes from it — openness already
        // uses it for sibilance damping, and roundness is an F1/F2 proxy over the
        // same bins, so the second axis costs no extra analyser work at all.
        const spectrum = readFreq();
        const openness = smoother.step(opennessGate.step(readTime(), spectrum), dt);
        ring.push(now, openness);
        const roundness = roundSmoother.step(
          roundnessFromAudio(spectrum, sampleRate),
          dt,
        );
        roundRing.push(now, roundness);
        const stalled = stall.update(openness, dt);
        // Advanced UNCONDITIONALLY, like the stall gate and for the same reason:
        // the envelope keeps running through every hidden stretch, so the gate's
        // idea of "at rest" can never drift from the audio.
        const released = release.step(openness, dt);
        // HER BODY, before any patch guard can return: it must keep moving even
        // when the bank failed to load or the mouth is hidden. Fed the raw
        // envelope rather than the latency-compensated ring sample — at 0.5% of
        // scale a one-block lead is not perceptible, and this must not depend on
        // the patch path's state.
        stepBodyMotion(openness, dt);

        if (!patch) return; // still loading, or the load failed (stays null)

        // No audio has reached the analyser for OPENNESS_STALL_MS while she is
        // supposed to be speaking, so continuing to draw would stamp a FROZEN
        // mouth over her filmed one for the whole reply. Her real footage is the
        // better answer. On the v4 path hiding is even cheaper: base_loop's own
        // mouth is AT REST, so the patch simply disappears into a closed mouth.
        //
        // CORRECTED 2026-09-30: this said "the bank's floor frame is v00 at
        // openness 0.0814 — a slightly OPEN mouth". v00/0.0814 is the floor of the
        // 8-frame LEGACY v1 bank (public/avatar/visemes/bank.json), not of the
        // shipped one. The shipped v4 bank floors at openness 0.0 with five
        // genuinely shut entries, so here the frozen frame is a SHUT one — still
        // wrong to hold through a whole reply, which is why the gate stays.
        if (stalled) return hide();

        // THE RELEASE IS NOT APPLIED HERE — it is applied PER BODY, below, once
        // bodyKind is known. Applying it here (as the first version of this gate
        // did) hides the patch while body_speak is still on screen, and
        // body_speak's own footage is MOUTHING WORDS: that hands her a lying mouth
        // in silence, which is worse than the frozen shut-mouth photo the release
        // exists to clear. `release.step` above still runs unconditionally, so the
        // latch itself is untouched by moving the check.

        const video = frontElRef.current;
        const host = hostRef.current;
        if (!video || !host) return hide();
        // Only once the visible layer is FULLY faded in. The PRIMARY protection
        // is frontElRef being null for the whole crossfade (see crossfadeToBack)
        // — do not remove that on the strength of this line. This is a genuine
        // second belt only because it reads the COMPUTED opacity: the INLINE
        // style is set synchronously to the crossfade's TARGET, so it reads "1"
        // for the entire 320ms fade-in and could never detect a mid-blend layer.
        // Computed opacity tracks the actual animated value, so a partly-faded
        // layer is caught here even if the ref were published early.
        // FULLY OPAQUE, *OR* AN IN-FLIGHT CROSSFADE'S INCOMING LAYER.
        //
        // The strict rule stays the default: outside a fade, a partly-faded layer
        // means a stale settle published something it should not have, and the
        // patch must not paint on it. Inside a fade the incoming layer is SUPPOSED
        // to be partial (it is rising 0 -> 1 on top of a still-opaque outgoing
        // layer), and suppressing the patch there is what made every turn start
        // with 320ms of unsynced talking footage.
        //
        // THREE conditions, all needed:
        //   1. the rAF-clock window armed by crossfadeToBack has not expired;
        //   2. this layer's INLINE opacity target is "1" — i.e. it is fading IN,
        //      not out and not hidden. A hidden or fading-out layer carries the
        //      inline value "0" (settleFront and the rollback both set exactly
        //      that), so it can never satisfy this;
        //   3. its LIVE computed opacity is past PATCH_FADE_MIN_OPACITY, i.e. the
        //      incoming layer is the picture the viewer is actually seeing.
        //
        // (3) was added 2026-09-30. Without it the patch was placed from the
        // incoming layer while the outgoing layer was still fully opaque and
        // visually dominant — harmless on base -> speak (the switch this change
        // was written for) but up to 31px misregistered on speak -> base, because
        // the two bodies' drift tables differ that much. See
        // PATCH_FADE_MIN_OPACITY for the cost: ~94ms of the 320ms window.
        //
        // A computed opacity that cannot be read returns null and paints NOTHING
        // here, which falls through to the strict rule below — today's behaviour.
        const fadeOpacity =
          now < frontFadingUntilRef.current && video.style.opacity === "1"
            ? computedOpacity(video)
            : null;
        const fadingIn = fadeOpacity !== null && fadeOpacity > PATCH_FADE_MIN_OPACITY;
        if (!fadingIn && !isFullyOpaque(video)) return hide();
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return hide();

        const rect = containRect(
          video.videoWidth,
          video.videoHeight,
          host.clientWidth,
          host.clientHeight,
        );
        if (!rect) return hide();

        // Read openness as it was when the sound now leaving the speakers was
        // analysed. Both latency fields are undefined on the macOS 12 WKWebView;
        // audioOutputDelayMs returns 0 there, which is exactly today's timing.
        const delayMs = audioOutputDelayMs(analyser.context);
        const shown = delayMs > 0 ? ring.sample(now - delayMs) : openness;
        // Roundness needs the SAME compensation — see roundRing above.
        const shownRound = delayMs > 0 ? roundRing.sample(now - delayMs) : roundness;

        // SAME delay compensation for the text cue: the shape has to land on
        // the sound leaving the speakers, not on the block the analyser just
        // read. `now` here is the rAF timestamp, i.e. the same
        // performance.now() timeline beginTextVisemes() stamps.
        //
        // What this buys, and it is the whole point: the envelope alone made
        // every loud frame the same open mouth, so /m/ /b/ /p/ never shut and
        // "oo" looked like "ee". The text knows both. It cannot add an entry the
        // bank does not carry — it can only pick better inside it. (It does NOT
        // "widen a bank capped at half-open", which is what this line used to say:
        // the shipped bank's ladder reaches openness 1.0.)
        const cue = sampleArmedTextViseme(delayMs > 0 ? now - delayMs : now);
        const mouth = shapeMouth(shown, shownRound, cue);

        // ── V4: the mouth composited onto the CONTINUOUS BODY ────────────────
        if (patch.kind === "v4") {
          const b4 = patch.bank4;
          // Paint ONLY over the clip every baseBox was measured against. Painting
          // a bank onto the wrong clip is exactly the "stuck-on mouth" defect, so
          // this gate is load-bearing.
          // WHICH BODY IS SHOWING decides the drift table and the confidence gate.
          const shownSrc = video.getAttribute("src");
          const bodyKind: BodyKind | null =
            shownSrc === STARRA_CLIPS[CONTINUOUS_BODY_CLIP].file
              ? "base"
              : shownSrc === STARRA_CLIPS[SPEAKING_BODY_CLIP].file
                ? "speak"
                : null;
          if (bodyKind === null) return hide();

          // AT REST AND LATCHED — BUT ONLY ON THE LISTENING BODY.
          //
          // base_loop's own mouth is AT REST for all 266 frames, so dropping the
          // patch there hands her a genuinely closed mouth. That is the whole win,
          // and it is the case the frozen shut-mouth photo used to ruin for ~1.4s.
          // body_speak's mouth is TALKING, so dropping the patch there while she is
          // silent would show her mouthing words she is not saying — a lying mouth
          // instead of a frozen one, which is worse.
          //
          // AND THE OVERLAP IS REAL, not hypothetical: MOUTH_RELEASE_HOLD_MS
          // (500ms) plus the ~200ms the smoother takes to reach the rest band fires
          // the release ~700ms after her last sound, while the body only leaves
          // body_speak after SPEAKING_BODY_HOLD_MS (700ms) and then a CROSSFADE_MS
          // (320ms) blend. So the release lands 320-440ms BEFORE the listening body
          // is FULLY the picture. Holding the shut-mouth photo across that overlap is
          // the lesser artifact, and it is exactly what shipped before this gate.
          //
          // IN PRACTICE THAT OVERLAP IS SHORTER THAN 320-440ms, because the
          // PATCH_FADE_MIN_OPACITY guard above already hides the patch for the first
          // ~94ms of any crossfade. Traced on this source, still mode, normal ending:
          // the release latches ~700ms after her last sound; the body starts fading
          // back to base_loop at SPEAKING_BODY_HOLD_MS (700ms, polled every 120ms);
          // frontElRef then points at the INCOMING base layer, whose computed opacity
          // is under 0.5 for ~94ms, so the patch is hidden by that guard rather than
          // by this one. Net: the patch clears when the body STARTS coming back
          // (~700-820ms) instead of ~350ms after the crossfade finished (~1367ms) —
          // a ~550-670ms improvement, and the shut-mouth photo sits over body_speak
          // only for the sliver between the latch and the fade starting.
          //
          // DERIVED FROM SOURCE AND THE SHIPPED CONSTANTS — not observed on a live
          // turn. If it is ever watched and the mouth clears LATE, check whether the
          // body switch is actually firing at 700ms before touching this gate.
          //
          // STILL MONOTONIC where monotonicity was the point: once the body IS
          // base, the latch means nothing — a republished layer, a second crossfade
          // — can bring the patch back until she really makes a sound.
          if (released && bodyKind === "base") return hide();

          // The ceiling is enforced INSIDE pickVisemeFrame4: openness above the
          // bank's own declared `opennessCeiling` clamps to the top of the real
          // ladder instead of extrapolating into footage that does not exist.
          // CORRECTED 2026-09-30: this used to say 0.55, which was the FIRST v4
          // bank. The SHIPPED public/avatar/visemes3/bank.json declares
          // `opennessCeiling: 1.0` and carries entries all the way up (m21/m22 at
          // openness 1.0), so the clamp is the IDENTITY on today's bank. It stays
          // because the GUARANTEE is what matters, not the current number.
          const pick = pickVisemeFrame4(b4, mouth.openness, mouth.roundness);
          const img = pick ? patch.images.get(pick.id) : null;
          if (!pick || !img || !img.complete || !img.naturalWidth) return hide();
          // NO RESCALING, EVER. Each PNG is already at base scale and its pixel
          // size equals its own baseBox — asserted for every entry in the shipped
          // bank by tests/anatomy-v4-bank.test.ts (:81 asserts 24 frames, :571
          // asserts png size == baseBox). "10 entries" was this line's stale
          // count; the rebuilt bank has 24.
          // A mismatch means bank and images disagree, and drawing it anyway would
          // silently resample an already-resampled mouth — so skip the frame.
          if (img.naturalWidth !== pick.baseBox.w || img.naturalHeight !== pick.baseBox.h) {
            return hide();
          }
          // FIXED BOX + MEASURED DRIFT. baseBox is absolute in base_loop's own
          // 552x840 space, measured on frame 0, so no anchor track and no scaling
          // are needed. But a box fixed at frame 0 does not follow her head, and
          // the two bodies drift very differently. RE-READ off the shipped tables
          // in viseme-sync.ts 2026-09-30 (the numbers that were here — "up to 17px,
          // mean |dy| 6.0px, 56/266 >= 10px" — matched neither table):
          //   base_loop  BASE_DRIFT_Y   -2..+3px,  mean |dy| 0.95px,   0/266 >= 10px
          //   body_speak SPEAK_DRIFT_Y -31..+13px, mean |dy| 9.32px, 106/266 >= 10px
          // So the correction is nearly free on the listening body and load-bearing
          // on the speaking one — and that 31px spread is also why the patch waits
          // for the incoming layer to dominate a crossfade (PATCH_FADE_MIN_OPACITY).
          // `bodyBoxAt` adds the measured rigid drift for whichever body is showing
          // and is the identity at frame 0; `baseBoxAt` is its base-only variant.
          // The BODY's rate (24fps), never b4.fps: the bank declares its SOURCE
          // footage's 25fps, and indexing the body with it ran these tables up to
          // 11 frames ahead of the picture (see bodyFrameAt).
          const bodyFrame = bodyFrameAt(video.currentTime);
          const box = bodyBoxAt(bodyKind, pick.baseBox, bodyFrame);
          // On the speaking body a turned head (low tracker confidence) fades the
          // patch out and lets her OWN talking mouth show — real footage — instead
          // of a translated patch on a rotated face. The listening body is 1.
          // THE GATE is a pure state machine (createSpeakGate, viseme-sync.ts —
          // unit-tested on the shipped table). It reads the tracker's RAW
          // confidence: OFF only after the track has been below the floor for
          // GATE_OFF_DEBOUNCE_MS (a 2-5 frame nod is noise, not a turn) or at
          // once when she has CLEARLY turned (<= GATE_CLEARLY_TURNED); back ON
          // the moment the track is at FULL again. The old symmetric 500ms
          // dwell hid the patch on a FRONTAL face 7.3% of the time (simulated
          // over the shipped table), and its "clearly turned" escape compared
          // a value clamped to [0.93, 0.95] against 0.91 — dead code.
          // The switch is a hard target; the canvas's 50ms CSS transition is
          // the ONLY dissolve. (A per-tick JS ramp under the old 180ms CSS
          // transition was a ~176ms crossfade with ~77ms in the half-blend
          // band — the blur Classic saw.)
          const gateOn = bodyKind === "base" ? true : speakGate.step(bodyPatchRawConfidence(bodyKind, bodyFrame), now);
          const bodyAlpha = gateOn ? 1 : 0;
          if (bodyAlpha <= 0.05) return hide();
          const place = patchPlacement(box, canvas.width, canvas.height);
          if (!place) return hide();
          // A base/speak swap is the ONE moment the underlying footage tone
          // genuinely changes instantly; force a re-measure there so the slower
          // cadence below never shows a stale offset across the switch.
          if (bodyKind !== lastToneKind) {
            lastToneKind = bodyKind;
            baseMeansAt = 0;
          }
          if (!toneOff && now - baseMeansAt >= TONE_RESAMPLE_MS && insideVideo(box, video)) {
            const m = sampleBaseMeans(video, box);
            if (m) {
              baseMeans = m;
              baseMeansAt = now;
            }
          }
          const src = tonedPatch(pick.id, img, box.w, box.h);
          draw2d.clearRect(0, 0, canvas.width, canvas.height);
          // Centred in the shared canvas (see patchPlacement). The rebuilt bank's
          // boxes are uniform, so this is the identity today; it stays for any
          // future mixed-size bank.
          // A CONTINUOUS MOUTH: a new shape is blended in over the previous one
          // for `blendMs` instead of snapping, so 24 real shapes read as motion
          // rather than a slideshow. Previous at full alpha, new on top rising.
          // `blendMs` is set per CHANGE just below by
          // mouthBlendMs(cellDistance(...)), between MOUTH_BLEND_MIN_MS (16ms) and
          // MOUTH_BLEND_CEILING_MS (30ms). The fixed `MOUTH_BLEND_MS` this comment
          // used to name was DELETED in the same pass that added them — do not go
          // looking for it.
          if (pick.id !== lastPickId) {
            prevPick = lastPickId ? (patch.images.get(lastPickId) ?? null) : null;
            prevPickId = lastPickId;
            prevPickBase = lastPickBase;
            // THE DISSOLVE LENGTH FOLLOWS THE JUMP (see MOUTH_BLEND_CEILING_MS
            // and mouthBlendMs). Measured in the bank's own coordinates, once per
            // CHANGE — never per frame. The first pick has no previous cell, so
            // cellDistance returns Infinity and mouthBlendMs takes the softer
            // ceiling; nothing is drawn blended on that frame anyway (prevPick
            // is null), so it cannot show.
            blendMs = mouthBlendMs(cellDistance(lastPickCell, pick));
            lastPickId = pick.id;
            lastPickBase = { x: pick.baseBox.x, y: pick.baseBox.y };
            lastPickCell = { openness: pick.openness, roundness: pick.roundness };
            pickChangedAt = now;
          }
          const blend = blendMs > 0 ? Math.min(1, (now - pickChangedAt) / blendMs) : 1;
          if (
            prevPick && prevPickId && blend < 1 && prevPick.complete &&
            prevPick.naturalWidth === box.w && prevPick.naturalHeight === box.h
          ) {
            const prevSrc = tonedPatch(prevPickId, prevPick, box.w, box.h);
            // Offset the outgoing patch by the difference between the two
            // entries' registered boxes. Head drift is identical for both (same
            // body frame), so the baseBox delta IS the whole correction.
            const pdx = prevPickBase ? prevPickBase.x - pick.baseBox.x : 0;
            const pdy = prevPickBase ? prevPickBase.y - pick.baseBox.y : 0;
            draw2d.globalAlpha = 1;
            draw2d.drawImage(prevSrc ?? prevPick, place.drawX + pdx, place.drawY + pdy);
            draw2d.globalAlpha = blend;
            draw2d.drawImage(src ?? img, place.drawX, place.drawY);
            draw2d.globalAlpha = 1;
          } else {
            draw2d.drawImage(src ?? img, place.drawX, place.drawY);
          }
          // HER BODY'S MOTION IS PREPENDED, so the patch rides her instead of
          // sliding off her: motionCss is expressed in host pixels with origin
          // 0 0, which is exactly this canvas' own space. "" when the motion is
          // off, which leaves this line byte-for-byte what it was.
          canvas.style.transform =
            `${motionCss}translate(${rect.left + place.originX * rect.scale}px, ` +
            `${rect.top + place.originY * rect.scale}px) scale(${rect.scale})`;
          // FULLY OPAQUE, deliberately. There is no per-frame pose signal on this
          // path to ramp on: base_loop's pose is near-constant by construction (its
          // mouth anchor travels 8px in x and 5px in y over all 266 frames —
          // BASE_DRIFT_X 0..+8, BASE_DRIFT_Y -2..+3, measured on the SHIPPED file;
          // the "head travel 10x18px" this cited was the take replaced 2026-09-22)
          // and bodyBoxAt already follows
          // what little there is. `registration` is NOT used as an opacity ramp —
          // it is a STATIC per-entry template score (0.699..0.958), so ramping on
          // it would permanently dim her WIDEST mouths, which are exactly the ones
          // that must read. poseVisibility stays live on the legacy path below,
          // where anchor.json does supply a real per-frame confidence.
          //
          // PHASE 2 — THE GESTURE LAYER ATTACHES HERE. Deliberately not this
          // round, and it is not a scheduling call, it is a measurement: every
          // gesture clip's resting pose differs from base_loop by 14-29x the
          // clip's natural inter-frame motion, so whole-frame blending shows a
          // visible jump. The brow clip is additionally too extreme (forehead
          // wrinkles + wide eyes read as shock, not interest) and framed tighter
          // than the base; nod and tilt are whole-HEAD motion with no small region
          // to patch. The fix is not code — it is FOOTAGE GENERATED AS ONE
          // CONTINUOUS TAKE that already contains the gestures, so the body never
          // has to blend between two clips at all.
          canvas.style.opacity = String(bodyAlpha);
          return;
        }

        // ── LEGACY: the v2/v1 bank on talking.mp4, unchanged ─────────────────
        // THE RELEASE GATE IS DELIBERATELY NOT APPLIED ON THIS PATH, which keeps it
        // byte-for-byte what it was (the gate is new). Same reasoning as the v4
        // speaking body: this bank paints on talking.mp4, whose own mouth MOVES, so
        // releasing the patch in silence would hand her mouth back to footage
        // mouthing other words. The stall gate above still covers a dead analyser.
        // talking.mp4 also never plays (Classic's order, 2026-07-30), so this is
        // the fallback-of-a-fallback either way.
        const { bank, bank2, track, images } = patch.legacy;
        if (video.getAttribute("src") !== STARRA_CLIPS[SPEAKING_CLIP].file) return hide();

        const box = anchorAt(
          track,
          frameIndexAt(video.currentTime, track.fps, track.frames.length),
        );
        // Pose gate, a RAMP instead of a cliff (see poseVisibility). As her head
        // rotates off the pose the bank was cut from, the patch DISSOLVES toward
        // her real filmed mouth rather than being cut out mid-word — the shipped
        // anchor track has two low-confidence runs per 11.8s loop (~433ms and
        // ~1200ms) that the old binary gate turned into hard drops.
        const visibility = poseVisibility(box);
        if (!box || visibility <= 0) return hide();

        // 2-D when the bank2 assets loaded, 1-D otherwise. This is the line that
        // makes "oo" and "ah" different mouths: the 1-D scan below cannot tell
        // them apart at equal loudness, because openness is all it has.
        const pick = bank2
          ? pickVisemeFrame2(bank2, mouth.openness, mouth.roundness)
          : pickVisemeFrame(bank, mouth.openness);
        const img = pick ? images.get(pick.id) : null;
        if (!img || !img.complete || !img.naturalWidth) return hide();

        draw2d.clearRect(0, 0, canvas.width, canvas.height);
        draw2d.drawImage(img, 0, 0, canvas.width, canvas.height);

        const left = rect.left + box.x * rect.scale;
        const top = rect.top + box.y * rect.scale;
        // PHASE 2: a per-frame `rotate(${box.roll}deg)` belongs here, so a tilted
        // head stops getting an upright mouth. It needs a roll column in
        // anchor.json, which means re-running the (frozen) bank builder.
        canvas.style.transform =
          `${motionCss}translate(${left}px, ${top}px) scale(${rect.scale})`;
        canvas.style.opacity = String(visibility);
      } catch {
        hide(); // never let one bad frame bubble into the call
      }
    };

    // THE FALLBACK CHAIN lives in loadMouthPatchAssets: visemes3 (v4, on the
    // continuous body) -> the visemes2 2-D bank -> the 1-D bank -> nothing. Every
    // rung down is silent, and `null` means she just plays the clip with no patch.
    void loadMouthPatchAssets()
      .then((loaded) => {
        if (disposed || !loaded) {
          patch = null;
          hide();
          return;
        }
        if (loaded.kind === "v4") {
          // The bank must be registered to the clip we are painting over. If it
          // names some other base, refuse it rather than paste her mouth onto a
          // clip whose geometry it was never measured against.
          if (loaded.bank4.base !== STARRA_CLIPS[CONTINUOUS_BODY_CLIP].file) {
            patch = null;
            hide();
            return;
          }
          // Sized ONCE to the largest baseBox; each patch draws centred inside it,
          // so the backing store is never reallocated mid-turn.
          canvas.width = loaded.canvasW;
          canvas.height = loaded.canvasH;
          // The MEASURED feather (see V4_PATCH_MASK). -webkit- first for the
          // macOS 12 WKWebView; setProperty is used rather than a typed style
          // field so neither name has to exist on CSSStyleDeclaration.
          try {
            canvas.style.setProperty("-webkit-mask-image", V4_PATCH_MASK);
            canvas.style.setProperty("mask-image", V4_PATCH_MASK);
          } catch {
            /* the JSX default mask stays — a slightly wider feather, never a break */
          }
          patch = loaded;
          return;
        }
        // legacy: the bank must have been cut from the clip we paint over.
        if (loaded.legacy.bank.source !== STARRA_CLIPS[SPEAKING_CLIP].file) {
          patch = null;
          hide();
          return;
        }
        canvas.width = loaded.legacy.bank.width;
        canvas.height = loaded.legacy.bank.height;
        patch = loaded;
      })
      .catch(() => {
        patch = null;
        hide();
      });

    raf = window.requestAnimationFrame(tick);

    return () => {
      disposed = true;
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      patch = null;
      // Drop the tone-match scratch so a long call does not hold ~0.5MB of cached
      // ImageData per effect run.
      rawById.clear();
      meansById.clear();
      tonedById.clear();
      probe = null;
      baseMeans = null;
      try {
        draw2d.clearRect(0, 0, canvas.width, canvas.height);
      } catch {
        /* ignore */
      }
      canvas.style.opacity = "0";
      // HAND THE TRANSFORM BACK TO THE STYLESHEET. Clearing the inline
      // declaration is the exact inverse of what stepBodyMotion set. Note it does
      // NOT touch `translate` / `rotate` / `scale`: those are separate properties
      // that deck.css animates on the parent, and `transform: none` would not
      // reset them anyway (the 2026-08 landmine) — which is precisely why this
      // motion was written as `transform` and nothing else.
      for (const el of motionLayers) {
        if (!el) continue;
        try {
          el.style.transform = "";
          el.style.transformOrigin = "";
        } catch {
          /* ignore */
        }
      }
    };
    // `mouthSyncOn` joins the list so the toggle is LIVE: flipping it tears this
    // effect down (cleanup hides the patch) or brings it back. It changes at most
    // once per cosmetics read — never per frame, never per audio event.
  }, [active, analyser, mouthSyncOn]);

  const layer: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "contain",
    transition: `opacity ${CROSSFADE_MS}ms ease`,
  };

  // Feathered edges so the patch has no visible rectangle seam. Inline (with
  // the -webkit- prefix for the macOS 12 WKWebView) rather than a stylesheet
  // rule, since this component owns the element.
  const patchMask =
    "radial-gradient(ellipse 46% 46% at 50% 50%, #000 55%, transparent 100%)";

  return (
    <div className="call-face-portrait" ref={hostRef}>
      {/* blurred fill so a portrait clip has no black bars on a wide screen.
          FRAME 0 OF THE SAME CONTINUOUS BODY, as a still (see BODY_HERO_STILL)
          — it used to be a fourth <video> decoding base_loop.mp4 alongside the
          hero backstop and both live layers.

          A STILL IS VISUALLY IDENTICAL HERE, and that is measured, not assumed:
          deck.css renders this element at `blur(28px) brightness(0.42)` and
          `scale(1.15)`, while the shipped base_loop's whole-clip motion is small —
          its mouth anchor travels 8px in x and 5px in y over all 266 frames
          (BASE_DRIFT_X 0..+8, BASE_DRIFT_Y -2..+3), and its MAX inter-frame
          difference is 2.461 on a 0..255 greyscale scale (re-measured 2026-09-30;
          the "head travels 10x17px" this cited was the take replaced 2026-09-22).
          Motion an order of magnitude smaller than the blur radius, at 42% brightness,
          behind an opaque sharp copy of the same face, is not visible — and a
          decorative letterbox fill is never worth a decoder on a dual-core
          machine that is simultaneously running the call, the mic worklet and
          the mouth canvas. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="call-face-backdrop"
        src={BODY_HERO_STILL}
        alt=""
        aria-hidden
      />
      {/* HERO-FRAME BACKSTOP (2026-07-31). The blurred backdrop above is
          `object-fit: cover` + `object-position: center 22%` + `scale(1.15)` +
          `blur(28px)` — i.e. a blurred CLOSE-UP. It is the very next thing
          under the two live layers, so ANY instant where neither live layer
          paints (this component's first mount, before `a` even has a `src`;
          the retry path's `back.removeAttribute("src")`; an incoming clip at
          readyState<2) puts that blurred close-up on screen as her face.
          That is the flash Classic filmed.

          This is a sharp, static, unfiltered frame of the SAME clip the live
          layers play, pinned between them: it can only ever be revealed by
          such a gap, and when it is, she reads as a still photo instead of a
          smear. `.call-face-hero-still` is z-index 0 — the same level as the
          backdrop — and wins by tree order (it comes second), which is why it
          MUST stay immediately after the backdrop element.

          It must be inside THIS component, not the stage: `.call-face-portrait`
          is a stacking context, so a backstop rendered as its sibling would be
          painted under the inner backdrop and never seen.

          IT IS AN <img>, NOT A PAUSED <video> (2026-07-31, second pass). The
          first version of this backstop was `<video autoPlay muted>` paused at
          frame 0 in onLoadedData, because no prerendered frame of base_loop.mp4
          existed in /public. One now does — BODY_HERO_STILL, a literal ffmpeg
          frame-0 grab at the clip's own 552x840, so it registers exactly — and
          that removes the worst element on the stage: a full-bleed, PAUSED,
          background-less video sitting at z-index 0 under everything. A paused
          video element is exactly what a media engine reclaims first under
          memory pressure, and a reclaimed compositing layer with no decoded
          frame and no background is a blank rectangle the full size of her
          face. An <img> cannot be reclaimed, cannot stall, cannot error into
          the retry path, and holds no decoder. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="call-face-hero-still"
        src={BODY_HERO_STILL}
        alt=""
        aria-hidden
      />
      <video ref={aRef} style={{ ...layer, opacity: 1, zIndex: 1 }} muted playsInline aria-label="STARRA" />
      <video ref={bRef} style={{ ...layer, opacity: 0, zIndex: 1 }} muted playsInline aria-hidden />
      {/* her mouth, re-timed to her live voice — see the MOUTH SYNC effect */}
      <canvas
        ref={canvasRef}
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          zIndex: 3,
          opacity: 0,
          pointerEvents: "none",
          transformOrigin: "0 0",
          // The ONE dissolve for every show/hide, including the speaking-body
          // gate: 50ms — an edit, not a blur. It was 180ms ease, which sat under
          // a per-tick JS ramp and stretched every gate switch to ~176ms with
          // ~77ms in the half-blend band.
          transition: "opacity 50ms linear",
          WebkitMaskImage: patchMask,
          maskImage: patchMask,
        }}
      />
    </div>
  );
}
