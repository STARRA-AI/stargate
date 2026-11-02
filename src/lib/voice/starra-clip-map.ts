/**
 * STARRA clip trigger database — which photoreal clip (from the STARRA ANGLES set)
 * fires on WHAT conversation state. This is the source of truth the clip-face reads;
 * edit here to retune her behavior.
 *
 * The design: when she SPEAKS she plays a talking clip (her mouth moving = photoreal
 * "lip-sync" by playback). When she LISTENS / idles / first appears, she runs the IDLE
 * POOL — her real idle clips played back-to-back, crossfaded and shuffled so it reads as
 * one continuous, natural person, never a hard-cut loop. All clips are real 768×1168
 * (idle) / 832×1248 (talking) H.264 video of her, in /public/avatar/clips/.
 */

export interface StarraClip {
  file: string;
  durationMs: number;
  /** loop forever (talking) vs play once then hand off (idle-pool members). */
  loop: boolean;
}

export const STARRA_CLIPS = {
  // THE CONTINUOUS BODY (2026-07-30). One clip, looping forever, idle AND
  // speaking. See CONTINUOUS_BODY_CLIP below for why this replaces the
  // idle-pool/talking SWITCH rather than joining it.
  // MEASURED on the shipped file: 552x840, 24fps, 266 frames, 11.083333s, no
  // audio stream (`ffprobe` 2026-09-30). 266/24*1000 = 11083ms.
  // CORRECTED 2026-09-30: this line read 552x720 from 2026-07-30 until today.
  // `ffprobe -show_entries stream=width,height` on public/avatar/body/base_loop.mp4
  // returns 552x840 — the SAME geometry as speak_loop.mp4, which is what lets one
  // mouth bank composite onto either body. No code computed from the number, so
  // this was a lie in the record rather than a bug in the math; grepped, and the
  // only other 552x720 claims were viseme-sync.ts's baseBox comments and
  // StarraClipFace's hero-still note, corrected in the same pass.
  body_base: { file: "/avatar/body/base_loop.mp4", durationMs: 11083, loop: true },
  // THE SPEAKING BODY (2026-09-22). Cut from an InfiniteTalk render of her
  // actually talking — jaw, cheeks, brows, nods — 552x840 @24fps, 266 frames,
  // the same geometry as body_base so the mouth bank composites onto either.
  // StarraClipFace crossfades to it while she speaks and back when she stops.
  body_speak: { file: "/avatar/body/speak_loop.mp4", durationMs: 11083, loop: true },
  // Speaking: her talking clip loops while she produces audio (mouth moving).
  talking: { file: "/avatar/clips/talking.mp4", durationMs: 11800, loop: true },
  // Idle POOL members — each plays once, then the face crossfades to the next.
  // CLEAN CUTS (2026-07-29) — these are the pool. Cut from her own footage with
  // ffmpeg (-crf 16, no regeneration, originals untouched); each verified to have
  // ZERO corrupted frames and no closure over ~500ms. See IDLE_POOL below.
  idle_a1: { file: "/avatar/clips/idle_a1.mp4", durationMs: 4708, loop: false },
  idle_a2: { file: "/avatar/clips/idle_a2.mp4", durationMs: 2833, loop: false },
  idle_c1: { file: "/avatar/clips/idle_c1.mp4", durationMs: 3375, loop: false },
  // FULL ORIGINALS — kept for reference/re-cutting. NOT pool members: each has a
  // measured disqualifying defect (see IDLE_POOL). Do not add these back whole.
  idle_a: { file: "/avatar/clips/idle_a.mp4", durationMs: 10042, loop: false },
  idle_b: { file: "/avatar/clips/idle_b.mp4", durationMs: 10042, loop: false },
  idle_c: { file: "/avatar/clips/idle_c.mp4", durationMs: 15042, loop: false },

  // ── THE ANCHOR FAMILY (832x1248) ────────────────────────────────────────────
  // Eleven clips that were generated together from the same anchor pose, sitting
  // unused in public/avatar/clips/ with zero references anywhere in src/. See
  // ALIVE_POOL below for the measurement that brought them back.
  // Durations are frames/fps measured with ffprobe 2026-08-22.
  a_idle: { file: "/avatar/clips/idle.mp4", durationMs: 3120, loop: false },
  a_nod: { file: "/avatar/clips/nod.mp4", durationMs: 1233, loop: false },
  a_laugh: { file: "/avatar/clips/laugh.mp4", durationMs: 1767, loop: false },
  a_eyebrow: { file: "/avatar/clips/eyebrow.mp4", durationMs: 1433, loop: false },
  a_gaze_left: { file: "/avatar/clips/gaze_left.mp4", durationMs: 1600, loop: false },
  a_gaze_right: { file: "/avatar/clips/gaze_right.mp4", durationMs: 1600, loop: false },
  a_gaze_up: { file: "/avatar/clips/gaze_up.mp4", durationMs: 1567, loop: false },
  a_tilt_left: { file: "/avatar/clips/tilt_left.mp4", durationMs: 1600, loop: false },
  a_tilt_right: { file: "/avatar/clips/tilt_right.mp4", durationMs: 1600, loop: false },
  a_talking_loop: { file: "/avatar/clips/talking_loop.mp4", durationMs: 2033, loop: true },
} as const;

