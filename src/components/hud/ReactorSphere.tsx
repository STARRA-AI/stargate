"use client";

/**
 * THE REACTOR CORE — a sphere that moves because she is speaking.
 *
 * Classic asked for "a talking purple sphere that moves when she speaks" in the
 * middle of the deck, where a decorative ring used to just spin. The rings are
 * untouched: Book 1's long rotation loops (deck.css:321/356/360/364) stay
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
    const start = performance.now();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap: Intel iGPU
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
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

      ctx.clearRect(0, 0, w, h);

      if (!still) read();
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
      const fill = ctx.createRadialGradient(cx, cy, 0, cx, cy, unit * 1.55);
      fill.addColorStop(0, "rgba(249, 214, 255, 0.95)");
      fill.addColorStop(0.18, "rgba(217, 70, 239, 0.78)");
      fill.addColorStop(0.55, "rgba(168, 85, 247, 0.34)");
      fill.addColorStop(1, "rgba(168, 85, 247, 0)");
      ctx.fillStyle = fill;
      ctx.fill();

      // ── the rim ─────────────────────────────────────────────────────────
      ctx.strokeStyle = "rgba(233, 213, 255, 0.55)";
      ctx.lineWidth = Math.max(1, unit * 0.012);
      ctx.stroke();

      if (!still) raf = requestAnimationFrame(draw);
    };

    // Under reduced motion this paints ONCE and never schedules a frame — the
    // loop is not merely hidden, it never runs.
    raf = requestAnimationFrame(draw);

    const ro = new ResizeObserver(() => {
      resize();
      if (still) requestAnimationFrame(draw); // repaint the static core
    });
    ro.observe(canvas);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [bands, read]);

  return (
    <div className={styles.wrap} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  );
}
