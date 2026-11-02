/**
 * viseme-sync — drive her REAL mouth, from her OWN footage, at native
 * resolution, in the browser, for $0.
 *
 * THE SHAPE OF IT
 * The base clip (public/avatar/clips/talking.mp4, 832x1248) keeps playing
 * untouched, so her HEAD AND BODY keep moving exactly as filmed. Over just her
 * mouth we paint a ~170x130 patch cut from THAT SAME FOOTAGE, choosing the
 * patch whose mouth openness matches her live audio this instant. Because base
 * and patch come from one source, skin, lighting and grain match by
 * construction — there is nothing to colour-correct.
 *
 * WHAT THIS IS NOT: this is amplitude/energy-driven, NOT phoneme-accurate lip
 * reading. Her mouth matches her words in TIMING and OPENNESS. It is not
 * forensically viseme-correct, and it is not claimed to be.
 *
 * The bank + per-frame mouth-box track are built offline by
 * scripts/build-viseme-bank.mjs (ffmpeg only, no network, no GPU, run once).
 *
 * Everything here is PURE and DOM-free apart from the two clearly marked
 * browser helpers, so the analysis is unit-testable with plain Float32Arrays.
 */

// ── contract types (A1<->A2 interface; A2 imports these, never edits them) ──

export interface VisemeBank {
  version: 1;
  source: string;
  width: number;
  height: number;
  fps: number;
  frames: { id: string; file: string; openness: number }[];
}

export interface MouthAnchorTrack {
  fps: number;
  frames: { x: number; y: number; w: number; h: number }[];
}

/**
 * Mouth sync is FREE — local PNGs plus an AnalyserNode, no API, no GPU, no
 * billed call ever — so it defaults ON. Opt out with NEXT_PUBLIC_MOUTH_SYNC=0.
 * (Deliberately not wired to NEXT_PUBLIC_LIPSYNC, which gates the paid
 * Replicate/Colab render path and must stay 0.)
 */
export const MOUTH_SYNC_ENABLED: boolean =
  typeof process === "undefined" || process.env.NEXT_PUBLIC_MOUTH_SYNC !== "0";

/**
 * THE EFFECTIVE MOUTH GATE — build-time kill switch AND runtime cosmetic.
 *
 * WHY THIS EXISTS (board finding MAJOR 4a). The Options panel persisted
 * `cosmetics.mouthSync` to data/engine.json and NOTHING read it: the only real
 * gate was MOUTH_SYNC_ENABLED above, a BUILD-TIME env read. So the toggle
 * reported a state it did not control — a control that lies.
 *
 * The two inputs are NOT equal partners:
 *   - `envEnabled` (NEXT_PUBLIC_MOUTH_SYNC=0) is the HARD kill switch. It can
 *     only ever turn the mouth OFF, and no cosmetic can override it.
 *   - `cosmeticsMouthSync` is the operator's live preference, layered on top.
 *
 * A cosmetic that is `undefined`/`null`/non-boolean means "cosmetics are not
 * available" — the engine is absent, the operator is logged out, or the fetch has
 * not landed yet. That case returns exactly today's behaviour (env alone decides)
 * rather than guessing OFF, because the mouth must not disappear just because a
 * settings read failed. Only an explicit `false` turns it off.
 *
 * Pure, total, allocation-free: safe to call in a render.
 */
export function effectiveMouthSync(
  cosmeticsMouthSync?: boolean | null,
  envEnabled: boolean = MOUTH_SYNC_ENABLED,
): boolean {
  if (envEnabled !== true) return false;
  return cosmeticsMouthSync !== false;
}

// ── tunables ───────────────────────────────────────────────────────────────

/**
 * Anchor-confidence floor. Below it the offline tracker had lost the face (or
 * her head is grossly off-pose), so we skip the patch entirely and she falls
 * back to plain clip playback for those frames.
 *
 * Scope, honestly: this catches TRACKING FAILURE, not every head turn. On
 * talking.mp4 a visibly three-quarter-turned frame still scores ~0.98. What
 * makes those frames safe is that the patch is small and mouth-centred, so it
 * carries almost no cheek/jaw/background with it — verified by compositing the
 * worst pairing (closed viseme onto the most-turned frame). See the geometry
 * notes in scripts/build-viseme-bank.mjs.
 */
export const POSE_CONFIDENCE_FLOOR = 0.93;

/**
 * Below this NCC the patch is fully hidden; between here and
 * POSE_CONFIDENCE_FLOOR it FADES rather than cutting. See `poseVisibility`.
 */
export const POSE_CONFIDENCE_CUTOFF = 0.8;

/**
 * How long smoothed openness may sit at zero, while she is supposed to be
 * speaking, before we conclude the analyser is dead and hide the patch.
 *
 * RAISED 250 → 700 (2026-07-31, Classic's field report: "mouth flickers in
 * and out during speech"). 250ms cleared inter-WORD pauses but real speech is
 * full of inter-PHRASE pauses at 250-600ms — every one of them tripped the
 * gate, popped the patch off, then popped it back on the next word. The
 * gate's true target is a DEAD analyser, where an extra 450ms costs nothing:
 * on the v4 path the base clip's own mouth is AT REST, so nothing wrong is on
 * screen while we wait the longer window.
 */
export const OPENNESS_STALL_MS = 700;

/**
 * What counts as "no signal" for the stall gate.
 *
 * WHY NOT ZERO (board finding). The gate is fed `createMouthSmoother().step()`,
 * a one-pole (`v += (t - v) * alpha`): once v is non-zero it decays
 * ASYMPTOTICALLY and never returns to exactly 0. Measured with the real helpers:
 * 320ms at openness 0.5 then 9.6s of target 0 at 60fps leaves openness at
 * 6.26e-39 — arithmetically non-zero forever, so a `> 0` test only ever tripped
 * from a COLD start and the frozen half-open stamp could still be drawn for a
 * whole reply.
 *
 * WHY 1e-3 IS SAFE IN BOTH DIRECTIONS. `opennessFromAudio` already returns a HARD
 * 0 for anything at or under SILENCE_FLOOR, so real silence arrives as an exact
 * zero and real speech arrives orders of magnitude above. 1e-3 only ever catches
 * the decay tail — a level far below any visible mouth movement.
 *
 * CORRECTED 2026-09-30, and the correction INVERTS the old argument rather than
 * trimming it. This used to read "Nothing drawable lives below it: the shipped
 * bank's most-closed frame is v00 at openness 0.0814, i.e. 81x this value."
 * v00 at 0.0814 is the floor of public/avatar/visemes/bank.json — the 8-frame
 * LEGACY v1 bank (`jq` on it: ids v00..v07, floor 0.0814), which is the LAST
 * fallback rung, not the shipped bank. On the shipped v4 bank
 * (public/avatar/visemes3/bank.json) FIVE entries sit at openness exactly 0.0
 * (m_closed, m00, m01, m02, m03), so drawable frames DO live below this epsilon.
 * THE ACTION IS STILL RIGHT, for a different reason than the one stated: what
 * lives down there is a genuinely SHUT mouth, and hiding the patch over
 * base_loop's own at-rest mouth is the same picture as drawing it. Read this
 * constant as a decay-tail filter, never as a claim about the bank's floor.
 */
export const OPENNESS_SILENT_EPSILON = 1e-3;

/**
 * Hard ceiling on output-latency compensation. A bogus/huge reading would
 * otherwise make us read from before the ring even starts and freeze her mouth.
 */
export const MAX_OUTPUT_DELAY_MS = 400;

/** Mic/line noise sits under this RMS; treat it as silence. */
export const SILENCE_FLOOR = 0.006;
/**
 * The CLOSE side of the silence gate's hysteresis band (2026-07-31 fix for
 * at-threshold chatter). `opennessFromAudio`'s raw gate at SILENCE_FLOOR has
 * NO memory between calls — level sitting right at 0.006 (mic noise, a
 * fading breath) crosses it back and forth block to block, and each crossing
 * independently decides open/closed with nothing to damp the flip. Set to
 * 70% of SILENCE_FLOOR: a dead band wide enough to absorb typical mic-noise
 * jitter, narrow enough that true silence (ambient level far below either
 * floor) is unaffected — see createOpennessGate.
 */
export const SILENCE_RELEASE_FLOOR = SILENCE_FLOOR * 0.7;
/** RMS -> openness gain. Matches the existing reactive-face gain in
 *  useVoiceCall.ts (`rms(samples) * 6`) so both react at the same loudness. */
export const LEVEL_GAIN = 6;
/** Fast open, slower close — how a jaw actually moves, and it stops chatter. */
export const ATTACK_MS = 35;
export const RELEASE_MS = 110;

export const BANK_URL = "/avatar/visemes/bank.json";
export const ANCHOR_URL = "/avatar/visemes/anchor.json";

// ── pure analysis ──────────────────────────────────────────────────────────

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Root-mean-square of a time-domain buffer. Returns 0 for an empty buffer. */
export function rmsLevel(samples: Float32Array): number {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const v = Math.sqrt(sum / samples.length);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Fraction of spectral energy in the top half of the band — a cheap
 * spectral-centroid proxy over AnalyserNode byte frequency data.
 *
 * Why it matters: energy ALONE would fling her mouth wide open on an "sss",
 * which is exactly wrong — sibilants are loud but nearly closed. High-frequency
 * energy therefore PULLS OPENNESS DOWN. Open vowels put their energy low, so
 * they keep it. Returns 0 when there is nothing to measure.
 */
export function highBandRatio(freq: Uint8Array | null | undefined): number {
  if (!freq || freq.length < 4) return 0;
  const half = freq.length >> 1;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < half; i++) lo += freq[i];
  for (let i = half; i < freq.length; i++) hi += freq[i];
  const total = lo + hi;
  if (total <= 0) return 0;
  return clamp01(hi / total);
}

/**
 * Raw (unsmoothed) mouth openness 0..1 for one analysis block.
 * `freq` is optional — omit it and you get pure amplitude behaviour.
 */
export function opennessFromAudio(
  time: Float32Array,
  freq?: Uint8Array | null,
): number {
  return opennessAtLevel(rmsLevel(time), SILENCE_FLOOR, freq);
}

/**
 * The openness curve itself, with the silence floor as a parameter. ONE copy of
 * the gain + sibilance-damping math: `opennessFromAudio` and `createOpennessGate`
 * both go through here, so the fixed-floor and hysteresis paths cannot drift
 * apart the way two hand-kept copies would.
 */
function opennessAtLevel(
  level: number,
  floor: number,
  freq?: Uint8Array | null,
): number {
  if (level <= floor) return 0;
  const base = clamp01((level - floor) * LEVEL_GAIN);
  // sibilance damping: at most a 45% reduction, so she never goes fully shut
  // mid-word just because a fricative landed on this block.
  const sibilance = highBandRatio(freq);
  return clamp01(base * (1 - 0.45 * sibilance));
}

export interface OpennessGate {
  /** Openness for one block, gated with hysteresis around SILENCE_FLOOR. */
  step(time: Float32Array, freq?: Uint8Array | null): number;
  reset(): void;
}

/**
 * Stateful hysteresis wrapper around the SILENCE_FLOOR gate (2026-07-31 fix:
 * "raw-openness gate can flip per-block around the floor"). `opennessFromAudio`
 * itself stays untouched and pure — every existing caller/test of it keeps
 * today's exact single-floor behaviour — this wraps it with memory:
 *
 *   - CLOSED -> OPEN needs level > SILENCE_FLOOR (unchanged trigger).
 *   - OPEN -> CLOSED needs level <= SILENCE_RELEASE_FLOOR, the LOWER floor.
 *   - While OPEN, the gain reference also shifts to the release floor, so a
 *     level sitting in the dead band (between the two floors) draws a small
 *     but genuinely non-zero mouth instead of snapping shut and reopening —
 *     that snap-reopen, repeated every block, is exactly the chatter this
 *     closes. True silence (level under BOTH floors) still gates to exactly 0.
 *
 * One instance per active engine run (mirrors createMouthSmoother /
 * createStallGate / createOpennessRing — all per-run state, never module-level,
 * so nothing leaks across calls, components, or tests).
 */
export function createOpennessGate(): OpennessGate {
  let open = false;
  return {
    step(time: Float32Array, freq?: Uint8Array | null): number {
      const level = rmsLevel(time);
      const floor = open ? SILENCE_RELEASE_FLOOR : SILENCE_FLOOR;
      open = level > floor;
      return opennessAtLevel(level, floor, freq);
    },
    reset(): void {
      open = false;
    },
  };
}

export interface MouthSmoother {
  /** Advance by `dtMs` toward `target`; returns the new smoothed value. */
  step(target: number, dtMs: number): number;
  /** Current smoothed value, without advancing. */
  value(): number;
  reset(): void;
}

/**
 * Asymmetric one-pole smoother: quick attack, gentler release. This is what
 * stops a single loud or silent block from flapping her mouth for one frame.
 */