export type StarraClipKey = keyof typeof STARRA_CLIPS;

/**
 * The IDLE POOL — her idle clips, cycled while she LISTENS / idles / first appears.
 * The clip-face plays one, then crossfades into the next (shuffled, no immediate
 * repeat) so she looks like a continuous, living person instead of a looping GIF.
 *
 * MEASURED 2026-07-29 (frame-by-frame, two independent decoders; head tracked by
 * NCC nose template, gaze by center-surround iris filter, lid closure by NCC
 * against verified open/closed references). Every FULL clip has a disqualifying
 * defect, so the pool is now CLEAN CUTS of her own footage:
 *
 *   idle_a — zero corruption, best eye contact (gaze max 2.2°), BUT one 1708ms
 *            eyes-shut beat at 2.875-4.583s. Classic spotted this himself; a first
 *            pass wrongly dismissed it as a fixed-crop artifact. It is real.
 *   idle_b — BENCHED, do not revert. Fails four ways: largest head motion (59px
 *            max, 50px ROLL — the sway note only measured horizontal and missed
 *            that its dominant motion is vertical+roll), 20% of gaze >10° off
 *            camera, ~4.8s of shut/downcast eyes, and CORRUPTED frames 221-240
 *            (9.208s → end, never recovers). Only ~1.9s of it is usable.
 *   idle_c — stillest head (1.01% mean displacement) but CORRUPTED frames 291-318
 *            (12.125-13.250s): a 1.1s rainbow/datamosh burst baked into the
 *            PIXELS, not a decode artifact — `ffmpeg -f null` reports clean
 *            because the bitstream is valid. Also two long closures and zero
 *            natural blinks in 15s.
 *
 * NO WINK exists in any clip (max true L/R lid asymmetry 0.23 vs the ~0.75 a real
 * wink produces). What read as "winking" is idle_b's head-roll + asymmetric
 * squint-smile with off-camera gaze.
 *
 * The cuts below keep only frames with eyes open, gaze on lens, still head, and no
 * corruption. Originals are untouched on disk for re-cutting.
 */
export const IDLE_POOL = ["idle_a1", "idle_c1", "idle_a2"] as const;

