"use client";

import { useEffect, useRef } from "react";
import {
  STARRA_CLIPS,
  SPEAKING_CLIP,
  CONTINUOUS_BODY_CLIP,
  pickBodyClip,
  type BodyMode,
  CROSSFADE_MS,
  type StarraClipKey,
} from "@/lib/voice/starra-clip-map";
import {
  BASE_LOOP_FRAMES,
  TONE_RESAMPLE_MS,
  effectiveMouthSync,
  anchorAt,
  applyToneOffsets,
  audioOutputDelayMs,
  baseBoxAt,
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
export const BODY_STUCK_TICKS = 2;

/**
 * FRAME 0 OF base_loop.mp4, as a real image.
 *
 * REAL FOOTAGE — a literal `ffmpeg -vf "select=eq(n\,0)" -frames:v 1` grab of
 * the shipped clip (552x720, matching the clip's own pixel size exactly, so it
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
 * Is this layer ACTUALLY fully opaque right now — i.e. is it the only thing the
 * viewer is seeing?
 *
 * Reads the COMPUTED value on purpose. `el.style.opacity` is the inline value,
 * which crossfadeToBack sets synchronously to the fade's TARGET, so it reads "1"
 * for the whole 320ms blend and can never detect a half-faded layer. Computed
 * style follows the running transition. getComputedStyle is guarded because it is
 * missing/throwing in enough odd embeddings that "assume opaque" (today's
 * behaviour) is the right degradation — the null-ing of frontElRef is the real
 * crossfade protection either way.
 */
/**
 * The v4 patch mask — the feather that hides the rectangle seam.
 *
 * MEASURED, not styled by eye — REDERIVED 2026-07-30 for the rebuilt uniform
 * bank (131x78 canvas, every baseBox identical at (212,242), box top BELOW the
 * measured nose baseline 238..241 by construction — scripts/
 * measure_mouth_alignment.py). Geometry solved from the measured lip union of
 * all 16 patches (canvas y 0..58, x 33..94) + the base's own lips:
 *   - centre at 50% 39.6%: cy/ry = 0.745, so alpha at the canvas TOP edge is
 *     ~0.84 — high, because the patch's upper lip starts at canvas row 0 on the
 *     widest mouths and must read; the nose is safe not because of alpha but
 *     because NO patch pixel exists above the box top (row 242 > baseline 241).
 *   - ry 53.2% (41.5px): solid (66% stop) spans canvas y 3.5..58.3, holding the
 *     deepest measured lip bottom (m10 "oo", y 58) inside full alpha; zero at
 *     y 72.4, fully faded 6px before the canvas bottom.
 *   - rx 42.7% (56px): solid spans x 28.5..102.5, holding the widest measured
 *     lip corners (33..94) with margin; zero 9.5px inside each side edge.
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

function isFullyOpaque(el: HTMLElement): boolean {
  try {
    if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
      return el.style.opacity === "1";
    }
    const raw = window.getComputedStyle(el).opacity;
    if (raw === "" || raw === undefined || raw === null) return el.style.opacity === "1";
    const v = Number(raw);
    if (!Number.isFinite(v)) return el.style.opacity === "1";
    return v >= 0.999;
  } catch {
    return el.style.opacity === "1";
  }
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
  const speakingRef = useRef(false);
  speakingRef.current = bus.speaking || analyser !== null;

  const aRef = useRef<HTMLVideoElement>(null);
  const bRef = useRef<HTMLVideoElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Which <video> layer is currently the visible one — the mouth patch reads
  // ITS currentTime to know which source frame is on screen right now.
  const frontElRef = useRef<HTMLVideoElement | null>(null);

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
    const layerLanded = (el: HTMLVideoElement): boolean =>
      el.getAttribute("src") === scheduledFile && el.readyState >= 2 && !el.error;
    const layerHealthy = (el: HTMLVideoElement): boolean => layerLanded(el) && !el.paused;

    /** The clip currently scheduled onto a layer (alive mode advances it). */
    let playingKey: StarraClipKey | null = null;

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

      // No visible layer is published to frontElRef during the blend — the
      // mouth patch hides itself rather than paint over a layer whose fade may
      // not have landed yet (see the tick's isFullyOpaque check). Publish once
      // the fade has actually landed.
      frontElRef.current = null;
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
          return;
        }
        frontElRef.current = incoming;
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
      try {
        back.currentTime = 0;
      } catch {
        /* not seekable yet — fine */
      }
      const playingEl = back; // this element will carry this clip
      const go = () => {
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
    const bodyPlaybackHealthy = () => [a, b].some(layerHealthy);

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
      const el = frontElRef.current;
      // Mid-crossfade (frontElRef null) there is no single front to measure.
      // Fall back to "is anything alive", and never accuse a blend of freezing.
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
    // — the chain's worst seam is 2.36 against the 2.025 base_loop already ships
    // and that this file calls invisible (starra-clip-map.ts, ALIVE_POOL).
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

    startContinuousBody();

    return () => {
      disposed = true;
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
      // Prime the CONTINUOUS BODY, not the legacy talking clip — the body is what
      // actually plays now, and it is the larger file, so warming it matters more.
      pre.src = STARRA_CLIPS[CONTINUOUS_BODY_CLIP].file;
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
    // Watchdog for an analyser that never sees audio: hide the patch instead of
    // stamping the bank's half-open floor frame over her real mouth.
    const stall = createStallGate();
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
    // re-measured at most every TONE_RESAMPLE_MS (her head travels 10x18px over
    // the whole 11.08s loop, so it changes slowly), each entry's raw pixels and
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
    let baseMeansAt = 0;
    let toneOff = false;

    const make2d = (
      w: number,
      h: number,
    ): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null => {
      try {
        if (typeof document === "undefined" || !(w > 0) || !(h > 0)) return null;
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const g = c.getContext("2d");
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
        if (!probe) probe = make2d(canvas.width, canvas.height);
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

        if (!patch) return; // still loading, or the load failed (stays null)

        // No audio has reached the analyser for OPENNESS_STALL_MS while she is
        // supposed to be speaking. The bank's floor frame is v00 at openness
        // 0.0814 — a slightly OPEN mouth, not a shut one — so continuing to draw
        // would stamp a frozen half-open mouth over her filmed one for the whole
        // reply. Her real footage is the better answer. On the v4 path hiding is
        // even cheaper: base_loop's own mouth is AT REST, so the patch simply
        // disappears into a closed mouth.
        if (stalled) return hide();

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
        if (!isFullyOpaque(video)) return hide();
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
        // "oo" looked like "ee". The text knows both. It cannot widen the bank
        // (still capped at half-open) — it can only pick better inside it.
        const cue = sampleArmedTextViseme(delayMs > 0 ? now - delayMs : now);
        const mouth = shapeMouth(shown, shownRound, cue);

        // ── V4: the mouth composited onto the CONTINUOUS BODY ────────────────
        if (patch.kind === "v4") {
          const b4 = patch.bank4;
          // Paint ONLY over the clip every baseBox was measured against. Painting
          // a bank onto the wrong clip is exactly the "stuck-on mouth" defect, so
          // this gate is load-bearing.
          if (video.getAttribute("src") !== STARRA_CLIPS[CONTINUOUS_BODY_CLIP].file) {
            return hide();
          }
          // The ceiling is enforced INSIDE pickVisemeFrame4: openness above the
          // bank's 0.55 clamps to the top of the real ladder instead of asking for
          // a gape that was deliberately dropped for reading as a shout.
          const pick = pickVisemeFrame4(b4, mouth.openness, mouth.roundness);
          const img = pick ? patch.images.get(pick.id) : null;
          if (!pick || !img || !img.complete || !img.naturalWidth) return hide();
          // NO RESCALING, EVER. Each PNG is already at base scale and its pixel
          // size equals its own baseBox (verified for all 10 shipped entries).
          // A mismatch means bank and images disagree, and drawing it anyway would
          // silently resample an already-resampled mouth — so skip the frame.
          if (img.naturalWidth !== pick.baseBox.w || img.naturalHeight !== pick.baseBox.h) {
            return hide();
          }
          // FIXED BOX + MEASURED DRIFT. baseBox is absolute in base_loop's own
          // 552x720 space, measured on frame 0, so no anchor track and no scaling
          // are needed. But a box fixed at frame 0 is off by up to 17px vertically
          // later in the loop (mean |dy| 6.0px; 56/266 frames >= 10px), which I
          // composited and LOOKED at — the mouth sits visibly low. baseBoxAt adds
          // the measured rigid head drift, and is the identity at frame 0.
          const box = baseBoxAt(
            pick.baseBox,
            frameIndexAt(video.currentTime, b4.fps, BASE_LOOP_FRAMES),
          );
          const place = patchPlacement(box, canvas.width, canvas.height);
          if (!place) return hide();
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
          draw2d.drawImage(src ?? img, place.drawX, place.drawY);
          canvas.style.transform =
            `translate(${rect.left + place.originX * rect.scale}px, ` +
            `${rect.top + place.originY * rect.scale}px) scale(${rect.scale})`;
          // FULLY OPAQUE, deliberately. There is no per-frame pose signal on this
          // path to ramp on: base_loop's pose is constant by construction (head
          // travel 10x18px over 11.08s, measured) and baseBoxAt already follows
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
          canvas.style.opacity = "1";
          return;
        }

        // ── LEGACY: the v2/v1 bank on talking.mp4, unchanged ─────────────────
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
        canvas.style.transform = `translate(${left}px, ${top}px) scale(${rect.scale})`;
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
          `scale(1.15)`, while her head travels 10x17px across the ENTIRE
          11.08s loop (starra-clip-map.ts, CONTINUOUS_BODY_CLIP). Motion an
          order of magnitude smaller than the blur radius, at 42% brightness,
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
          frame-0 grab at the clip's own 552x720, so it registers exactly — and
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
          // Soft-fade every show/hide (stall gate, blend gates, pose fade) —
          // an opacity POP is exactly the flicker Classic filmed.
          transition: "opacity 180ms ease",
          WebkitMaskImage: patchMask,
          maskImage: patchMask,
        }}
      />
    </div>
  );
}