export function createMouthSmoother(
  attackMs: number = ATTACK_MS,
  releaseMs: number = RELEASE_MS,
): MouthSmoother {
  let v = 0;
  const safeAttack = attackMs > 0 ? attackMs : 1;
  const safeRelease = releaseMs > 0 ? releaseMs : 1;
  return {
    step(target: number, dtMs: number): number {
      const t = Number.isFinite(target) ? clamp01(target) : 0;
      const dt = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, 250) : 0;
      const tau = t > v ? safeAttack : safeRelease;
      const alpha = 1 - Math.exp(-dt / tau);
      v += (t - v) * alpha;
      if (v < 0) v = 0;
      if (v > 1) v = 1;
      return v;
    },
    value: () => v,
    reset() {
      v = 0;
    },
  };
}

// ── bank / track parsing (never throws; malformed input -> null) ────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Validate a parsed bank.json. Returns null for anything malformed. */
export function parseVisemeBank(raw: unknown): VisemeBank | null {
  try {
    if (!isRecord(raw)) return null;
    if (raw.version !== 1) return null;
    const width = num(raw.width);
    const height = num(raw.height);
    const fps = num(raw.fps);
    if (width === null || height === null || fps === null) return null;
    if (width <= 0 || height <= 0 || fps <= 0) return null;
    if (!Array.isArray(raw.frames) || raw.frames.length === 0) return null;
    const frames: VisemeBank["frames"] = [];
    for (const f of raw.frames) {
      if (!isRecord(f)) return null;
      const openness = num(f.openness);
      if (typeof f.id !== "string" || typeof f.file !== "string" || openness === null) return null;
      if (f.id.length === 0 || f.file.length === 0) return null;
      frames.push({ id: f.id, file: f.file, openness: clamp01(openness) });
    }
    frames.sort((a, b) => a.openness - b.openness);
    return {
      version: 1,
      source: typeof raw.source === "string" ? raw.source : "",
      width,
      height,
      fps,
      frames,
    };
  } catch {
    return null;
  }
}

/** A track box, plus the optional confidence the builder records alongside it. */
export interface MouthAnchorBox {
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

export interface ParsedAnchorTrack extends MouthAnchorTrack {
  frames: MouthAnchorBox[];
}

/** Validate a parsed anchor.json. Returns null for anything malformed. */
export function parseAnchorTrack(raw: unknown): ParsedAnchorTrack | null {
  try {
    if (!isRecord(raw)) return null;
    const fps = num(raw.fps);
    if (fps === null || fps <= 0) return null;
    if (!Array.isArray(raw.frames) || raw.frames.length === 0) return null;
    const frames: MouthAnchorBox[] = [];
    for (const f of raw.frames) {
      if (!isRecord(f)) return null;
      const x = num(f.x);
      const y = num(f.y);
      const w = num(f.w);
      const h = num(f.h);
      if (x === null || y === null || w === null || h === null) return null;
      if (w <= 0 || h <= 0) return null;
      const c = num(f.confidence);
      frames.push({ x, y, w, h, confidence: c === null ? 1 : c });
    }
    return { fps, frames };
  } catch {
    return null;
  }
}

// ── lookups ────────────────────────────────────────────────────────────────

/** Bank frame whose openness is nearest `openness`. Null if the bank is empty. */
export function pickVisemeFrame(
  bank: VisemeBank | null | undefined,
  openness: number,
): VisemeBank["frames"][number] | null {
  if (!bank || !bank.frames || bank.frames.length === 0) return null;
  const target = Number.isFinite(openness) ? clamp01(openness) : 0;
  let best = bank.frames[0];
  let bestDist = Math.abs(best.openness - target);
  for (let i = 1; i < bank.frames.length; i++) {
    const d = Math.abs(bank.frames[i].openness - target);
    if (d < bestDist) {
      bestDist = d;
      best = bank.frames[i];
    }
  }
  return best;
}

/** Clip playback time -> source frame index, CLAMPED into the track. */
export function frameIndexAt(timeSec: number, fps: number, frameCount: number): number {
  if (!Number.isFinite(timeSec) || !Number.isFinite(fps) || fps <= 0) return 0;
  if (!Number.isFinite(frameCount) || frameCount <= 0) return 0;
  const i = Math.floor(timeSec * fps);
  if (!Number.isFinite(i) || i < 0) return 0;
  return i >= frameCount ? frameCount - 1 : i;
}

/** Mouth box at a frame index. Out-of-range indices CLAMP to the ends. */
export function anchorAt(
  track: ParsedAnchorTrack | null | undefined,
  frameIndex: number,
): MouthAnchorBox | null {
  if (!track || !track.frames || track.frames.length === 0) return null;
  const n = track.frames.length;
  // NaN -> start; +/-Infinity clamp to the ends like any other out-of-range index.
  if (Number.isNaN(frameIndex)) return track.frames[0];
  let i = Math.floor(frameIndex);
  if (!(i > 0)) i = 0;
  if (i >= n) i = n - 1;
  return track.frames[i];
}

/** Is this frame's head pose close enough to the bank's for a patch to sit right? */
export function isPoseUsable(box: MouthAnchorBox | null | undefined): boolean {
  return !!box && box.confidence >= POSE_CONFIDENCE_FLOOR;
}

/**
 * Patch visibility 0..1 from pose confidence — a RAMP, not a cliff.
 *
 * WHY THIS REPLACED A BINARY GATE. `confidence` is the raw NCC of a rigid nose
 * template (see the `note` field in anchor.json), so it measures how far her
 * head has rotated off the reference pose — it is NOT a tracking-failure flag.
 * Measured on the shipped public/avatar/visemes/anchor.json: 50 of 354 frames
 * (14.1%) fall under POSE_CONFIDENCE_FLOOR, and they arrive in two RUNS —
 * frames 7-20 (~433ms) and frames 249-284 (~1200ms) — once per 11.8s loop.
 * The old `if (!isPoseUsable(box)) hide()` therefore yanked her mouth back to
 * the filmed lips, mid-word, twice a loop.
 *
 * Holding a frozen box across those runs would be worse, not better: the box is
 * never lost. Across run 1 it slides smoothly 326 -> 294 in x (w/h are constant
 * 140x100 for the whole track), so a held box would sit up to 30px off her
 * mouth on top of the pose mismatch. So we keep using the TRACKED box and
 * instead dissolve the patch as the pose degrades. With the shipped track that
 * turns 14.1% hard cuts into 8.7% partially-faded frames and only 5.4% fully
 * hidden, and every transition is gradual because NCC moves smoothly per frame.
 */
export function poseVisibility(
  box: MouthAnchorBox | null | undefined,
  floor: number = POSE_CONFIDENCE_FLOOR,
  cutoff: number = POSE_CONFIDENCE_CUTOFF,
): number {
  if (!box) return 0;
  const c = box.confidence;
  if (!Number.isFinite(c)) return 0;
  // Degenerate band (misconfigured tunables) -> behave like the old hard gate.
  if (!(floor > cutoff)) return c >= floor ? 1 : 0;
  if (c >= floor) return 1;
  if (c <= cutoff) return 0;
  return clamp01((c - cutoff) / (floor - cutoff));
}

/**
 * Milliseconds an AudioContext's output trails what its AnalyserNode reports.
 * The analyser taps the graph BEFORE the DAC, so without this her mouth LEADS
 * the sound — ~10-30ms wired (under the ~40ms perceptual threshold) but
 * commonly 150-300ms on AirPods/Bluetooth, which is plainly visible.
 *
 * Duck-typed on purpose: BOTH fields are absent on the macOS 12 WKWebView, and
 * this must return 0 there rather than NaN (NaN would poison the ring lookup).
 * Clamped to MAX_OUTPUT_DELAY_MS so a bogus reading cannot freeze her mouth.
 */
// Takes `unknown` deliberately: `AnalyserNode.context` is typed BaseAudioContext,
// which declares NEITHER field, and on the macOS 12 WKWebView neither exists at
// runtime either. Narrowing here is the honest shape of that uncertainty.
export function audioOutputDelayMs(ctx: unknown): number {
  if (!ctx || typeof ctx !== "object") return 0;
  const c = ctx as { baseLatency?: unknown; outputLatency?: unknown };
  const part = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  const ms = (part(c.baseLatency) + part(c.outputLatency)) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return ms > MAX_OUTPUT_DELAY_MS ? MAX_OUTPUT_DELAY_MS : ms;
}

/**
 * Small time-keyed ring of smoothed openness, so the renderer can read the
 * value from `now - outputDelay` instead of the value the analyser just
 * produced. That is what puts her mouth ON the sound rather than ahead of it.
 */
export interface OpennessRing {
  /** Record `value` as of monotonic timestamp `tMs` (performance.now()). */
  push(tMs: number, value: number): void;
  /** Openness as of `tMs`, linearly interpolated; ends clamp. 0 when empty. */
  sample(tMs: number): number;
  reset(): void;
  size(): number;
}

export function createOpennessRing(capacity: number = 64): OpennessRing {
  const cap = Number.isFinite(capacity) && capacity >= 2 ? Math.floor(capacity) : 64;
  const ts = new Float64Array(cap);
  const vs = new Float64Array(cap);
  let head = 0; // next write slot
  let count = 0;

  const at = (i: number): number => (head - count + i + cap * 2) % cap;

  return {
    push(tMs: number, value: number): void {
      // Drop garbage rather than storing it — one NaN would otherwise make
      // every later interpolation NaN and freeze her mouth open.
      if (!Number.isFinite(tMs) || !Number.isFinite(value)) return;
      ts[head] = tMs;
      vs[head] = clamp01(value);
      head = (head + 1) % cap;
      if (count < cap) count++;
    },
    sample(tMs: number): number {
      if (count === 0) return 0;
      const newest = at(count - 1);
      if (!Number.isFinite(tMs)) return vs[newest];
      if (count === 1) return vs[newest];
      const oldest = at(0);
      if (tMs <= ts[oldest]) return vs[oldest];
      if (tMs >= ts[newest]) return vs[newest];
      // walk back from newest — the target is almost always a few frames back
      for (let i = count - 1; i > 0; i--) {
        const hi = at(i);
        const lo = at(i - 1);
        if (tMs >= ts[lo] && tMs <= ts[hi]) {
          const span = ts[hi] - ts[lo];
          if (!(span > 0)) return vs[hi];
          const f = (tMs - ts[lo]) / span;
          return clamp01(vs[lo] + (vs[hi] - vs[lo]) * f);
        }
      }
      return vs[newest];
    },
    reset(): void {
      head = 0;
      count = 0;
    },
    size: () => count,
  };
}

/**
 * Watchdog for a DEAD analyser. If smoothed openness sits at zero for longer
 * than a real inter-word pause while she is supposed to be speaking, the audio is
 * not reaching the analyser at all — and the old code stamped a FROZEN mouth over
 * her filmed mouth for the whole reply. `update` returning true means HIDE the
 * patch and let her real filmed mouth play.
 *
 * WHICH BANK THAT FROZEN FRAME BELONGS TO, corrected 2026-09-30: the floor frame
 * "v00 at openness 0.0814 (a slightly OPEN mouth)" this used to name is the floor
 * of public/avatar/visemes/bank.json, the 8-frame LEGACY v1 bank — verified with
 * `jq` (v00..v07, floor 0.0814). The shipped v4 bank floors at a genuinely shut
 * mouth (five entries at openness 0.0). So on the v4 path this gate rescues a
 * FROZEN mouth rather than a half-open one; that is the defect either way, and on
 * the legacy rung the half-open floor this was written against is still real.
 */
export interface StallGate {
  /** Advance by `dtMs`; true once openness has been silent past the window. */
  update(openness: number, dtMs: number): boolean;
  reset(): void;
}

export function createStallGate(
  stallMs: number = OPENNESS_STALL_MS,
  epsilon: number = OPENNESS_SILENT_EPSILON,
): StallGate {
  const limit = Number.isFinite(stallMs) && stallMs > 0 ? stallMs : OPENNESS_STALL_MS;
  const eps =
    Number.isFinite(epsilon) && epsilon > 0 ? epsilon : OPENNESS_SILENT_EPSILON;
  let silentFor = 0;
  return {
    update(openness: number, dtMs: number): boolean {
      // EPSILON, not `> 0`: the smoother feeding this is a one-pole that decays
      // asymptotically and never lands on exactly 0 again once warm. See
      // OPENNESS_SILENT_EPSILON for why 1e-3 cannot swallow a drawable mouth.
      if (Number.isFinite(openness) && openness > eps) {
        silentFor = 0;
        return false;
      }
      const dt = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, 250) : 0;
      silentFor += dt;
      return silentFor > limit;
    },
    reset(): void {
      silentFor = 0;
    },
  };
}

/**
 * Monotonic generation token for the clip-face CROSSFADE, so a settle belonging
 * to a superseded crossfade can never publish a layer.
 *
 * THE BUG IT CLOSES. StarraClipFace registers a `transitionend` settle per
 * crossfade that publishes the incoming <video> as the visible layer (the mouth
 * patch reads that element's currentTime). Each settle removed only ITSELF, so a
 * second crossfade inside CROSSFADE_MS left the FIRST one live — and fading that
 * same element back out from 1 -> 0 fired it, pointing the front-layer ref at a
 * now-HIDDEN layer. The patch then hid itself (wrong src / opacity) for the rest
 * of the speaking turn. Real trigger: mode flips twice inside 320ms (barge-in ->
 * listening -> a queued utterance -> speaking).
 *
 * Pure and DOM-free on purpose, so the ordering rule is unit-testable.
 */