/**
 * NOTHING PLAYS THIS POOL ANY MORE — verified 2026-09-30, and it is the reason a
 * request to "extend IDLE_POOL with the unused gaze/tilt/nod/eyebrow footage" was
 * NOT actioned here.
 *
 * `grep -rn "IDLE_POOL\|pickIdle\|resolveIdlePool" src` returns, outside this
 * file: `src/app/api/engine/_shared.ts` (the cosmetics WIRE SCHEMA only) and one
 * comment in `src/lib/engine/useCosmetics.ts`. StarraClipFace imports neither
 * IDLE_POOL nor pickIdle nor resolveIdlePool — the video layer has played
 * CONTINUOUS_BODY_CLIP / SPEAKING_BODY_CLIP since 2026-07-30 (still mode) and
 * ALIVE_POOL in alive mode. Adding clips here would therefore change NOTHING a
 * viewer can see.
 *
 * AND THE FOOTAGE IS ALREADY POOLED WHERE THE FACE CAN REACH IT: gaze_left,
 * gaze_right, gaze_up, tilt_left, tilt_right, nod and eyebrow are all in
 * ALIVE_POOL below (plus laugh and idle). Mixing their 30fps into a pool is
 * already safe, and that is verified rather than assumed: the only frame-indexed
 * math on a body clip is `bodyFrameAt` inside the v4 patch draw, and that draw
 * returns early unless the layer's src is base_loop or speak_loop
 * (StarraClipFace, `if (bodyKind === null) return hide()`), so a 30fps pool clip
 * suppresses the patch instead of being indexed at 24. MEASURED with ffprobe
 * 2026-09-30: nod, eyebrow, the three gaze clips, both tilt clips, laugh and
 * talking_loop are all 832x1248 @30fps,
 * clips/idle.mp4 is 832x1248 @25fps, and idle_a1/a2/c1 are 768x1168 @24fps.
 *
 * The pool is kept as-is because the engine API still validates against it and a
 * blank or frozen face is strictly worse than a clip nobody plays.
 */

/** RETIRED FROM PLAYBACK (2026-07-30, Classic's order: "No test video"). The
 *  face NEVER plays this clip any more — not even when base_loop.mp4 fails
 *  (that now retries; see StarraClipFace + no-test-video-engine-only.test.ts).
 *  The export stays because the legacy v2 viseme bank names it as its source
 *  and anatomy-v4-bank.test.ts pins the legacy exports. */
export const SPEAKING_CLIP: StarraClipKey = "talking";

