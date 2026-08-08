/**
 * THE SHAPE OF HER VOICE — the one pure function behind the reactor.
 *
 * Ported from the reference WebGL implementation
 * (vendor/jarvis-realtime-agentic/sphere-shader.ts:27-33, Apache-2.0), collapsed
 * from a 3D vertex displacement to the 2D polar form the deck actually needs:
 *
 *     pos + amp * dir * (0.5 + 0.5 * sin(freq * pos + time))
 *
 * WHY 2D CANVAS AND NOT THREE.JS. The reference ships a WebGL scene with an
 * UnrealBloom composer. This deck runs in a WKWebView on an Intel Mac and
 * ALREADY paints an animated starfield behind the reactor (LiveSky.tsx). Adding
 * a second WebGL context with post-processing on top of that buys a prettier
 * sphere and costs frame rate on the one screen Classic looks at all day. Polar
 * canvas gives the same motion language for a fraction of the budget, and keeps
 * the galaxy visible THROUGH the sphere instead of occluding it. If literal
 * parity with the reference is ever wanted, this function is the seam to swap.
 */

/** Resting radius, in units of the container's half-size. */
const BASE = 1;

/** Hard bounds. The sphere may breathe; it may never escape its ring. */
const MIN_R = 0.45;
const MAX_R = 1.55;

/** How far the loudest sound may push the surface. Tuned to stay inside MAX_R. */
const MAX_AMPLITUDE = 0.34;

/** Lobe count at full brightness — how many ripples travel the circumference. */
const MAX_LOBES = 7;

/** Radians/sec the ripple pattern travels. Slow enough to read as breathing. */
const TRAVEL = 1.6;

/** Coerce anything the audio path might hand us into a usable 0..1. */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Radius of the sphere's surface at angle `theta`, at `time` seconds, for the
 * current audio `bands`.
 *
 * - `bands[0]` (amplitude) — how far the surface moves. At 0 this returns a
 *   perfect circle, which is what makes idle look calm instead of nervous.
 * - `bands[2]` (frequency) — how many ripples travel around it, so her voice
 *   changes the CHARACTER of the motion, not just its size.
 *
 * `time` only enters multiplied by amplitude, so a silent sphere does not drift
 * with the clock — idle is genuinely still, not slowly crawling.
 */
export function sphereRadiusAt(
  theta: number,
  time: number,
  bands: Float32Array,
): number {
  const amp = clamp01(bands[0] ?? 0) * MAX_AMPLITUDE;
  if (amp === 0) return BASE; // silence: a clean circle, no clock drift

  // Integer lobe count keeps the wave continuous across the theta = 0 / 2pi
  // seam. A fractional count leaves a visible crack down the sphere.
  const lobes = 1 + Math.round(clamp01(bands[2] ?? 0) * (MAX_LOBES - 1));

  const wave = 0.5 + 0.5 * Math.sin(lobes * theta + time * TRAVEL);
  const r = BASE + amp * wave;

  if (!Number.isFinite(r)) return BASE;
  return r < MIN_R ? MIN_R : r > MAX_R ? MAX_R : r;
}

/** Overall scale pulse, from band 1 — the reference's `1 + 0.2 * data[1]/255`. */
export function sphereScaleAt(bands: Float32Array): number {
  return 1 + 0.18 * clamp01(bands[1] ?? 0);
}