export interface CrossfadeGate {
  /** Start a crossfade; returns its token and invalidates every earlier one. */
  begin(): number;
  /** True only for the most recently begun, not-yet-cancelled crossfade. */
  isCurrent(token: number): boolean;
  /** Invalidate everything outstanding (component teardown). */
  cancelAll(): void;
}

export function createCrossfadeGate(): CrossfadeGate {
  let gen = 0;
  let live = 0; // 0 means "nothing outstanding" — no real token is ever 0
  return {
    begin(): number {
      gen += 1;
      live = gen;
      return gen;
    },
    isCurrent(token: number): boolean {
      return Number.isFinite(token) && token > 0 && token === live;
    },
    cancelAll(): void {
      live = 0;
    },
  };
}

// ── PHASE 2: the 2-D bank (openness x ROUNDNESS) ────────────────────────────
//
// WHAT WAS ACTUALLY WRONG, measured on her footage — worse than "no closed frame":
// rendering the 8 shipped PNGs as a labelled ladder showed SIX of the eight are
// visibly CLOSED mouths, including v04 (openness 0.563, source frame 103) and
// v05 (openness 0.688, source frame 225). The shipped 1-D scale is therefore not
// monotonic in aperture — at openness 0.5 the renderer drew a SHUT mouth, and her
// mouth only opened above ~0.75.
//
// The cause is her footage, and it is worth stating because it bounds what any
// bank can do: her openness distribution is BIMODAL. Of 354 frames, 295 sit below
// openness 0.2 and 54 above 0.7, with only 5 frames in the entire 0.2-0.7 middle.
// The old builder forced 8 EVENLY SPACED bands onto that two-state clip, so its
// middle bands could only be filled with closed frames wearing invented labels.
//
// bank2.json fixes the labelling (every entry carries its own MEASURED openness
// and roundness) and adds the second axis, so "oo" and "ah" are different mouths
// at the same loudness. It cannot invent mid-aperture footage that was never
// filmed, and it does not pretend to: entries with no real frame near their
// requested cell are flagged `approximation: true`. Built by
// scripts/build-viseme-bank-2d.py. NO pixel of her face is ever synthesised.
//
// STILL DEFERRED: per-frame ROLL rotation of the patch, from the tracker's head
// angle, so a tilted head does not get an upright mouth. That needs a roll column
// in anchor.json, which the 2-D rebuild did not add.

/** A bank frame carrying BOTH measured axes, plus its honest provenance. */
export interface VisemeBank2Frame {
  id: string;
  file: string;
  /** 0 = lips shut, 1 = her widest real aperture. */
  openness: number;
  /** 1 = rounded/narrow (oo, w), 0 = spread/wide (ee, ah). */
  roundness: number;
  sourceFrame: number;
  poseConfidence: number;
  /** Human-readable: "closed", "oo", "ah", "oh", "uh", "eh", "closed-wide". */
  label: string;
  /**
   * TRUE when no real frame lay near this entry's requested cell, i.e. her one
   * talking take does not contain this mouth shape and the NEAREST real frame
   * stands in for it. Never means "synthesised" — nothing here is synthesised.
   */
  approximation: boolean;
}

export interface VisemeBank2 {
  version: 2;
  source: string;
  width: number;
  height: number;
  fps: number;
  /**
   * Id of the dedicated BILABIAL frame — a genuinely shut mouth, so /m/ /b/ /p/
   * can actually close. Null when the file names no valid closed frame, in which
   * case the lookup degrades to plain 2-D nearest.
   */
  closedId: string | null;
  frames: VisemeBank2Frame[];
}

export const BANK2_URL = "/avatar/visemes/bank2.json";

/**
 * Below this smoothed openness the lookup FORCES the dedicated closed frame.
 *
 * WHY IT IS NEEDED AT ALL. Plain nearest-neighbour is not enough for a bilabial:
 * her closed cluster is dense (295 of 354 frames below openness 0.2) and includes
 * shapes from a 59px pursed mouth to a 77px near-smile, so "nearest" at low
 * openness could hand back a WIDE closed mouth on an /m/. Forcing the dedicated
 * entry makes the closure unambiguous.
 *
 * WHY 0.10. RE-DERIVED 2026-09-30 against the SHIPPED visemes3 bank (the old
 * text claimed "non-closed entries start at openness 0.133", which was the v2
 * bank). On bank.json's own axis — 0 = the 6px shut floor, 1 = a 44px aperture —
 * 0.10 is a ~9.8px aperture, and the only entries it swallows are m00..m03 (6px,
 * openness 0.0) and m04 (7px, openness 0.0263): every one of them is already a
 * shut mouth. Her first genuinely-parted entry is m05 at openness 0.2368 (~15px),
 * clear of this by 2.4x. `opennessFromAudio` also returns a hard 0 at or under
 * SILENCE_FLOOR, so real silence arrives as an exact zero.
 */
export const CLOSURE_OPENNESS = 0.1;

/**
 * How much more openness counts than roundness in the 2-D distance.
 *
 * JUSTIFIED BY MEASURED RELIABILITY, not taste. Openness comes from a linear
 * discriminant whose hand-verified exemplar classes are 14.3 standard deviations
 * apart on her footage. Roundness comes from an audio F2 proxy that scored
 * Cohen's d +1.05 / +1.35 and 79% / 84% frame accuracy on labelled speech from
 * two independent voices — real, but far noisier. Weighting the trustworthy axis
 * 3x keeps a noisy roundness reading from ever overriding a confident openness
 * one, which would look far worse than a slightly wrong lip width.
 */
export const OPENNESS_AXIS_WEIGHT = 3;
export const ROUNDNESS_AXIS_WEIGHT = 1;

/**
 * Time constant for the roundness smoother, in ms.
 *
 * Lip rounding is a SLOWER articulator than the jaw — you can drop your jaw
 * between two frames, but you purse your lips over a syllable — so this is
 * deliberately well above ATTACK_MS (35). Symmetric, because there is no
 * fast-open/slow-close asymmetry in lip spreading the way there is for a jaw.
 */
export const ROUNDNESS_TAU_MS = 120;

/**
 * Roundness calibration — RECALIBRATED 2026-07-30, measured not assumed.
 *
 * THE DEFECT THE OLD NUMBERS CARRIED (root-caused with synthetic spectra through
 * this exact function, then confirmed on recorded speech): every voiced vowel
 * puts its F1 (300-900Hz) inside the low band, and an open "ah" puts its F2
 * (~1100-1300Hz) in NEITHER band, so AH/OH/OO all collapsed to f2ratio far below
 * neutral -> roundness saturated at 1.0 -> the pick path returned the "oo" pucker
 * for every back/central vowel. End-to-end: AH selected m05 "oo-small". That is
 * the measured mechanism of "every sound looks like an O". A second bias: the
 * bands were SUMMED, and the mid band holds ~2x the bins of the low band, so a
 * flat (fricative/noise) spectrum read as strongly spread purely from bin count.
 *
 * THE FIX, each part forced by a measurement (offline `say` voices Samantha +
 * Alex, AnalyserNode byte spectra reproduced exactly: Blackman window, dB in
 * [-100,-30] -> bytes, 0.8 temporal smoothing):
 *   1. Band MEANS, not sums — a flat spectrum's f2ratio now scores exactly 0.5
 *      (the final roundness for broadband noise lands spread-side, which is the
 *      right direction for fricatives; true SILENCE still returns neutral 0.5
 *      through the zero-total guard).
 *   2. F2 term recentred: class means f2ratio rounded 0.363-0.383 / spread
 *      0.438-0.449, so neutral is 0.42 and span 0.13 maps the classes to roughly
 *      0.77 rounded / 0.27 spread without saturating.
 *   3. An F1 OPENNESS PENALTY — the part the F2 proxy fundamentally cannot do.
 *      /a/ has HIGH F1 (600-1000Hz), /u,o,i,e/ have LOW F1 (250-550Hz). Measured
 *      f1open = mean(600-1000)/(mean(250-550)+mean(600-1000)):
 *        ah 0.4610/0.5167   rounded 0.4129/0.4031   spread 0.3966/0.3929
 *      Subtracting F1_OPEN_GAIN * max(0, f1open - F1_OPEN_THRESHOLD) pulls the
 *      open vowel off the rounded end while leaving true rounding intact.
 * RESULT on the recorded corpora (median smoothed-free roundness):
 *   Samantha  rounded 0.875  spread 0.234  ah 0.450
 *   Alex      rounded 0.764  spread 0.208  ah 0.508
 * "ah" now lands CENTRAL (the m06/"ah" column), not on the pucker.
 */
export const F2_NEUTRAL = 0.42;
export const F2_SPAN = 0.13;
/** Band edges in Hz: F1 + rounded F2, versus spread F2. */
export const F2_LOW_HZ = 250;
export const F2_LOW_HI_HZ = 1100;
export const F2_MID_HZ = 1600;
export const F2_MID_HI_HZ = 3200;
/** F1 bands for the open-vowel penalty: close-vowel F1 vs open-vowel F1. */
export const F1_CLOSE_HZ = 250;
export const F1_CLOSE_HI_HZ = 550;
export const F1_OPEN_HZ = 600;
export const F1_OPEN_HI_HZ = 1000;
/** Penalty knee + slope, fitted on the measured class means above. */
export const F1_OPEN_THRESHOLD = 0.43;
export const F1_OPEN_GAIN = 5.5;

/** Validate a parsed bank2.json. Returns null for ANYTHING malformed. */
export function parseVisemeBank2(raw: unknown): VisemeBank2 | null {
  try {
    if (!isRecord(raw)) return null;
    // A v1 file must NOT be accepted here — the caller falls back to the 1-D path.
    if (raw.version !== 2) return null;
    const width = num(raw.width);
    const height = num(raw.height);
    const fps = num(raw.fps);
    if (width === null || height === null || fps === null) return null;
    if (width <= 0 || height <= 0 || fps <= 0) return null;
    if (!Array.isArray(raw.frames) || raw.frames.length === 0) return null;

    const frames: VisemeBank2Frame[] = [];
    for (const f of raw.frames) {
      if (!isRecord(f)) return null;
      const openness = num(f.openness);
      const roundness = num(f.roundness);
      // roundness is the whole point of v2: a frame without it is not a v2 frame.
      if (openness === null || roundness === null) return null;
      if (typeof f.id !== "string" || typeof f.file !== "string") return null;
      if (f.id.length === 0 || f.file.length === 0) return null;
      frames.push({
        id: f.id,
        file: f.file,
        openness: clamp01(openness),
        roundness: clamp01(roundness),
        sourceFrame: num(f.sourceFrame) ?? 0,
        poseConfidence: num(f.poseConfidence) ?? 1,
        label: typeof f.label === "string" ? f.label : "",
        approximation: f.approximation === true,
      });
    }
    frames.sort((a, b) => a.openness - b.openness || b.roundness - a.roundness);

    // A closedId that names no real frame is dropped rather than left dangling,
    // so the lookup never chases an id that cannot resolve to an image.
    const declared = typeof raw.closedId === "string" ? raw.closedId : null;
    const closedId =
      declared !== null && frames.some((f) => f.id === declared) ? declared : null;

    return {
      version: 2,
      source: typeof raw.source === "string" ? raw.source : "",
      width,
      height,
      fps,
      closedId,
      frames,
    };
  } catch {
    return null;
  }
}

/**
 * Roundness 0..1 from the SAME AnalyserNode byte spectrum openness already uses,
 * as an F1/F2 proxy. 1 = rounded (oo/w), 0 = spread (ee/ah), 0.5 = neutral.
 *
 * Returns a NEUTRAL 0.5 — never 0 — when there is nothing to measure. 0 would
 * mean "fully spread", which is a claim, whereas silence justifies no claim at
 * all. `sampleRate` is duck-typed by the caller because AnalyserNode.context is
 * typed BaseAudioContext; a bogus rate falls back to a 48kHz assumption rather
 * than returning NaN.
 */