/**
 * THE CONTINUOUS BODY — the clip her face plays, and NEVER SWITCHES AWAY FROM.
 *
 * THE ARCHITECTURAL POINT. Everything above (SPEAKING_CLIP + the IDLE_POOL) is a
 * clip SWITCH: she plays idle clips, then crossfades to the talking clip the
 * moment she speaks. That crossfade IS the cut the eye reads. No amount of
 * blending removes it, because two clips filmed at different moments never
 * resume the same pose — and the eye is looking straight at her face when it
 * happens.
 *
 * So: this one clip loops forever, whether she is idle, listening or talking.
 * Only the COMPOSITED MOUTH changes (see viseme-sync.ts, the v4 bank). There is
 * no state transition in the video layer at all, so there is nothing to cut.
 *
 * WHAT MAKES THAT SAFE — RE-MEASURED 2026-09-30 ON THE SHIPPED FILE, because the
 * numbers that stood here did not describe it.
 *
 * THE ROT, named so it is not re-introduced: this block read "measured
 * (2026-07-30) ... cut from a QC'd take: head travel 10x17px ... seam
 * mean-abs-diff 2.025 = 1.64x the clip's MEDIAN inter-frame motion but only 0.52x
 * its MAXIMUM". public/avatar/body/base_loop.mp4 was REPLACED on 2026-09-22 05:55
 * (file mtime) by an InfiniteTalk render of her LISTENING — blinks, breath, real
 * head motion, deliberately NOT "at rest" (scripts/cut-idle-base.py:7-12 says so
 * in as many words). So that whole block described a file that is no longer here.
 * The 552x720 -> 552x840 correction made earlier in this file was the same event
 * seen from one angle only: the cause was a REPLACED FILE, not a typo, which is
 * why every neighbouring measurement went stale with it.
 *
 * MEASURED 2026-09-30, in the repo's OWN metric so the numbers stay comparable —
 * scripts/qc-poselock-clip.py:62-87, i.e. `format=gray` then blend=difference +
 * signalstats YAVG, full-range greyscale 0..255. (Getting the scale right matters:
 * the same measurement WITHOUT `format=gray` reads ~14% low across the board,
 * because limited-range luma is 16-235 rather than 0-255. That is 255/219 = 1.164,
 * and it is how two honest measurements of one file disagree.)
 *
 *   base_loop.mp4 (ffprobe: 552x840, 24fps, 266 frames)
 *     - inter-frame motion over its 265 transitions: median 0.677, MAX 2.461
 *     - loop seam (frame 265 -> frame 0): 1.687 = 2.49x the median, 0.69x the MAX
 *
 * SO THE CONCLUSION SURVIVES AND THE NUMBERS DID NOT: the seam is still below the
 * clip's own MAX natural inter-frame motion, which is the stated bar
 * (scripts/clip-compat-matrix.py:20-22) and the property that makes it invisible.
 * What changed is the headroom — 0.69x of max, not 0.52x.
 *
 * WHERE "2.025" ACTUALLY COMES FROM, as far as measurement can say: speak_loop's
 * OWN loop seam is 2.026 (measured the same way), which is almost certainly the
 * collision. But the RATIOS quoted with it reproduce on NEITHER shipped body —
 * they imply a median of 1.235 and a max of 3.896, against base_loop's 0.677/2.461
 * and speak_loop's 2.455/6.471. So the triple is best read as belonging to the
 * RETIRED 552x720 cut, with the 2.025/2.026 near-match a coincidence. Stated as a
 * bounded conclusion on purpose: the retired file is gone, so it cannot be closed.
 *
 * NOT re-measured, so do not treat either as current: "head travel 10x17px" /
 * "10x18px" (both figures appear in this repo, and both describe the RETIRED
 * take — the shipped render blinks and breathes by design), and the "no zoom,
 * eyes open throughout, 0 corrupt frames" QC. Measuring head travel needs a
 * landmark tracker, which was not run here.
 *
 * WHAT IT COSTS. Her mouth carries NO speech on this clip, so the composited
 * patch is not decoration — it is the ONLY thing that makes her look like she is
 * talking. If THIS CLIP fails to load, StarraClipFace retries it on a capped
 * backoff — never a switch to another clip (Classic's order, 2026-07-30).
 *
 * THE "AT REST" PROPERTY IS LOAD-BEARING AND IS NOT RE-MEASURED HERE. The
 * "aperture 4-14px, 0 frames above 2x median" figure that stood in this sentence
 * was measured on the RETIRED take (see above), so it is removed rather than
 * restated. It matters because StarraClipFace drops the patch entirely once the
 * release gate latches AND base_loop is the layer on screen — that only hands her
 * a genuinely closed mouth if this footage's own mouth is shut. Qualitatively it
 * is, by construction: the shipped file is an InfiniteTalk render of her
 * LISTENING. Measuring it properly needs a lip metric, and this repo's alignment
 * tool's lip detector is known to lie on this footage, so no number is asserted.
 * If her mouth ever reads as open at the END of a turn in still mode, THIS is the
 * assumption to re-measure first.
 */
export const CONTINUOUS_BODY_CLIP: StarraClipKey = "body_base";
/** The body shown while she speaks (still mode). Same size, fps and length as body_base. */
export const SPEAKING_BODY_CLIP: StarraClipKey = "body_speak";
/** How long she keeps the speaking body after her voice stops, so a breath between
 *  sentences does not flick her back to listening. */
export const SPEAKING_BODY_HOLD_MS = 700;
/** How often the speech state is polled for the body switch (the 2s heartbeat is too slow). */
export const SPEAKING_BODY_POLL_MS = 120;

