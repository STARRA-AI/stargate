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
  // MEASURED on the shipped file: 552x720, 24fps, 266 frames, 11.083333s, no
  // audio stream (`ffprobe` 2026-07-30). 266/24*1000 = 11083ms.
  body_base: { file: "/avatar/body/base_loop.mp4", durationMs: 11083, loop: true },
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
 * WHAT MAKES THAT SAFE, measured (2026-07-30):
 *   - cut from a QC'd take: head travel 10x17px over the whole 11.08s, no zoom,
 *     eyes open and on the lens throughout, 0 corrupt frames.
 *   - the loop point came from an exhaustive seam search: seam mean-abs-diff
 *     2.025 = 1.64x the clip's MEDIAN inter-frame motion but only 0.52x its
 *     MAXIMUM natural inter-frame motion. The seam is smaller than motion that
 *     already happens naturally in the clip, so it is invisible.
 *
 * WHAT IT COSTS. Her mouth is AT REST for all 266 frames (aperture 4-14px, 0
 * frames above 2x median). This clip carries NO speech. The composited patch is
 * therefore not decoration — it is the ONLY thing that makes her look like she
 * is talking. If THIS CLIP fails to load, StarraClipFace retries it on a capped
 * backoff — never a switch to another clip (Classic's order, 2026-07-30).
 */
export const CONTINUOUS_BODY_CLIP: StarraClipKey = "body_base";

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