export function roundnessFromAudio(
  freq: Uint8Array | null | undefined,
  sampleRate?: number,
): number {
  if (!freq || freq.length < 8) return 0.5;
  const sr = Number.isFinite(sampleRate) && (sampleRate as number) > 0
    ? (sampleRate as number)
    : 48000;
  const nyquist = sr / 2;
  const hzPerBin = nyquist / freq.length;
  if (!(hzPerBin > 0)) return 0.5;
  // Band MEANS (see the calibration note above): sums biased the ratio by pure
  // bin count — the mid band holds ~2x the low band's bins, so flat noise read
  // as strongly spread. Means make a flat spectrum score exactly 0.5.
  let lo = 0;
  let nLo = 0;
  let mid = 0;
  let nMid = 0;
  let f1c = 0;
  let nF1c = 0;
  let f1o = 0;
  let nF1o = 0;
  for (let i = 0; i < freq.length; i++) {
    const hz = i * hzPerBin;
    if (hz >= F2_LOW_HZ && hz < F2_LOW_HI_HZ) {
      lo += freq[i];
      nLo++;
    } else if (hz >= F2_MID_HZ && hz < F2_MID_HI_HZ) {
      mid += freq[i];
      nMid++;
    }
    if (hz >= F1_CLOSE_HZ && hz < F1_CLOSE_HI_HZ) {
      f1c += freq[i];
      nF1c++;
    } else if (hz >= F1_OPEN_HZ && hz < F1_OPEN_HI_HZ) {
      f1o += freq[i];
      nF1o++;
    }
  }
  const loMean = nLo > 0 ? lo / nLo : 0;
  const midMean = nMid > 0 ? mid / nMid : 0;
  const f2total = loMean + midMean;
  if (f2total <= 0) return 0.5; // nothing to measure -> NEUTRAL, never a claim
  const f2ratio = midMean / f2total;
  // centred on the measured decision boundary; rises as the lips ROUND
  let r = 0.5 + (F2_NEUTRAL - f2ratio) / F2_SPAN;
  // The open-vowel (high-F1) penalty: /a/ shares its LOW F2 with /u,o/, so the
  // F2 term alone reads it rounded. High F1 is what tells them apart (measured
  // class means in the calibration note). Only applied when the F1 bands carry
  // energy — silence must stay neutral.
  const f1cMean = nF1c > 0 ? f1c / nF1c : 0;
  const f1oMean = nF1o > 0 ? f1o / nF1o : 0;
  const f1total = f1cMean + f1oMean;
  if (f1total > 0) {
    const f1open = f1oMean / f1total;
    if (f1open > F1_OPEN_THRESHOLD) r -= F1_OPEN_GAIN * (f1open - F1_OPEN_THRESHOLD);
  }
  return Number.isFinite(r) ? clamp01(r) : 0.5;
}

/**
 * Bank frame nearest (openness, roundness) in the weighted 2-D plane, with
 * BILABIAL CLOSURE enforced below CLOSURE_OPENNESS.
 *
 * This is what stops "oo" and "ah" sharing a frame: at equal loudness the 1-D
 * scan had no way to tell them apart, and now the roundness axis decides.
 */
/*
 * GENERIC over the frame type on purpose (2026-07-30). The v4 bank below carries
 * the same two axes plus a baseBox, so it needs exactly this nearest-cell scan
 * and exactly this closure rule — duplicating the loop would let the two paths
 * drift apart. Every existing call site and test infers F = VisemeBank2Frame and
 * is unchanged.
 */
export function pickVisemeFrame2<
  F extends { id: string; openness: number; roundness: number },
>(
  bank: { closedId: string | null; frames: F[] } | null | undefined,
  openness: number,
  roundness: number,
): F | null {
  if (!bank || !bank.frames || bank.frames.length === 0) return null;
  const o = Number.isFinite(openness) ? clamp01(openness) : 0;
  // A non-finite roundness is NEUTRAL, not 0 — 0 would assert "fully spread".
  const r = Number.isFinite(roundness) ? clamp01(roundness) : 0.5;

  // /m/ /b/ /p/ must actually shut. Nearest-neighbour alone is not enough: her
  // closed cluster spans a 59px pursed mouth to a 77px near-smile, so "nearest"
  // could return a WIDE closed mouth on a bilabial.
  if (o < CLOSURE_OPENNESS && bank.closedId !== null) {
    for (let i = 0; i < bank.frames.length; i++) {
      if (bank.frames[i].id === bank.closedId) return bank.frames[i];
    }
  }

  let best = bank.frames[0];
  let bestDist = Infinity;
  for (let i = 0; i < bank.frames.length; i++) {
    const f = bank.frames[i];
    const dO = (f.openness - o) * OPENNESS_AXIS_WEIGHT;
    const dR = (f.roundness - r) * ROUNDNESS_AXIS_WEIGHT;
    const d = dO * dO + dR * dR; // squared: monotonic, and avoids a sqrt per frame
    if (d < bestDist) {
      bestDist = d;
      best = f;
    }
  }
  return best;
}

/**
 * One-pole smoother for ROUNDNESS. Two things differ from the mouth smoother:
 * it rests at NEUTRAL 0.5 rather than 0 (0 would mean "fully spread"), and it is
 * symmetric and slower (ROUNDNESS_TAU_MS), because lips round over a syllable
 * while a jaw can drop between two frames. That slower constant is what keeps
 * coarticulation smooth instead of letting lip width flicker frame to frame.
 */
export function createRoundnessSmoother(tauMs: number = ROUNDNESS_TAU_MS): MouthSmoother {
  const tau = Number.isFinite(tauMs) && tauMs > 0 ? tauMs : ROUNDNESS_TAU_MS;
  let v = 0.5;
  return {
    step(target: number, dtMs: number): number {
      // A non-finite target HOLDS the current value; it must not poison the pole.
      if (!Number.isFinite(target)) return v;
      const t = clamp01(target);
      const dt = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, 250) : 0;
      if (dt === 0) return v;
      const alpha = 1 - Math.exp(-dt / tau);
      v += (t - v) * alpha;
      if (v < 0) v = 0;
      if (v > 1) v = 1;
      return v;
    },
    value: () => v,
    reset() {
      v = 0.5;
    },
  };
}

// ── V4: the mouth that is composited onto the CONTINUOUS BODY ───────────────
//
// WHAT CHANGED, and why it is a different bank rather than a re-tune of the last
// one. Up to v2 the patch was pasted onto talking.mp4 — a clip that ALREADY has
// her talking, tracked per frame by anchor.json. v4 pastes onto
// public/avatar/body/base_loop.mp4, a continuous body whose mouth is AT REST for
// all 266 frames (aperture 4-14px; 0 frames above 2x median). That inverts the
// stakes: the patch is no longer a re-timing of a mouth that already moves, it is
// the ONLY thing that makes her look like she is talking.
//
// THE FILE. public/avatar/visemes3/bank.json, and its own `version` field says
// **4** — the directory is `visemes3` and the schema is v4. That mismatch is in
// the shipped asset, not a typo here; the parser keys off the version field.
//
// WHAT IS DIFFERENT FROM v2, per entry:
//   baseBox      {x,y,w,h} — the paste box in BASE_LOOP's OWN 552x840 pixel
//                space (552x840 confirmed 2026-09-30 by `ffprobe` on
//                public/avatar/body/base_loop.mp4: 552x840, 24fps, 266 frames).
//                Every entry shares ONE UNIFORM box placed by a single rigid
//                e-heavy->base_loop nose-template mapping, not per-entry template
//                re-registration — the old per-entry matching slid the "oo" crops
//                11-15px up into her nose (measured by
//                scripts/measure_mouth_alignment.py).
//                CORRECTED 2026-09-30, read off the shipped asset. The uniform box
//                is {x:248, y:278, w:152, h:102} (`jq '[.frames[].baseBox]|unique'
//                public/avatar/visemes3/bank.json`), and that bank's own
//                `placementNote` puts the mapping at scale 0.720, NCC 0.9950. The
//                numbers that stood here — y=242, nose baseline 238..241,
//                NCC 0.9822 — were the RETIRED bank's, in its coordinate space.
//                THE NOSE GUARANTEE, and prefer this to any number: the box top
//                clears the measured per-frame nose baseline on all 266 frames,
//                asserted for EVERY entry by tests/anatomy-v4-bank.test.ts:527
//                (opened and confirmed green 2026-09-30). Today that is top 278
//                against the NOSE_BASELINE_Y table at that file :483, whose 266
//                entries span 272..277 — parsed, not eyeballed.
//                LANDMINE: bank.json's own `placementNote` STILL recites the
//                retired y=242 / 238..241 pair, so the shipped asset contradicts
//                its own baseBox. Trust the baseBox and the test; do not
//                "restore" these numbers from that note.
//   registration each patch's NCC against base frame 0 at the shared box.
//                Metadata only — never a placement input.
// And top-level: `base`, `opennessCeiling` (1.0 in the SHIPPED visemes3 bank —
// see THE CEILING below) and `closedId` ("m_closed").
//
// SCALE — THE RUNTIME MUST NOT RESCALE. Each PNG's pixel size EQUALS its own
// baseBox w/h (asserted in tests/anatomy-v4-bank.test.ts). They were resampled
// ONCE, offline, from the e-heavy source crops. Any further scaling here would
// be a second resample of an already-resampled image.
//
// THE CEILING IS NOT A TUNABLE — AND THE NUMBER IN IT IS NOT 0.55. CORRECTED
// 2026-09-30, re-read off the asset: 0.55 described the FIRST v4 bank, whose
// ladder stopped at openness 0.50 because a full gape composited as a visible
// shout. The SHIPPED public/avatar/visemes3/bank.json declares
// `opennessCeiling: 1.0` and carries 24 entries spanning openness 0.00..1.00
// (m21/m22 at 1.0 — the measured 44px aperture), so clampOpenness is currently
// the IDENTITY. The RULE is what is fixed and what must survive a re-cut bank: a
// loud passage CLAMPS to whatever the bank declares, and never extrapolates past
// the top of the real ladder into footage that does not exist.

/** A paste box in base_loop's own pixel space. */
export interface VisemeBaseBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A v4 bank frame: both axes, plus where it goes on the base and how well it fit. */
export interface VisemeBank4Frame {
  id: string;
  file: string;
  openness: number;
  roundness: number;
  sourceFrame: number;
  label: string;
  /** Absolute paste box in BASE_LOOP coordinates (552x840), from frame 0. */
  baseBox: VisemeBaseBox;
  /** NCC of that template match. Metadata: it is a STATIC per-entry score, not
   *  a per-frame pose signal, so it is deliberately NOT used as an opacity ramp. */
  registration: number;
}

export interface VisemeBank4 {
  version: 4;
  /** The clip the PATCHES were cut from (provenance). */
  source: string;
  /** The clip the patches are pasted ONTO — must be the clip the face plays. */
  base: string;
  width: number;
  height: number;
  fps: number;
  /** Id of the bilabial closure, from the FILE. Null when it names nothing real. */
  closedId: string | null;
  /** Hard top of the real ladder. Openness is clamped here, never extrapolated. */
  opennessCeiling: number;
  frames: VisemeBank4Frame[];
}

export const BANK3_URL = "/avatar/visemes3/bank.json";

/**
 * Ceiling used when the bank declares none: 1, i.e. NO clamping — exactly the
 * pre-v4 behaviour. A missing ceiling must never be read as 0, which would pin
 * her mouth shut for a whole reply.
 */
export const DEFAULT_OPENNESS_CEILING = 1;

/** base_loop.mp4, measured with ffprobe 2026-07-30. */
export const BASE_LOOP_FRAMES = 266;
export const BASE_LOOP_FPS = 24;

/**
 * Body-clip playback time -> the body frame that is ON SCREEN. Both bodies
 * (base_loop.mp4 and speak_loop.mp4) are BASE_LOOP_FRAMES at BASE_LOOP_FPS.
 *
 * NEVER index the body with the BANK's fps. bank.json carries the rate of the
 * footage its patches were cut from (25 for the InfiniteTalk speaking render);
 * the bodies are cut at 24. Indexing a 24fps body at 25 ran the drift and
 * confidence tables up to 11 frames AHEAD of the picture by the end of every
 * loop — up to 30.7px of mouth placement error on the speaking body and the
 * wrong gate decision on a quarter of the ticks (measured 2026-09-22 from the
 * shipped tables). The old bank was cut from 24fps footage, which is why the
 * mismatch only appeared with the InfiniteTalk bank.
 */
export function bodyFrameAt(timeSec: number): number {
  return frameIndexAt(timeSec, BASE_LOOP_FPS, BASE_LOOP_FRAMES);
}

/**
 * MEASURED per-frame drift of her mouth across base_loop, in base_loop pixels,
 * RELATIVE TO FRAME 0 (which is the frame every baseBox was measured on, so
 * frame 0 is exactly {0,0} and a fixed box is the special case of this table).
 *
 * WHY THIS EXISTS — RESTATED 2026-09-30, because the rationale that stood here
 * described a file that is no longer shipped and the table below contradicted it.
 *
 * WHAT IT SAID: "a fixed box is NOT good enough, measured 2026-07-30 ...
 * template-matching m01 into all 266 frames puts her mouth at x 211..221 (span 10)
 * and y 203..221 (span 18) ... a box fixed at frame 0 is off by up to 17px
 * vertically, mean |dy| 6.0px, with 129/266 frames >= 6px off and 56/266 >= 10px
 * off ... 21% of the loop looked wrong."
 *
 * WHAT THE SHIPPED TABLE BELOW ACTUALLY SAYS (computed off these arrays
 * 2026-09-30, not re-template-matched): BASE_DRIFT_X spans 0..+8, BASE_DRIFT_Y
 * spans -2..+3. So a box fixed at frame 0 is off by at most 3px vertically, mean
 * |dy| 0.95px, with 0/266 frames >= 6px off and 0/266 >= 10px. Those two accounts
 * cannot both describe one file, and they do not: base_loop.mp4 was REPLACED on
 * 2026-09-22 by an InfiniteTalk listening render, and this table was re-measured
 * against the new file while the prose above it was not.
 *
 * SO WHY KEEP THE TABLE. Not for base_loop, where it is nearly a no-op today — for
 * SPEAK_LOOP, where it carries the whole weight: SPEAK_DRIFT_Y spans -31..+13,
 * mean |dy| 9.32px, 106/266 frames >= 10px off. bodyBoxAt feeds from whichever
 * body is showing, so one mechanism serves both; on base it costs nothing and
 * stays correct, on speak it is the difference between a registered mouth and one
 * up to 31px low. Do NOT "simplify" base back to a fixed box on the strength of
 * the small numbers — it is the same code path speak depends on.
 *
 * WHY IT IS SAFE — the drift is RIGID HEAD MOTION, not lip motion:
 *   - it is already smooth: max per-frame step 1px in either axis (verified on the
 *     shipped arrays), so there is nothing to smooth and no jitter to introduce.
 *   - it is seam-continuous: frame 265 -> frame 0 steps 1px in x and 0px in y
 *     (verified; this line read "0px in x, 1px in y", which was the retired
 *     table's wrap), so the loop wrap does not jump the mouth.
 *   - NOT re-verified on the shipped render, and carried over from 2026-07-30:
 *     the three-template agreement (m01 vs m02 mean 0.21px x / 0.59px y; m01 vs
 *     m_closed 0.08px / 0.62px) and the NCC 0.954..0.978 confidence. Those needed
 *     the template matcher, which was not re-run here.
 * TO REVERT to a fixed box, make baseDriftAt return {dx:0,dy:0}. Nothing else
 * changes; baseBoxAt is then the identity.
 */