/**
 * THE ALIVE POOL — she actually moves.
 *
 * WHAT WAS WRONG, and it was a measurement error, not a footage problem.
 * StarraClipFace.tsx:1029-1038 benched every gesture clip because each one's
 * resting pose differs from `base_loop` by 14-29x its own natural motion. That
 * measurement is correct and the conclusion drawn from it was wrong: it compared
 * the clips against BASE_LOOP, which is a different generation at a different
 * resolution (552x840 against their 832x1248 — the exact size of his ANGLE
 * stills). Of course they did not match. Nobody compared them to EACH OTHER.
 *
 * MEASURED 2026-08-22 (scripts/clip-compat-matrix.py, full-resolution
 * verification with ffmpeg blend=difference + signalstats):
 *
 *   - all 55 first-frame pairs in the family are within the bar: these clips
 *     share one anchor pose;
 *   - all 110 A-last -> B-first transitions pass;
 *   - measured end to end over a real 11-clip chain, every seam lands at
 *     1.65-2.36.
 *
 * THE COMPARISON THAT FOLLOWED THAT LAST LINE WAS RESTATED 2026-09-30, because it
 * was anchored to a dead number. It read "i.e. 0.81x-1.17x the 2.025 seam
 * base_loop ALREADY SHIPS" — 2.025 is not base_loop's seam (see CONTINUOUS_BODY_CLIP
 * above; the shipped file's seam is 1.687 and 2.026 is speak_loop's). Against the
 * re-measured base_loop the honest ratio is 0.98x-1.40x its 1.687 seam, not
 * 0.81x-1.17x — so the alive chain's WORST seam is about 40% larger than the one
 * base_loop ships, where the old line implied it was comfortably inside it.
 *
 * IT STILL CLEARS THE STATED BAR, which is what the claim rests on: the bar is
 * "below the clip's MAX natural inter-frame motion" (scripts/clip-compat-matrix.py:20-22),
 * and base_loop's max is 2.461 — above the chain's worst 2.36. So these clips
 * remain interchangeable by construction and the switch abandoned as "the cut the
 * eye reads" is still not a cut inside this family. The margin is thinner than
 * previously written: 2.36 against 2.461 is 4% of headroom, not a comfortable gap.
 *
 * UNVERIFIED HERE: the 1.65-2.36 chain figures are the 2026-08-22 measurement,
 * carried forward. They were taken before base_loop was replaced, but they are
 * measurements of the ALIVE family against ITSELF, which that swap does not touch.
 * They were not re-run in this pass.
 *
 * WHY IT IS A SEPARATE MODE AND NOT A REPLACEMENT. base_loop and this family
 * CANNOT cut into one another — measured at ~26, and scripts/match-families.py
 * shows a crop + colour-grade solve does not close it (residual 25.1), so it is
 * a genuine generation difference, not framing. Picking one means giving up the
 * other, and that is Classic's call, not mine:
 *
 *   still (default, unchanged)  base_loop forever + the composited viseme mouth,
 *                               so speech is really SYNCED to her words.
 *   alive                       this family: she nods, tilts, glances, laughs and
 *                               raises an eyebrow, at 832x1248 instead of 552x840
 *                               — but speech runs on her real talking footage,
 *                               which moves photorealistically WITHOUT being
 *                               synced to the actual words.
 *
 * The mouth compositor already fails safe here, and CORRECTED 2026-09-30 because
 * this block was wrong on both counts. It said the patch paints "only when the
 * video src is CONTINUOUS_BODY_CLIP (StarraClipFace.tsx:976)". It paints on
 * EITHER still-mode body — base_loop (CONTINUOUS_BODY_CLIP) or speak_loop
 * (SPEAKING_BODY_CLIP) — since the speaking body shipped 2026-09-22; and :976 is
 * not the guard, it is unrelated body-watchdog wiring. The real guard derives
 * `bodyKind` from the showing layer's src and bails on anything else:
 * `if (bodyKind === null) return hide()` in StarraClipFace's v4 draw. RE-GREPPED
 * 2026-09-30: `shownSrc` is read at :1598, `bodyKind` is derived from
 * it at :1599-1604, and the guard itself is the single line
 * :1605. The range :1565-1571 that stood here was a SECOND bad citation
 * — written to replace a dead line number, it did not contain the guard either.
 * Grep `bodyKind === null` rather than trusting any of these numbers.
 *
 * The CONCLUSION still holds, which is why this stayed a record bug and not a
 * behaviour one: no alive-family clip is base_loop or speak_loop, so every one of
 * them yields bodyKind null and suppresses the patch on its own rather than
 * floating it over her cheek. a_talking_loop included — that is exactly why
 * pickBodyClip returning it while she speaks CANNOT layer two mouths.
 */
