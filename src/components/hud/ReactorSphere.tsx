"use client";

/**
 * THE REACTOR CORE — a sphere that moves because she is speaking.
 *
 * Classic asked for "a talking purple sphere that moves when she speaks" in the
 * middle of the deck, where a decorative ring used to just spin. The rings are
 * untouched: Book 1's long rotation loops (deck.css:390/394/398) stay
 * exactly as they are, per the design doctrine's "preserve Book 1's long loops".
 * This adds the one thing that was missing — a core that is actually HER.
 *
 * Motion verb: BREATHE (doctrine: reactor = breathe / pulse / rotate). It has a
 * genuine resting state — silence draws a still, clean circle, not a nervous
 * idle wobble — so the deck feels alive without feeling busy.
 *
 * READ-ONLY on the audio path. See useAudioBands.ts: this consumes the analyser
 * bus that her TTS and the live call both already publish to. It never touches
 * the audio graph, because a prettier reactor is not worth risking the call.
 */

import { useEffect, useRef } from "react";
import { useAudioBands } from "@/lib/voice/useAudioBands";
import { sphereRadiusAt, sphereScaleAt } from "./sphere-geometry";
import styles from "./ReactorSphere.module.css";

/** Points around the circumference. Enough to look smooth, cheap to draw. */
const SEGMENTS = 160;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function ReactorSphere() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { bands, read } = useAudioBands();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    // No 2D context is a real failure, but the honest response is a dark centre
    // and a working deck — not a crash on the one screen he uses all day. It is
    // not silent: the reactor visibly does not light up.
    if (!ctx) return;

    const still = prefersReducedMotion();
    let raf = 0;
    let disposed = false;
    /* Gradient memo — invalidated by size, never by a frame. */
    let fillCache: CanvasGradient | null = null;
    let fillCacheKey = "";
    /* Behind an opaque call panel this sphere is invisible; stop scheduling. */
    const behindCall = () => document.body.classList.contains("in-call");
    /* REST SHORT-CIRCUIT state — true once the silent circle has been painted.
       See the block in `draw`. Reset by anything that clears or re-exposes the
       canvas, so the sphere can never be left blank. */
    let restPainted = false;
    const start = performance.now();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap: Intel iGPU
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      /* LOAD-BEARING. Setting width/height WIPES the canvas, and in the
         non-reduced-motion path nothing calls draw() after a resize — the
         running loop is what repaints. Without this reset the rest
         short-circuit would keep skipping and leave the reactor BLANK after a
         window resize until she next spoke. */
      restPainted = false;
    };
    resize();

    const draw = (now: number) => {
      if (disposed) return;
      const t = (now - start) / 1000;

      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const unit = Math.min(w, h) * 0.29; // half-size the geometry is scaled to

      // READ FIRST, EVERY FRAME, NO EXCEPTIONS. The short-circuit below skips
      // DRAWING; it never skips reading. Her first syllable has to land on the
      // very frame it arrives or the sphere lags her voice.
      if (!still) read();

      // ── REST SHORT-CIRCUIT ──────────────────────────────────────────────
      // While she is silent this function was rebuilding and refilling a 160-
      // segment path that is pixel-for-pixel IDENTICAL frame after frame, 60
      // times a second, forever. sphere-geometry.ts is the proof, not a guess:
      //   - sphereRadiusAt() returns BASE for every theta and every `time` the
      //     moment amp is 0 (sphere-geometry.ts:63 `if (amp === 0) return BASE`),
      //     and amp is clamp01(bands[0]) * MAX_AMPLITUDE, so bands[0] alone
      //     decides it. bands[2] is read only inside that branch.
      //   - sphereScaleAt() is 1 + 0.18 * clamp01(bands[1]) — bands[1] alone.
      // So bands[0] and bands[1] fully determine the frame, and when both are
      // at zero the frame cannot differ. `!(x > 0)` rather than `x === 0`
      // deliberately: clamp01 maps negative and NaN to 0 too, so those are
      // genuinely rest, and this matches the geometry instead of guessing.
      //
      // HOW THE WAKE IS GUARANTEED: the instant either band goes above 0,
      // `atRest` is false, the skip branch is not taken, and this frame draws —
      // there is no timer, no threshold and no hysteresis to get stuck in. The
      // rAF loop keeps running the whole time (below), read() keeps running
      // (above), and `restPainted` is additionally cleared by resize(), by
      // visibilitychange and by the body-class observer, so every path that
      // could have blanked or re-exposed the canvas forces one repaint.
      const atRest = !still && !(bands[0] > 0) && !(bands[1] > 0);
      if (atRest && restPainted) {
        // Same scheduling gate as the tail of this function, deliberately
        // duplicated verbatim so the two can be read side by side.
        if (!still && !document.hidden && !behindCall()) raf = requestAnimationFrame(draw);
        return;
      }
      restPainted = atRest;

      ctx.clearRect(0, 0, w, h);

      const scale = still ? 1 : sphereScaleAt(bands);

      // ── the body ────────────────────────────────────────────────────────
      ctx.beginPath();
      for (let i = 0; i <= SEGMENTS; i++) {
        const theta = (i / SEGMENTS) * Math.PI * 2;
        const r = (still ? 1 : sphereRadiusAt(theta, t, bands)) * unit * scale;
        const x = cx + Math.cos(theta) * r;
        const y = cy + Math.sin(theta) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();

      // Her palette, straight from the tokens — magenta core bleeding out
      // through purple to nothing, so it reads as the SAME reactor, brighter.
      // BUILT ONCE PER SIZE, not once per frame. cx, cy and unit all derive
      // from the canvas dimensions (unit is Math.min(w,h) * 0.29), so the
      // gradient only changes on resize — the sphere BREATHES by changing its
      // path, not its fill. Rebuilding four colour stops 60x a second was pure
      // allocation churn behind a call panel nobody can see through.
      const fillKey = `${cx}|${cy}|${unit}`;
      if (fillCache === null || fillCacheKey !== fillKey) {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, unit * 1.55);
        g.addColorStop(0, "rgba(249, 214, 255, 0.95)");
        g.addColorStop(0.18, "rgba(217, 70, 239, 0.78)");
        g.addColorStop(0.55, "rgba(168, 85, 247, 0.34)");
        g.addColorStop(1, "rgba(168, 85, 247, 0)");
        fillCache = g;
        fillCacheKey = fillKey;
      }
      ctx.fillStyle = fillCache;
      ctx.fill();

      // ── the rim ─────────────────────────────────────────────────────────
      ctx.strokeStyle = "rgba(233, 213, 255, 0.55)";
      ctx.lineWidth = Math.max(1, unit * 0.012);
      ctx.stroke();

      if (!still && !document.hidden && !behindCall()) raf = requestAnimationFrame(draw);
    };

    // Under reduced motion this paints ONCE and never schedules a frame — the
    // loop is not merely hidden, it never runs.
    raf = requestAnimationFrame(draw);

    // A hidden tab has nobody to draw for. Browsers throttle rAF in a fully
    // backgrounded tab, but NOT in a visible-but-unfocused window and not
    // reliably inside the WKWebView dock app — so stop scheduling rather than
    // trusting the host to do it. Resuming repaints immediately.
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
      } else if (!still && !disposed) {
        restPainted = false; // repaint once on resume, never trust a stale canvas
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    // THE REACTOR MUST COME BACK. Mirrors LiveSky: body class changes re-sync
    // the loop, so COLLAPSING the call and hanging it up both restart it with no
    // other plumbing — `body.in-call` is removed on either (VoiceCallOverlay's
    // in-call effect keys it on `open && !collapsed`).
    const onBodyClass = () => {
      if (behindCall() || still || disposed) return;
      if (document.hidden) return;
      restPainted = false; // collapse/hang-up must repaint, not resume a skip
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };
    const mo = new MutationObserver(onBodyClass);
    mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });

    const ro = new ResizeObserver(() => {
      resize();
      if (still) requestAnimationFrame(draw); // repaint the static core
    });
    ro.observe(canvas);

    return () => {
      disposed = true;
      mo.disconnect();
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
    };
  }, [bands, read]);

  return (
    <div className={styles.wrap} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  );
}