const BASE_DRIFT_X: readonly number[] = [
  0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 4, 4,
  4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 7,
  7, 7, 7, 7, 8, 8, 7, 7, 7, 6, 6, 6, 5, 4, 4, 3, 3, 2, 2, 2, 2, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 3,
  4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 5, 5, 5, 4, 4, 4, 4,
  4, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2,
  2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 8,
  8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 7, 7, 7, 6, 6, 5, 4, 4, 3, 2,
  1, 1,
];
const BASE_DRIFT_Y: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3,
  3, 3, 3, 3, 3, 2, 2, 2, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 0, 0,
  0, 0, 0, 0, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, -1, -1, -1, -1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, -1, -1, -1, -1, -1, -1, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2,
  2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0,
  0, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -2, -2, -2, -2, -2, -2, -2, -1, -1, -1, 0,
  0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0,
];

/**
 * Mouth drift at a base_loop frame index. TOTAL: out-of-range indices CLAMP to
 * the ends (same rule as anchorAt), and a NaN index is a NO-OP {0,0} rather than
 * a NaN box — a NaN box would put her mouth at `translate(NaNpx, NaNpx)`.
 */
export function baseDriftAt(frameIndex: number): { dx: number; dy: number } {
  const n = BASE_DRIFT_X.length;
  if (n === 0 || n !== BASE_DRIFT_Y.length) return { dx: 0, dy: 0 };
  if (Number.isNaN(frameIndex)) return { dx: 0, dy: 0 };
  let i = Math.floor(frameIndex);
  if (!(i > 0)) i = 0;
  if (i >= n) i = n - 1;
  return { dx: BASE_DRIFT_X[i], dy: BASE_DRIFT_Y[i] };
}

/**
 * THE SECOND BODY (2026-09-22). Classic's goal is a face that is alive like a
 * person's. base_loop.mp4 is now cut from an InfiniteTalk render of her LISTENING
 * (blinks, breath, small head motion); speak_loop.mp4 from a render of her
 * SPEAKING (jaw, cheeks, brows, nods — the whole face talking). StarraClipFace
 * crossfades between them on her speech state, and the mouth patch composites
 * onto whichever is showing — so each body needs its own drift table.
 *
 * The speaking body moves for real (up to ~10px/frame on nods) and turns her
 * head out of the frontal pose on a minority of frames. Translation follows nods
 * correctly; it cannot follow rotation. So the speaking table also carries the
 * tracker's per-frame CONFIDENCE, and the patch fades with it: below the pose
 * floor her OWN talking mouth — real footage — shows through instead of a
 * mis-registered patch. Measured on the shipped window: 206/266 frames at
 * NCC >= 0.93 (multi-scale tracker), the rest are turns.
 *
 * Both tables are MEASURED by scripts/cut-idle-base.py and written by
 * scripts/apply-base-measure.py; nothing here is typed by hand.
 */
export type BodyKind = "base" | "speak";

const SPEAK_DRIFT_X: readonly number[] = [
  0, 0, 0, 0, 0, 0, 1, 4, 7, 10, 12, 12, 12, 11, 9, 7, 7, 6, 6, 7, 6, 6,
  7, 7, 7, 6, 7, 8, 8, 9, 10, 10, 10, 12, 12, 14, 16, 20, 20, 22, 20, 16, 12, 10,
  8, 8, 7, 6, 5, 4, 3, 2, 0, -2, -3, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4,
  -4, -4, -4, -3, -2, 0, 2, 4, 6, 8, 14, 16, 20, 20, 20, 20, 20, 20, 20, 18, 16, 15,
  12, 12, 10, 10, 10, 8, 8, 8, 8, 8, 10, 11, 12, 12, 10, 8, 7, 6, 4, 4, 2, 2,
  1, 1, 1, 0, 0, 0, 1, 1, 2, 4, 6, 9, 10, 12, 12, 14, 16, 16, 16, 14, 11, 7,
  4, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 0, 0, 1, 2, 6, 8, 9, 9, 10, 10,
  10, 10, 8, 8, 6, 6, 6, 5, 4, 4, 3, 2, 2, 2, 2, 2, 4, 5, 7, 9, 10, 9,
  7, 4, 1, -1, -3, -6, -6, -7, -7, -7, -7, -7, -6, -6, -6, -5, -4, -4, -2, -1, 1, 2,
  4, 5, 6, 6, 6, 6, 2, 2, 1, 0, 0, 0, 0, 1, 2, 2, 4, 4, 4, 4, 3, 2,
  1, 0, 0, 0, 0, 2, 5, 9, 11, 7, 4, 2, 2, 2, 3, 4, 5, 6, 6, 4, 4, 2,
  2, 2, 1, 1, 0, 0, 0, 0, -1, -2, -2, -2, -3, -3, -3, -3, -2, -2, -2, -2, -1, -1,
  -1, 0,
];
const SPEAK_DRIFT_Y: readonly number[] = [
  0, 0, 0, 0, -2, -3, -5, -8, -10, -11, -11, -11, -9, -8, -6, -2, 0, 4, 6, 8, 8, 8,
  7, 6, 5, 4, 2, -2, -6, -9, -13, -16, -19, -20, -20, -19, -16, -12, -12, -14, -17, -19, -19, -19,
  -18, -17, -14, -12, -10, -8, -4, 1, 5, 7, 8, 8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 9,
  9, 8, 8, 7, 5, 2, -3, -8, -13, -18, -23, -27, -30, -31, -31, -30, -29, -26, -23, -12, -8, -5,
  -4, -2, -3, -4, -6, -8, -9, -10, -11, -12, -12, -12, -10, -4, 2, 7, 10, 12, 13, 13, 13, 13,
  13, 13, 13, 12, 12, 12, 11, 9, 6, 2, -4, -10, -15, -19, -22, -23, -23, -22, -20, -17, -13, -8,
  -2, 5, 7, 8, 10, 10, 10, 10, 10, 9, 9, 8, 8, 6, 6, 5, 1, -4, -8, -12, -15, -17,
  -18, -18, -17, -15, -13, -10, -8, -6, -4, -2, -1, 0, 0, 0, 0, 0, 0, -2, -4, -4, -5, -4,
  -2, 0, 0, 2, 5, 10, 11, 12, 12, 12, 12, 12, 12, 11, 10, 9, 8, 6, 4, 2, -2, -6,
  -10, -16, -20, -22, -23, -24, -25, -23, -20, -18, -14, -10, -8, -6, -4, -1, 2, 4, 6, 7, 8, 9,
  9, 9, 9, 9, 8, 6, 3, -3, -10, -18, -19, -18, -14, -10, -6, -2, 2, 4, 6, 8, 8, 8,
  8, 8, 7, 7, 8, 8, 8, 8, 7, 6, 6, 6, 5, 3, 1, 1, 1, 1, 1, 0, 0, 0,
  0, 0,
];
/** Multi-scale nose-template NCC vs the speaking loop's frame 0, per frame. */
const SPEAK_CONF: readonly number[] = [
  1.000, 0.998, 0.997, 0.997, 0.997, 0.995, 0.991, 0.978, 0.964, 0.948, 0.941, 0.940, 0.945, 0.953, 0.955, 0.952, 0.949, 0.946, 0.943, 0.945, 0.947, 0.963,
  0.970, 0.971, 0.971, 0.971, 0.967, 0.968, 0.967, 0.963, 0.955, 0.948, 0.936, 0.928, 0.927, 0.933, 0.942, 0.949, 0.932, 0.921, 0.926, 0.926, 0.934, 0.935,
  0.943, 0.948, 0.948, 0.948, 0.957, 0.966, 0.975, 0.976, 0.967, 0.964, 0.965, 0.966, 0.977, 0.985, 0.987, 0.987, 0.991, 0.991, 0.990, 0.991, 0.991, 0.992,
  0.993, 0.992, 0.992, 0.992, 0.983, 0.971, 0.962, 0.951, 0.952, 0.945, 0.922, 0.899, 0.872, 0.867, 0.866, 0.872, 0.889, 0.905, 0.917, 0.941, 0.960, 0.973,
  0.977, 0.978, 0.978, 0.978, 0.974, 0.972, 0.969, 0.961, 0.956, 0.956, 0.961, 0.959, 0.964, 0.963, 0.954, 0.951, 0.951, 0.949, 0.954, 0.954, 0.961, 0.966,
  0.974, 0.977, 0.978, 0.981, 0.981, 0.980, 0.979, 0.978, 0.978, 0.970, 0.963, 0.952, 0.936, 0.913, 0.886, 0.877, 0.878, 0.894, 0.910, 0.941, 0.964, 0.974,
  0.980, 0.987, 0.987, 0.988, 0.986, 0.987, 0.987, 0.988, 0.987, 0.987, 0.988, 0.988, 0.988, 0.986, 0.967, 0.950, 0.954, 0.967, 0.960, 0.949, 0.945, 0.942,
  0.944, 0.939, 0.937, 0.942, 0.946, 0.960, 0.972, 0.980, 0.982, 0.985, 0.986, 0.988, 0.987, 0.986, 0.986, 0.987, 0.979, 0.964, 0.958, 0.964, 0.969, 0.970,
  0.969, 0.956, 0.951, 0.966, 0.981, 0.989, 0.987, 0.986, 0.985, 0.985, 0.987, 0.987, 0.988, 0.986, 0.988, 0.988, 0.988, 0.987, 0.987, 0.975, 0.961, 0.956,
  0.954, 0.945, 0.936, 0.931, 0.920, 0.922, 0.931, 0.936, 0.945, 0.956, 0.957, 0.960, 0.957, 0.965, 0.975, 0.983, 0.985, 0.984, 0.981, 0.978, 0.975, 0.972,
  0.970, 0.976, 0.975, 0.976, 0.976, 0.980, 0.980, 0.973, 0.969, 0.947, 0.950, 0.955, 0.954, 0.954, 0.962, 0.967, 0.979, 0.987, 0.988, 0.987, 0.986, 0.984,
  0.982, 0.982, 0.983, 0.984, 0.986, 0.985, 0.983, 0.981, 0.978, 0.978, 0.979, 0.982, 0.983, 0.982, 0.982, 0.975, 0.959, 0.922, 0.837, 0.851, 0.895, 0.941,
  0.972, 0.992,
];

/**
 * Above FULL the patch is fully shown; at or below FLOOR it is hidden. The ramp is
 * deliberately NARROW: composited at 50% on a tilted frame (confidence 0.92) the
 * patch read as a translucent seam — looked at 2026-09-22 — so a frame is either
 * her driven mouth or her own talking mouth, almost never a blend of the two. The
 * floor is the pose floor the bank itself is gated on.
 */
export const SPEAK_CONF_FULL = 0.95;
export const SPEAK_CONF_FLOOR = 0.93;

function clampIndex(n: number, frameIndex: number): number {
  if (Number.isNaN(frameIndex)) return 0;
  let i = Math.floor(frameIndex);
  if (!(i > 0)) i = 0;
  if (i >= n) i = n - 1;
  return i;
}

/** Mouth drift for either body. TOTAL, same clamping rules as baseDriftAt. */
export function bodyDriftAt(kind: BodyKind, frameIndex: number): { dx: number; dy: number } {
  if (kind === "base") return baseDriftAt(frameIndex);
  const n = SPEAK_DRIFT_X.length;
  if (n === 0 || n !== SPEAK_DRIFT_Y.length) return { dx: 0, dy: 0 };
  const i = clampIndex(n, frameIndex);
  return { dx: SPEAK_DRIFT_X[i], dy: SPEAK_DRIFT_Y[i] };
}

/**
 * How much of the patch to show on this body frame, 0..1. The listening body is
 * frontal on every frame (measured NCC >= 0.93 throughout), so it is always 1.
 * The speaking body ramps between SPEAK_CONF_FLOOR and SPEAK_CONF_FULL. TOTAL:
 * an empty table or a non-finite value means "show it" — never a NaN opacity.
 */