export const ALIVE_POOL = [
  "a_idle",
  "a_nod",
  "a_gaze_left",
  "a_gaze_right",
  "a_gaze_up",
  "a_tilt_left",
  "a_tilt_right",
  "a_eyebrow",
  "a_laugh",
] as const;

/** What she plays in alive mode while SPEAKING — her real talking footage. */
export const ALIVE_SPEAKING_CLIP: StarraClipKey = "a_talking_loop";

/** The clip alive mode rests on when nothing else is scheduled. */
export const ALIVE_BASE_CLIP: StarraClipKey = "a_idle";

export type BodyMode = "still" | "alive";

/**
 * Which clip the body should be showing, given the mode and what she is doing.
 * Pure so the scheduler is testable without a DOM.
 *
 * `prev` avoids an immediate repeat; `rand` is injectable for tests.
 */
export function pickBodyClip(
  mode: BodyMode,
  speaking: boolean,
  prev: StarraClipKey | null,
  rand: number,
  pool: readonly StarraClipKey[] = ALIVE_POOL,
): StarraClipKey {
  // still mode is the shipped behaviour, byte for byte: one clip, forever,
  // through every state. Do not let anything below change that.
  if (mode !== "alive") return CONTINUOUS_BODY_CLIP;
  // HER REAL TALKING FOOTAGE. REVERTED 2026-09-30 — the line that replaced this
  // returned CONTINUOUS_BODY_CLIP, and its stated reason ("the talking clip's own
  // moving mouth would create two mouths layered") is FALSE. The v4 patch paints
  // only when the showing layer's src is base_loop or body_speak
  // (StarraClipFace.tsx, `if (bodyKind === null) return hide()`), so on
  // a_talking_loop the patch is already suppressed by construction. There is no
  // two-mouths case here to prevent.
  //
  // What that change DID do is cut a 552x840 generation into this 832x1248
  // family — the seam ALIVE_POOL above measures at ~26, against base_loop's own
  // 1.687 loop seam (re-measured 2026-09-30; the "2.025" this file used to compare
  // against is speak_loop's seam, not base_loop's) and the 4.424 best-possible
  // base->speak pair the repo already rejects as visible. a_talking_loop is
  // also the ONLY clip in the alive family with `loop: true`, so it is the only
  // one a long reply cannot run dry on mid-sentence.
  //
  // THE TRADE IS DELIBERATE, AND IT IS CLASSIC'S TO MAKE: in alive mode her mouth
  // moves photorealistically but is NOT synced to her words. Buying synced lips
  // means giving up the alive family, which is a MODE DECISION — not a one-line
  // edit behind a comment.
  if (speaking) return ALIVE_SPEAKING_CLIP;
  return pickAlive(prev, rand, pool);
}

/**
 * How many CONSECUTIVE quiet heartbeat ticks before alive mode leaves the
 * talking clip.
 *
 * WHAT THIS ACTUALLY GUARANTEES, stated precisely because the first version of
 * this comment overstated it: N samples 2000ms apart bound the observed silence
 * at MORE THAN (N-1) x 2000ms, not N x 2000ms — the silence may have begun a
 * millisecond before the first sample. At 3 that is >4s of continuous quiet,
 * not 6s.
 */
export const ALIVE_QUIET_TICKS_BEFORE_ADVANCE = 3;

/**
 * The quiet counter's next value. Pure so the ACCUMULATION RULE is unit
 * testable — the bug this replaces was in the counting, not in the threshold.
 *
 * IT RESETS ON ANYTHING BUT "quiet, with the talking clip on screen". The first
 * version incremented on every silent heartbeat no matter what was showing, so
 * a long quiet stretch of gestures ran the counter up (30s of silence ≈ 15) and
 * the guard was already satisfied before she opened her mouth. The moment she
 * started speaking and the talking clip came up, the very first inter-chunk gap
 * tripped it — reproducing the exact mid-sentence cut the hysteresis was added
 * to prevent, only now disguised as a working guard.
 *
 * RESIDUAL, named rather than papered over: this infers "her turn is over" from
 * audio truth, and speakStarraChunks fires every chunk's synthesis in parallel,
 * so a slow /api/tts round-trip can leave a genuine gap mid-reply. A gap longer
 * than the threshold window still cuts to a gesture early. That is self-
 * correcting — when the gesture ends she is still speaking, so the scheduler
 * picks the talking clip again — and it is a brief cosmetic glitch in an opt-in
 * mode, not a stall.
 */
export function nextQuietTicks(
  prev: number,
  mode: BodyMode,
  playingKey: StarraClipKey | null,
  speaking: boolean,
): number {
  if (mode !== "alive") return 0;
  if (playingKey !== ALIVE_SPEAKING_CLIP) return 0;
  if (speaking) return 0;
  return prev + 1;
}

/**
 * Does the alive scheduler need to be pushed off what it is currently showing?
 *
 * THE HOLE THIS PLUGS. Alive mode advances on the video element's `ended`
 * event, and `ALIVE_SPEAKING_CLIP` is the one pool member with `loop: true` —
 * so it fires no `ended`, ever. Without an outside nudge the FIRST time she
 * speaks in alive mode she locks onto talking footage for the rest of the
 * session and plays it straight through every silence that follows.
 *
 * Every other clip in the pool is non-looping and hands over on its own, so
 * this returns false for them: pushing a gesture off mid-motion is the twitchy
 * cut the whole anchor-family design exists to avoid.
 *
 * ── WHY IT COUNTS TICKS INSTEAD OF READING "quiet" ONCE ─────────────────────
 * `bus.speaking` is NOT continuous across a spoken reply. speakStarraChunks
 * plays a long reply as up to three separate audio elements, and each one's
 * settle publishes `{ playing: false }` on the way out (speak.ts, "Between
 * chunks her mouth returns to rest") — so the bus reads NOT SPEAKING for the
 * whole inter-chunk gap: element construction, play(), the `playing` event, and
 * longer still if the next chunk's synthesis has not landed.
 *
 * A single-sample read would therefore let the 2s heartbeat land inside one of
 * those gaps and cut her talking footage into a 1.2-3.1s gesture MID-SENTENCE,
 * with no way back until that gesture ends. That is the same churn this design
 * avoids by not forcing `loop = false`; it would just arrive at random instead
 * of on a timer. Requiring consecutive quiet ticks means an inter-chunk gap —
 * far shorter than one tick, let alone two — can never be mistaken for the end
 * of her turn.
 *
 * Pure, so the rule is testable without a DOM: the caller (the face's body
 * heartbeat) owns the counter and resets it whenever audio truth says she is
 * speaking.
 */
export function aliveShouldAdvance(
  mode: BodyMode,
  playingKey: StarraClipKey | null,
  quietTicks: number,
): boolean {
  if (mode !== "alive") return false;
  if (playingKey !== ALIVE_SPEAKING_CLIP) return false;
  return quietTicks >= ALIVE_QUIET_TICKS_BEFORE_ADVANCE;
}

/** Is `id` a clip alive mode is allowed to schedule? Same shape as isIdlePoolMember. */
export function isAlivePoolMember(id: unknown): id is StarraClipKey {
  if (typeof id !== "string") return false;
  if (!Object.prototype.hasOwnProperty.call(STARRA_CLIPS, id)) return false;
  return (ALIVE_POOL as readonly string[]).indexOf(id) !== -1;
}

/**
 * Pick the next alive-pool clip, avoiding an immediate repeat.
 *
 * Mirrors pickIdle deliberately rather than sharing it: pickIdle falls back to
 * IDLE_POOL, and an alive-mode fallback into a 768x1168 idle clip would be the
 * one transition in this whole design that IS a visible cut.
 */