export function bodyPatchConfidence(kind: BodyKind, frameIndex: number): number {
  if (kind === "base") return 1;
  const n = SPEAK_CONF.length;
  if (n === 0) return 1;
  const c = SPEAK_CONF[clampIndex(n, frameIndex)];
  if (!Number.isFinite(c)) return 1;
  if (c >= SPEAK_CONF_FULL) return 1;
  if (c <= SPEAK_CONF_FLOOR) return 0;
  return (c - SPEAK_CONF_FLOOR) / (SPEAK_CONF_FULL - SPEAK_CONF_FLOOR);
}

/**
 * The tracker's RAW per-frame confidence for the body on screen (SPEAK_CONF as
 * measured, not the 0..1 ramp). The listening body is frontal throughout: 1.
 * The gate needs the raw value: "clearly turned" lives BELOW the floor, which
 * the ramp clamps away.
 */
export function bodyPatchRawConfidence(kind: BodyKind, frameIndex: number): number {
  if (kind === "base") return 1;
  const n = SPEAK_CONF.length;
  if (n === 0) return 1;
  const c = SPEAK_CONF[clampIndex(n, frameIndex)];
  return Number.isFinite(c) ? c : 1;
}

/**
 * THE SPEAKING-BODY GATE — decides whether the driven mouth patch is shown on
 * the speaking body, or hidden so her own filmed talking mouth shows.
 *
 * OFF only after the track has been at or below SPEAK_CONF_FLOOR for
 * GATE_OFF_DEBOUNCE_MS (a 2-5 frame nod is tracker noise, not a turn), or at
 * once when she has CLEARLY turned (<= GATE_CLEARLY_TURNED). Back ON the
 * moment the track is at SPEAK_CONF_FULL again — no dwell: a hidden patch on a
 * frontal face is lips that do not match her voice. Between floor and full it
 * holds. Simulated at 60Hz over the shipped table (tests/speaking-body.test.ts):
 * 6 switches per 11s loop, hidden-while-frontal 0.0%, shown-while-turned 3.6%.
 * The previous symmetric 500ms dwell measured 9.7 switches, hidden-while-
 * frontal 7.3%, and its "clearly turned" escape could never fire.
 */
export const GATE_OFF_DEBOUNCE_MS = 120;
export const GATE_CLEARLY_TURNED = 0.91;

export interface SpeakGate {
  /** Feed one tick; returns whether the patch is shown. */
  step(rawConf: number, nowMs: number): boolean;
  readonly on: boolean;
}

export function createSpeakGate(opts?: {
  offDebounceMs?: number;
  clearlyTurned?: number;
  full?: number;
  floor?: number;
}): SpeakGate {
  const offMs = opts?.offDebounceMs ?? GATE_OFF_DEBOUNCE_MS;
  const turned = opts?.clearlyTurned ?? GATE_CLEARLY_TURNED;
  const full = opts?.full ?? SPEAK_CONF_FULL;
  const floor = opts?.floor ?? SPEAK_CONF_FLOOR;
  let on = true;
  let lowSince: number | null = null;
  return {
    get on() {
      return on;
    },
    step(rawConf, nowMs) {
      // A non-finite confidence means "show it" — never a hidden mouth on NaN.
      const c = Number.isFinite(rawConf) ? rawConf : 1;
      if (c <= floor) {
        if (lowSince === null) lowSince = nowMs;
      } else {
        lowSince = null;
      }
      if (on) {
        if (lowSince !== null && (nowMs - lowSince >= offMs || c <= turned)) on = false;
      } else if (c >= full) {
        on = true;
      }
      return on;
    },
  };
}

/** An entry's paste box, moved onto the frame of whichever body is on screen. */
export function bodyBoxAt(kind: BodyKind, box: VisemeBaseBox, frameIndex: number): VisemeBaseBox {
  const d = bodyDriftAt(kind, frameIndex);
  const x = box.x + d.dx;
  const y = box.y + d.dy;
  return {
    x: Number.isFinite(x) ? x : box.x,
    y: Number.isFinite(y) ? y : box.y,
    w: box.w,
    h: box.h,
  };
}

/** An entry's paste box, moved onto the base frame actually on screen. */
export function baseBoxAt(box: VisemeBaseBox, frameIndex: number): VisemeBaseBox {
  const d = baseDriftAt(frameIndex);
  const x = box.x + d.dx;
  const y = box.y + d.dy;
  return {
    x: Number.isFinite(x) ? x : box.x,
    y: Number.isFinite(y) ? y : box.y,
    w: box.w,
    h: box.h,
  };
}

/** Validate a parsed visemes3/bank.json. Returns null for ANYTHING malformed. */
export function parseVisemeBank4(raw: unknown): VisemeBank4 | null {
  try {
    if (!isRecord(raw)) return null;
    // v1/v2 must NOT be accepted here — the loader falls back to those paths.
    if (raw.version !== 4) return null;
    const width = num(raw.width);
    const height = num(raw.height);
    const fps = num(raw.fps);
    if (width === null || height === null || fps === null) return null;
    if (width <= 0 || height <= 0 || fps <= 0) return null;
    if (!Array.isArray(raw.frames) || raw.frames.length === 0) return null;

    const frames: VisemeBank4Frame[] = [];
    for (const f of raw.frames) {
      if (!isRecord(f)) return null;
      const openness = num(f.openness);
      const roundness = num(f.roundness);
      if (openness === null || roundness === null) return null;
      if (typeof f.id !== "string" || typeof f.file !== "string") return null;
      if (f.id.length === 0 || f.file.length === 0) return null;
      // baseBox is the whole point of v4. A frame without a PLACEABLE box is not
      // a v4 frame, and guessing one would paste her mouth somewhere arbitrary.
      if (!isRecord(f.baseBox)) return null;
      const bx = num(f.baseBox.x);
      const by = num(f.baseBox.y);
      const bw = num(f.baseBox.w);
      const bh = num(f.baseBox.h);
      if (bx === null || by === null || bw === null || bh === null) return null;
      if (bw <= 0 || bh <= 0) return null;
      frames.push({
        id: f.id,
        file: f.file,
        openness: clamp01(openness),
        roundness: clamp01(roundness),
        sourceFrame: num(f.sourceFrame) ?? 0,
        label: typeof f.label === "string" ? f.label : "",
        baseBox: { x: bx, y: by, w: bw, h: bh },
        // absent registration is "no information", not "bad fit" — same
        // convention as parseAnchorTrack's confidence and v2's poseConfidence.
        registration: num(f.registration) ?? 1,
      });
    }
    frames.sort((a, b) => a.openness - b.openness || b.roundness - a.roundness);

    const declared = typeof raw.closedId === "string" ? raw.closedId : null;
    const closedId =
      declared !== null && frames.some((f) => f.id === declared) ? declared : null;

    const ceilRaw = num(raw.opennessCeiling);
    const opennessCeiling =
      ceilRaw !== null && ceilRaw > 0 ? (ceilRaw > 1 ? 1 : ceilRaw) : DEFAULT_OPENNESS_CEILING;

    return {
      version: 4,
      source: typeof raw.source === "string" ? raw.source : "",
      base: typeof raw.base === "string" ? raw.base : "",
      width,
      height,
      fps,
      closedId,
      opennessCeiling,
      frames,
    };
  } catch {
    return null;
  }
}

/**
 * Hold openness AT the bank's ceiling instead of asking for footage above it.
 *
 * CORRECTED 2026-09-30 — the old text here said "the v4 ladder tops out at
 * openness 0.50 with a hard ceiling of 0.55". That was the FIRST v4 bank. The
 * SHIPPED visemes3/bank.json declares `opennessCeiling: 1.0` and carries real
 * entries all the way up (m21/m22 at openness 1.0, i.e. the measured 44px
 * aperture), so this function is the IDENTITY on today's bank. It stays because
 * the guarantee is what matters, not the current number: never let a later change
 * (an extrapolation, a synthesised in-between, a re-cut bank) treat a loud passage
 * as licence to open her mouth past what was actually filmed.
 *
 * TOTAL: a non-finite openness is 0, a non-finite/non-positive ceiling means no
 * clamping, and a ceiling above 1 cannot lift openness past 1.
 */
export function clampOpenness(openness: number, ceiling: number): number {
  const o = Number.isFinite(openness) ? clamp01(openness) : 0;
  const c =
    Number.isFinite(ceiling) && ceiling > 0
      ? ceiling > 1
        ? 1
        : ceiling
      : DEFAULT_OPENNESS_CEILING;
  return o > c ? c : o;
}

/**
 * v4 lookup: clamp to the bank's ceiling, then the SAME weighted 2-D nearest
 * scan and the SAME bilabial closure rule as pickVisemeFrame2 (it delegates —
 * one implementation, so the two paths cannot drift apart).
 */
export function pickVisemeFrame4(
  bank: VisemeBank4 | null | undefined,
  openness: number,
  roundness: number,
): VisemeBank4Frame | null {
  if (!bank || !bank.frames || bank.frames.length === 0) return null;
  return pickVisemeFrame2(bank, clampOpenness(openness, bank.opennessCeiling), roundness);
}

/**
 * The canvas size that fits EVERY entry: the largest baseBox in the bank.
 *
 * WHY ONE SHARED SIZE. Re-sizing the canvas per frame would reallocate its
 * backing store whenever the pick flips between size groups, which roundness
 * wobble can do frame to frame. So the canvas is sized ONCE to the maximum and
 * each patch is drawn CENTRED in it (see patchPlacement), which also keeps the
 * feathered mask centred on the patch. The rebuilt bank's boxes are UNIFORM, so
 * today this is the identity; the machinery stays for any future mixed-size bank.
 *
 * WHAT THAT TEST ACTUALLY ASSERTS — because this line used to borrow its authority
 * for a figure it never mentions. tests/anatomy-v4-bank.test.ts:515 (opened
 * 2026-09-30) asserts UNIFORMITY ONLY: `assert.deepEqual(f.baseBox, first)` for
 * every entry, naming no size. The SIZE is the asset's, not the test's — 152x102,
 * from bank.json's width/height and from every baseBox's w/h. The "131x78" that
 * stood here was the retired bank. Cite uniformity to the test; read the size off
 * bank.json.
 */
export function bankPatchExtent(
  frames: readonly { baseBox: VisemeBaseBox }[] | null | undefined,
): { w: number; h: number } | null {
  if (!frames || frames.length === 0) return null;
  let w = 0;
  let h = 0;
  for (const f of frames) {
    if (!f || !f.baseBox) return null;
    const bw = f.baseBox.w;
    const bh = f.baseBox.h;
    if (!Number.isFinite(bw) || !Number.isFinite(bh) || bw <= 0 || bh <= 0) return null;
    if (bw > w) w = bw;
    if (bh > h) h = bh;
  }
  return w > 0 && h > 0 ? { w: Math.ceil(w), h: Math.ceil(h) } : null;
}

/**
 * Where to draw a patch inside the shared canvas, and where that canvas' origin
 * then has to sit so the patch still lands exactly on its baseBox.
 *
 * `drawX/drawY` centre the patch in the canvas; `originX/originY` are the canvas'
 * top-left in BASE_LOOP pixels, i.e. baseBox minus that centring offset. By
 * construction originX + drawX === box.x, so the centring is exact rather than an
 * approximation — the patch is under the middle of the elliptical mask AND on its
 * measured box at the same time.
 *
 * Returns null (draw nothing) if the box cannot fit, rather than cropping her mouth.
 */
export function patchPlacement(
  box: VisemeBaseBox | null | undefined,
  canvasW: number,
  canvasH: number,
): { drawX: number; drawY: number; originX: number; originY: number } | null {
  if (!box) return null;
  const { x, y, w, h } = box;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  if (!Number.isFinite(canvasW) || !Number.isFinite(canvasH)) return null;
  if (w > canvasW || h > canvasH) return null;
  const drawX = Math.floor((canvasW - w) / 2);
  const drawY = Math.floor((canvasH - h) / 2);
  return { drawX, drawY, originX: x - drawX, originY: y - drawY };
}

// ── the LOCAL TONE MATCH ────────────────────────────────────────────────────
//
// WHY IT IS NEEDED even though patch and base come from the same footage. The
// patches were cut from a separate source render and resampled to the base's
// scale, so their exposure can land a few levels off the base's. A ~15-level
// channel shift on a mouth-sized patch reads as a different exposure, i.e. a
// visible rectangle — that is what this exists to remove.
//
// WHAT IS GUARANTEED, which is all this comment should ever have claimed:
// `toneMatchOffsets` is the IDENTITY when the means already agree (asserted at
// tests/anatomy-v4-bank.test.ts:328-330, opened 2026-09-30 — matching means give
// [0,0,0]), and it is a MEAN SHIFT ONLY — no gain, no gamma, no per-pixel
// transfer — so it cannot invent or destroy detail. That property survives any
// re-cut of the bank; a per-entry number does not.
//
// WHAT WAS REMOVED 2026-09-30, and why. This block used to end "the composite is
// seamless (composited and LOOKED at, all 10 entries)". The shipped bank has 24
// entries (`jq '.frames|length' public/avatar/visemes3/bank.json`), so that count
// covered under half of it and seamlessness was NOT confirmed across the bank —
// StarraClipFace.tsx already flagged "10 entries" as this line's stale count.
// THERE IS NO PER-ENTRY VISUAL CONFIRMATION ON RECORD for the shipped bank. Do
// not write one back until somebody has actually looked.
// The per-channel figures that stood here (+15.5 on m07's red, +13.4 on m05's,
// most inside +-7, over base frames 0/66/132/199/265) were measured 2026-07-30 on
// the RETIRED bank, before the 2026-09-22 rebuild replaced base_loop.mp4 AND the
// patch set. They have not been re-measured, and the ids no longer mean what that
// sentence meant by them: in the shipped bank m05 is labelled "ee" and m07
// "oo-small", not an "oo" pair.
//
// It is deliberately a MEAN shift only — no gain, no gamma, no per-pixel
// transfer. A mean shift cannot invent or destroy detail; it slides the patch's
// exposure onto the base's and nothing else.