export function pickAlive(
  prev: StarraClipKey | null,
  rand: number,
  pool: readonly StarraClipKey[] = ALIVE_POOL,
): StarraClipKey {
  const src = Array.isArray(pool) && pool.length > 0 ? pool : ALIVE_POOL;
  const filtered = src.filter((k) => k !== prev);
  const arr: readonly StarraClipKey[] = filtered.length ? filtered : src;
  const r = Number.isFinite(rand) ? rand : 0;
  const i = Math.floor(r * arr.length);
  return arr[Math.min(arr.length - 1, Math.max(0, i))];
}

/** How long the crossfade between clips lasts (ms). Must match the CSS opacity transition. */
export const CROSSFADE_MS = 320;

/**
 * Is `id` a clip the idle cycle is actually allowed to play?
 *
 * TWO conditions, both necessary:
 *   1. it exists in STARRA_CLIPS (there is a real file behind it), and
 *   2. it is a member of IDLE_POOL above (it has been MEASURED clean).
 *
 * Condition 2 is not bureaucracy. `talking` exists and has `loop: true`, so it
 * would never fire `ended` and her face would freeze on it forever; idle_a /
 * idle_b / idle_c exist and each carries a measured disqualifying defect (see the
 * IDLE_POOL block above — corrupted frames, long eye closures, off-camera gaze).
 * Runtime cosmetics may therefore NARROW this pool, never widen it.
 */
export function isIdlePoolMember(id: unknown): id is StarraClipKey {
  if (typeof id !== "string") return false;
  if (!Object.prototype.hasOwnProperty.call(STARRA_CLIPS, id)) return false;
  return (IDLE_POOL as readonly string[]).indexOf(id) !== -1;
}

/**
 * Turn a REQUESTED idle-clip selection (from live cosmetics, i.e. the Options
 * panel's IDLE POOL toggles) into the pool her face will actually cycle.
 *
 * WHY THIS EXISTS (board finding MAJOR 4b). The panel persisted
 * `cosmetics.idlePool` to data/engine.json and the face used the frozen IDLE_POOL
 * const, so switching a glitchy clip OFF changed nothing — the panel said OFF,
 * engine.json said OFF, and her face kept playing it.
 *
 * SAFETY, in order:
 *   - unknown ids and non-pool clips are DROPPED (see isIdlePoolMember)
 *   - duplicates are collapsed, so one clip cannot dominate the shuffle
 *   - an EMPTY or malformed result falls back to the FULL default pool, because a
 *     frozen or blank face is strictly worse than a clip the operator disliked
 * IDLE_POOL therefore remains both the default AND the floor.
 */
export function resolveIdlePool(
  requested?: readonly unknown[] | null,
): readonly StarraClipKey[] {
  if (!Array.isArray(requested) || requested.length === 0) return IDLE_POOL;
  const out: StarraClipKey[] = [];
  for (const id of requested) {
    if (!isIdlePoolMember(id)) continue;
    if (out.indexOf(id) !== -1) continue;
    out.push(id);
  }
  return out.length > 0 ? out : IDLE_POOL;
}

/**
 * Pick the next idle clip, avoiding an immediate repeat so the cycle never feels
 * mechanical. `prev` = the clip currently showing (or null on first appearance);
 * `rand` in [0,1) (injectable for tests).
 *
 * `pool` defaults to IDLE_POOL, so every existing call site is unchanged; the
 * clip-face passes the cosmetics-resolved pool from resolveIdlePool(). An empty
 * or absent pool degrades to IDLE_POOL rather than returning undefined — the
 * caller assigns the result straight into STARRA_CLIPS[key], and undefined there
 * would throw inside her face.
 */
export function pickIdle(
  prev: StarraClipKey | null,
  rand: number,
  pool: readonly StarraClipKey[] = IDLE_POOL,
): StarraClipKey {
  const src = Array.isArray(pool) && pool.length > 0 ? pool : IDLE_POOL;
  const filtered = src.filter((k) => k !== prev);
  const arr: readonly StarraClipKey[] = filtered.length ? filtered : src;
  const r = Number.isFinite(rand) ? rand : 0;
  const i = Math.floor(r * arr.length);
  // Clamp BOTH ends: a negative or >=1 rand used to index out of the array and
  // hand back undefined.
  return arr[Math.min(arr.length - 1, Math.max(0, i))];
}