/** How much of the PATCH's own tone survives. The rest comes from the base. */
export const TONE_PATCH_WEIGHT = 0.35;
/** ...so this much is pulled from the base region under the patch. */
export const TONE_BASE_WEIGHT = 1 - TONE_PATCH_WEIGHT;

/**
 * How often the base region under the mouth is re-measured, in ms.
 *
 * 400ms, and it was 100ms. Each re-measure is a getImageData readback, which
 * stalls the GPU pipeline — at 100ms that was a hitch roughly ten times a second.
 * The base tone drifts far slower than that (the mouth anchor travels 8px in x and
 * 5px in y across the whole shipped 11.08s loop — BASE_DRIFT_X 0..+8, BASE_DRIFT_Y
 * -2..+3 — and the region is her mouth at rest. This cited "head travels 10x18px",
 * which was measured on the take base_loop.mp4 REPLACED on 2026-09-22), so nothing is given up by
 * measuring it less often. The ONE moment it changes instantly is a base/speak
 * footage swap, and StarraClipFace forces a re-measure there explicitly rather
 * than waiting out this interval.
 */
export const TONE_RESAMPLE_MS = 400;

/**
 * Mean of each of R,G,B over an RGBA byte buffer. FULLY TRANSPARENT pixels are
 * skipped, because their colour is undefined and would drag the mean.
 *
 * Returns null — not zeros — for a buffer that is empty, not RGBA-aligned, or
 * entirely transparent. Zeros would be a claim ("this region is black") and the
 * caller must be able to tell "no measurement" from "measured black".
 * Takes ArrayLike so a plain array in a test and a real ImageData both work.
 */
export function channelMeans(
  rgba: ArrayLike<number> | null | undefined,
): [number, number, number] | null {
  if (!rgba) return null;
  const n = rgba.length;
  if (n < 4 || n % 4 !== 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i < n; i += 4) {
    if (rgba[i + 3] === 0) continue;
    r += rgba[i];
    g += rgba[i + 1];
    b += rgba[i + 2];
    count++;
  }
  if (count === 0) return null;
  return [r / count, g / count, b / count];
}

/**
 * The per-channel ADDITIVE offset that slides a patch's mean toward the base's.
 *
 * The build arithmetic is target = patch*TONE_PATCH_WEIGHT + base*TONE_BASE_WEIGHT,
 * so the offset is TONE_BASE_WEIGHT * (base - patch).
 *
 * IDENTITY when the means already agree — that is the property the renderer
 * relies on: matching footage costs nothing and is never "corrected" into a
 * change. Non-finite input yields a zero offset (no shift) rather than NaN.
 */
export function toneMatchOffsets(
  patchMeans: readonly number[] | null | undefined,
  baseMeans: readonly number[] | null | undefined,
  patchWeight: number = TONE_PATCH_WEIGHT,
): [number, number, number] {
  const none: [number, number, number] = [0, 0, 0];
  if (!patchMeans || !baseMeans) return none;
  if (patchMeans.length < 3 || baseMeans.length < 3) return none;
  const w = Number.isFinite(patchWeight) && patchWeight >= 0 && patchWeight <= 1
    ? patchWeight
    : TONE_PATCH_WEIGHT;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const p = patchMeans[c];
    const b = baseMeans[c];
    if (!Number.isFinite(p) || !Number.isFinite(b)) return none;
    out[c] = (1 - w) * (b - p);
  }
  return out;
}

/**
 * Add per-channel offsets to an RGBA buffer IN PLACE, clamped to 0..255.
 * ALPHA IS NEVER TOUCHED — the feathered mask owns alpha.
 *
 * Clamps explicitly rather than relying on Uint8ClampedArray, so the same
 * function is correct on the plain arrays the tests use.
 */
export function applyToneOffsets(
  rgba: { length: number; [index: number]: number } | null | undefined,
  offsets: readonly number[] | null | undefined,
): void {
  if (!rgba || !offsets || offsets.length < 3) return;
  const dr = Number.isFinite(offsets[0]) ? offsets[0] : 0;
  const dg = Number.isFinite(offsets[1]) ? offsets[1] : 0;
  const db = Number.isFinite(offsets[2]) ? offsets[2] : 0;
  if (dr === 0 && dg === 0 && db === 0) return; // identity: leave the bytes alone
  const n = rgba.length - (rgba.length % 4);
  for (let i = 0; i < n; i += 4) {
    let r = rgba[i] + dr;
    let g = rgba[i + 1] + dg;
    let b = rgba[i + 2] + db;
    if (r < 0) r = 0;
    else if (r > 255) r = 255;
    if (g < 0) g = 0;
    else if (g > 255) g = 255;
    if (b < 0) b = 0;
    else if (b > 255) b = 255;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
  }
}

// ── browser helpers (the only DOM-touching code here) ───────────────────────

export interface MouthSyncAssets {
  bank: VisemeBank;
  /**
   * The 2-D bank, when bank2.json was present, parsed AND had its images decode.
   * Null means the 1-D path is live — a missing or malformed bank2.json is a
   * silent downgrade, never a broken face.
   */
  bank2: VisemeBank2 | null;
  track: ParsedAnchorTrack;
  images: Map<string, HTMLImageElement>;
}

let assetsPromise: Promise<MouthSyncAssets | null> | null = null;

/** Decode every patch PNG for a bank. Ids that fail to load are simply absent. */
async function decodePatches(
  frames: { id: string; file: string }[],
): Promise<Map<string, HTMLImageElement>> {
  const entries = await Promise.all(
    frames.map(
      (f) =>
        new Promise<[string, HTMLImageElement] | null>((resolve) => {
          const img = new Image();
          img.onload = () => resolve([f.id, img]);
          img.onerror = () => resolve(null);
          img.src = f.file;
        }),
    ),
  );
  const images = new Map<string, HTMLImageElement>();
  for (const e of entries) if (e) images.set(e[0], e[1]);
  return images;
}

/**
 * Fetch + decode the bank(s), anchor.json and every patch PNG, ONCE per page.
 *
 * FALLBACK CHAIN, in order, because a bad asset must never cost her her face or
 * her voice:
 *   1. bank2.json present, valid, its geometry matches the 1-D bank, and at least
 *      one PNG decodes  -> the 2-D path.
 *   2. anything above fails                                  -> the 1-D bank.
 *   3. the 1-D bank or the anchor track fails                -> null, and the
 *      caller renders exactly today's plain clip playback.
 * Any failure at all resolves to null or a downgrade. Never throws, never retries
 * in a loop. bank2.json is fetched with its own try/catch so a 404 (the normal
 * state before the 2-D builder is run) costs nothing.
 */
export function loadMouthSyncAssets(): Promise<MouthSyncAssets | null> {
  if (assetsPromise) return assetsPromise;
  assetsPromise = (async (): Promise<MouthSyncAssets | null> => {
    try {
      if (typeof fetch !== "function" || typeof Image === "undefined") return null;
      const [bankRes, trackRes] = await Promise.all([fetch(BANK_URL), fetch(ANCHOR_URL)]);
      if (!bankRes.ok || !trackRes.ok) return null;
      const bank = parseVisemeBank(await bankRes.json());
      const track = parseAnchorTrack(await trackRes.json());
      if (!bank || !track) return null;

      // ── try the 2-D bank first; ANY problem is a silent downgrade to 1-D
      let bank2: VisemeBank2 | null = null;
      let images: Map<string, HTMLImageElement> | null = null;
      try {
        const r2 = await fetch(BANK2_URL);
        if (r2.ok) {
          const parsed = parseVisemeBank2(await r2.json());
          // The patch is drawn into a canvas sized from the bank and composited
          // onto the anchor box, so a 2-D bank cut at a different size or from a
          // different clip would land wrong. Refuse it rather than misalign her.
          if (
            parsed &&
            parsed.width === bank.width &&
            parsed.height === bank.height &&
            parsed.source === bank.source
          ) {
            const imgs = await decodePatches(parsed.frames);
            // Require the CLOSED frame specifically: it is the one the lookup
            // forces, so a bank whose closure did not decode is not usable as 2-D.
            const closedOk =
              parsed.closedId === null || imgs.has(parsed.closedId);
            if (imgs.size > 0 && closedOk) {
              bank2 = parsed;
              images = imgs;
            }
          }
        }
      } catch {
        bank2 = null;
        images = null;
      }

      if (!images) images = await decodePatches(bank.frames);
      if (images.size === 0) return null;
      return { bank, bank2, track, images };
    } catch {
      return null;
    }
  })();
  return assetsPromise;
}

/**
 * THE PATCH ASSETS, as one discriminated union so the renderer cannot confuse the
 * two geometries. v4 is placed by its own absolute baseBox on base_loop; legacy
 * is placed by anchor.json on talking.mp4. Mixing them would paste her mouth
 * hundreds of pixels off.
 */
export type MouthPatchAssets =
  | {
      kind: "v4";
      bank4: VisemeBank4;
      images: Map<string, HTMLImageElement>;
      /** The shared canvas size — the largest baseBox in the bank. */
      canvasW: number;
      canvasH: number;
    }
  | { kind: "legacy"; legacy: MouthSyncAssets };

let patchAssetsPromise: Promise<MouthPatchAssets | null> | null = null;

/**
 * Load the best mouth assets available, ONCE per page.
 *
 * THE CHAIN, best first. Every rung down is a SILENT degradation, never an error:
 *   1. visemes3/bank.json parses as v4, names a base, and its patches decode
 *      (the closure specifically) -> the v4 path on the continuous body.
 *   2. anything above fails -> loadMouthSyncAssets(), i.e. the v2 2-D bank on
 *      talking.mp4, and inside that its own fall through to the 1-D bank.
 *   3. that fails too -> null, and the face renders exactly today's plain clip
 *      playback with no patch at all.
 *
 * NOTE ON AUTH — do NOT "fix" this with credentials:"omit". A security fix this
 * session removed `.json` from the middleware matcher exclusions, so
 * /avatar/visemes3/bank.json 307s to /login when unauthenticated. Same-origin
 * fetch sends cookies by default, so an authenticated deck gets 200; the PNGs are
 * ungated. Omitting credentials would BREAK this, not fix it.
 *
 * Never throws. Never retries in a loop.
 */
export function loadMouthPatchAssets(): Promise<MouthPatchAssets | null> {
  if (patchAssetsPromise) return patchAssetsPromise;
  const flight = (async (): Promise<MouthPatchAssets | null> => {
    try {
      if (typeof fetch !== "function" || typeof Image === "undefined") return null;
      try {
        const res = await fetch(BANK3_URL);
        if (res.ok) {
          const bank4 = parseVisemeBank4(await res.json());
          // A bank that names no base cannot be verified against the clip on
          // screen, so it is refused here rather than pasted somewhere wrong.
          if (bank4 && bank4.base.length > 0) {
            const extent = bankPatchExtent(bank4.frames);
            if (extent) {
              const images = await decodePatches(bank4.frames);
              // The CLOSURE must decode: it is the frame the lookup FORCES on
              // every bilabial, so a bank without it is not usable as v4.
              const closedOk = bank4.closedId === null || images.has(bank4.closedId);
              if (images.size > 0 && closedOk) {
                return { kind: "v4", bank4, images, canvasW: extent.w, canvasH: extent.h };
              }
            }
          }
        }
      } catch {
        /* v4 unavailable — fall through to the legacy chain below */
      }
      const legacy = await loadMouthSyncAssets();
      return legacy ? { kind: "legacy", legacy } : null;
    } catch {
      return null;
    }
  })();
  patchAssetsPromise = flight;
  // A NULL IS NOT MEMOIZED. One transient failure at call open (deck mid-
  // restart, an expired session's login HTML where bank.json should be, a
  // network blip) used to disable the composited mouth for every later call
  // on the page. A success stays cached for the page; a failure retries next
  // time someone asks.
  void flight.then((r) => {
    if (r === null && patchAssetsPromise === flight) patchAssetsPromise = null;
  });
  return flight;
}

/**
 * Where an `object-fit: contain` video actually lands inside its box.
 * The anchor track is in NATIVE video pixels, so the patch has to be mapped
 * through the same letterbox the browser applied, or it lands in the wrong place.
 */
export function containRect(
  natW: number,
  natH: number,
  boxW: number,
  boxH: number,
): { left: number; top: number; scale: number } | null {
  if (!(natW > 0 && natH > 0 && boxW > 0 && boxH > 0)) return null;
  const scale = Math.min(boxW / natW, boxH / natH);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return {
    left: (boxW - natW * scale) / 2,
    top: (boxH - natH * scale) / 2,
    scale,
  };
}

// ── FLUIDITY (2026-09-30) ───────────────────────────────────────────────────
// Four pure pieces for the "fully fluid like a real person" pass. Every one is
// total and DOM-free so it is unit-testable on the table, and every one degrades
// to today's behaviour when its inputs are missing or malformed.

/**
 * Weighted distance between two bank cells, in the SAME units
 * `pickVisemeFrame2`'s nearest scan uses (OPENNESS_AXIS_WEIGHT /
 * ROUNDNESS_AXIS_WEIGHT). Returns the real (non-squared) distance, because the
 * blend length below is a LINEAR ramp over it, not a ranking.
 *
 * MEASURED on the shipped visemes3 bank (and the threshold below was corrected
 * by that measurement, not chosen): the openness ROWS sit at 0, 0.0263, 0.2368,
 * 0.2632, 0.5, 0.5263, 0.7105..0.7632, 0.9474, 1.0, so the WIDEST single-row step
 * is 0 -> 0.2632 = 0.790 in these units; one roundness COLUMN step is ~0.21 in
 * roundness, i.e. ~0.21 here. A two-row openness jump (0 -> 0.5) is 1.5.
 *
 * TOTAL: a non-finite coordinate is read the way pickVisemeFrame2 reads it —
 * openness 0, roundness NEUTRAL 0.5 — so a bad cell can never produce NaN here.
 */
export function cellDistance(
  a: { openness: number; roundness: number } | null | undefined,
  b: { openness: number; roundness: number } | null | undefined,
): number {
  if (!a || !b) return Infinity;
  const ao = Number.isFinite(a.openness) ? clamp01(a.openness) : 0;
  const bo = Number.isFinite(b.openness) ? clamp01(b.openness) : 0;
  const ar = Number.isFinite(a.roundness) ? clamp01(a.roundness) : 0.5;
  const br = Number.isFinite(b.roundness) ? clamp01(b.roundness) : 0.5;
  const dO = (ao - bo) * OPENNESS_AXIS_WEIGHT;
  const dR = (ar - br) * ROUNDNESS_AXIS_WEIGHT;
  return Math.sqrt(dO * dO + dR * dR);
}

/**
 * THE GHOSTED MOUTH — how long one shape dissolves into the next.
 *
 * WHAT WAS WRONG. The v4 draw crossfaded the outgoing PNG into the incoming one
 * over a FIXED 80ms — StarraClipFace's `MOUTH_BLEND_MS`, which this change
 * DELETED, so do not go looking for it. A dissolve between two
 * photographs of a mouth is not motion — it is two mouths on one face — and the
 * only part of it the eye forgives is the part too short to resolve. At 80ms,
 * 40ms of every single shape change sits in the visibly-ghosted 0.25..0.75 alpha
 * band, and ~30% of speaking frames were measured inside it.
 *
 * SO THE LENGTH FOLLOWS THE JUMP. Adjacent cells differ by a few pixels of
 * aperture, so they need almost nothing (MIN) — a snap there reads as motion, not
 * as a cut. A multi-row jump is a genuinely different mouth, so it gets the
 * longer (still short) MAX rather than a hard pop. Linear in between.
 *
 * THE CEILING IS THE POINT: MAX is 30ms, so the worst case leaves 15ms in the
 * ghosted band — under one 60fps frame — against 40ms before.
 *
 * TOTAL: a non-finite distance takes MAX (the safe, softer end); a min above max
 * is swapped rather than trusted.
 */
export const MOUTH_BLEND_MIN_MS = 16;
export const MOUTH_BLEND_MAX_MS = 30;
/** At or below this cell distance the two shapes are ADJACENT (see cellDistance):
 *  0.8 holds the bank's widest single openness-row step (0.790, measured). */
export const MOUTH_BLEND_ADJACENT_DIST = 0.8;
/** At or above this the pick JUMPED (two openness rows or more). */
export const MOUTH_BLEND_FAR_DIST = 1.5;

export function mouthBlendMs(
  dist: number,
  minMs: number = MOUTH_BLEND_MIN_MS,
  maxMs: number = MOUTH_BLEND_MAX_MS,
  adjacent: number = MOUTH_BLEND_ADJACENT_DIST,
  far: number = MOUTH_BLEND_FAR_DIST,
): number {
  const lo = Number.isFinite(minMs) && minMs >= 0 ? minMs : MOUTH_BLEND_MIN_MS;
  const hi = Number.isFinite(maxMs) && maxMs >= 0 ? maxMs : MOUTH_BLEND_MAX_MS;
  const min = lo <= hi ? lo : hi;
  const max = lo <= hi ? hi : lo;
  if (!Number.isFinite(dist)) return max;
  const a = Number.isFinite(adjacent) ? adjacent : MOUTH_BLEND_ADJACENT_DIST;
  const f = Number.isFinite(far) && far > a ? far : a + 1;
  if (dist <= a) return min;
  if (dist >= f) return max;
  return min + ((dist - a) / (f - a)) * (max - min);
}

/**
 * THE FROZEN MOUTH AFTER EVERY TURN — the release, made monotonic.
 *
 * WHAT CLASSIC SEES TODAY, traced on the source rather than guessed. Her voice
 * stops; `createMouthSmoother` decays openness with RELEASE_MS = 110ms; below
 * CLOSURE_OPENNESS the pick locks to the bilabial `m_closed`, so a STILL
 * photograph of a shut mouth is pasted over a speaking body that is still moving
 * its jaw. The only thing that ever cleared it was `createStallGate`, which
 * starts counting its 700ms only once openness has decayed past 1e-3 — a further
 * ~680ms from a normal 0.4 — so the frozen frame lived ~1.4s. And the body
 * crossfade back to the listening loop lands in the middle of that (700ms hold +
 * 320ms fade), blanking the patch and then bringing it BACK: the "flickers off
 * then on before clearing" Classic reported.
 *
 * THIS GATE RELEASES ON THE REST CROSSING INSTEAD, AND LATCHES.
 *   - released once openness has been at/below MOUTH_REST_OPENNESS continuously
 *     for MOUTH_RELEASE_HOLD_MS;
 *   - it STAYS released until openness climbs back over MOUTH_REARM_OPENNESS,
 *     so nothing downstream (a body crossfade, a republished layer, the stall
 *     gate) can flicker the patch back on;
 *   - the hold equals the shipped OPENNESS_STALL_MS (700ms) minus the ~200ms the
 *     smoother takes to fall from a normal speaking level to the rest threshold,
 *     so it tolerates EXACTLY the same real silence the stall gate was tuned for
 *     (the 250-600ms inter-phrase pauses named at OPENNESS_STALL_MS) while
 *     clearing at ~710ms after her last sound instead of ~1.4s.
 *
 * WHAT THIS GATE DOES NOT DECIDE — and the first version of the consumer got this
 * wrong. It answers "is her mouth at rest and latched", nothing more. It does NOT
 * decide WHICH BODY may act on that. StarraClipFace applies it only while
 * base_loop is the layer on screen, because the release fires 320-440ms BEFORE the
 * body leaves body_speak (SPEAKING_BODY_HOLD_MS 700ms, then a CROSSFADE_MS 320ms
 * blend), and hiding the patch over body_speak shows her own filmed mouth talking
 * in silence — a lying mouth instead of a frozen one. So the honest claim is: the
 * frozen shut-mouth photo clears EARLIER ON THE LISTENING BODY, and across the
 * overlap it is still held, exactly as it was before this gate.
 *
 * HOW MUCH EARLIER, stated as the range it actually is rather than one number: a
 * ~550-670ms improvement, not a flat 667ms. The patch clears when the body STARTS
 * fading back (~700-820ms after her last sound, because the body switch is polled
 * every SPEAKING_BODY_POLL_MS) instead of ~1367ms. The full trace, including why
 * PATCH_FADE_MIN_OPACITY absorbs most of the 320-440ms overlap, is at the point of
 * use in StarraClipFace (the `released && bodyKind === "base"` guard). DERIVED FROM
 * SOURCE, not observed on a live turn.
 *
 * TOTAL: non-finite openness counts as SILENT (the safe direction — release),
 * non-finite dt advances nothing, and dt is clamped exactly as the stall gate
 * clamps it so one long frame cannot jump the hold.
 */
export const MOUTH_REST_OPENNESS = 0.06;
export const MOUTH_REARM_OPENNESS = 0.12;
export const MOUTH_RELEASE_HOLD_MS = 500;

export interface ReleaseGate {
  /** Advance by `dtMs`; true means RELEASED — hide the patch and keep it hidden. */
  step(openness: number, dtMs: number): boolean;
  reset(): void;
}

export function createReleaseGate(
  holdMs: number = MOUTH_RELEASE_HOLD_MS,
  rest: number = MOUTH_REST_OPENNESS,
  rearm: number = MOUTH_REARM_OPENNESS,
): ReleaseGate {
  const hold = Number.isFinite(holdMs) && holdMs > 0 ? holdMs : MOUTH_RELEASE_HOLD_MS;
  const restAt = Number.isFinite(rest) && rest > 0 ? rest : MOUTH_REST_OPENNESS;
  const rearmAt =
    Number.isFinite(rearm) && rearm > restAt ? rearm : restAt * 2;
  let restFor = 0;
  let released = false;
  return {
    step(openness: number, dtMs: number): boolean {
      const o = Number.isFinite(openness) ? openness : 0;
      if (released) {
        // ONE WAY BACK: real sound, clear of the rest band. Anything less leaves
        // her mouth released, which is what makes the release monotonic.
        if (o > rearmAt) {
          released = false;
          restFor = 0;
        }
        return released;
      }
      if (o > restAt) {
        restFor = 0;
        return false;
      }
      const dt = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, 250) : 0;
      restFor += dt;
      if (restFor >= hold) released = true;
      return released;
    },
    reset(): void {
      restFor = 0;
      released = false;
    },
  };
}

/**
 * THE BODY ANSWERS HER VOICE — a continuous response where there was one bit.
 *
 * The body layer reacted to a single boolean (speaking / not), so between the two
 * clip switches nothing about her moved with what she was SAYING. This maps the
 * mouth engine's own smoothed envelope onto a subtle rigid transform:
 *   - `scale` follows the FAST envelope: she settles a little taller and forward
 *     as she speaks. Up only, never below 1 — scaling DOWN would pull her edges
 *     in and expose the letterbox behind her.
 *   - `ty` follows the fast envelope upward (negative = up), the way a head lifts
 *     slightly into an emphasised phrase.
 *   - `rotate` follows fast MINUS slow, i.e. EMPHASIS: a syllable louder than her
 *     running average leans her a fraction of a degree, and steady speech leans
 *     her not at all. That is why it needs two time constants and not one.
 *
 * IT RIDES THE EXISTING ANALYSER. The caller feeds it the envelope the mouth loop
 * already computed from the one analyser on the bus — no second tap, no second
 * rAF, and no extra work per frame beyond two one-poles.
 *
 * Amplitudes are DELIBERATELY under the existing CSS presence layer's
 * (deck.css `starra-handheld` translate is 0.38-0.5% of the stage and
 * `starra-breathe` scale is 1.0072): this is the SUBJECT moving, and it must stay
 * quieter than the camera. One constant scales all three (see BODY_MOTION_GAIN in
 * StarraClipFace).
 *
 * TOTAL: non-finite inputs are 0 and a non-finite gain is 0, so the worst case is
 * the identity transform — exactly today's still body.
 */
export const BODY_MOTION_TAU_FAST_MS = 140;
export const BODY_MOTION_TAU_SLOW_MS = 900;
/** Full-scale amplitudes at gain 1 and energy 1. */
export const BODY_MOTION_SCALE = 0.005;
export const BODY_MOTION_RISE_PX = 2;
export const BODY_MOTION_ROLL_DEG = 0.12;

export function bodyMotionFromEnergy(
  fast: number,
  slow: number,
  gain: number,
): { scale: number; tx: number; ty: number; rotate: number } {
  const g = Number.isFinite(gain) && gain > 0 ? gain : 0;
  const f = Number.isFinite(fast) ? clamp01(fast) : 0;
  const s = Number.isFinite(slow) ? clamp01(slow) : 0;
  // Emphasis is signed and small; clamp it so one loud burst cannot roll her far.
  let emph = f - s;
  if (emph > 0.5) emph = 0.5;
  if (emph < -0.5) emph = -0.5;
  // `-0` is not the identity (Object.is(-0, 0) is false, and it prints as
  // "-0.000px"), so both signed products are normalised.
  const ty = -BODY_MOTION_RISE_PX * g * f;
  const rotate = BODY_MOTION_ROLL_DEG * g * emph * 2;
  return {
    scale: 1 + BODY_MOTION_SCALE * g * f,
    tx: 0,
    ty: ty === 0 ? 0 : ty,
    rotate: rotate === 0 ? 0 : rotate,
  };
}
