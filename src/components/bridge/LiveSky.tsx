"use client";

/**
 * LIVE SKY (2026-07-30) — the deck center was dominated by the STATIC
 * hud_panel.webp artwork; the CSS-gradient star layers behind it were
 * imperceptible. This is the fix every popular starfield implementation
 * uses (react-starfield-animation, warpspeed, the Grok-style canvas):
 * PER-FRAME canvas drawing. ~120 stars in three parallax depths, each with
 * its own twinkle phase/period, the whole field drifting slowly toward
 * ~200deg and wrapping at the edges, plus a rare shooting star.
 *
 * Discipline: zero deps; ONE rAF loop; time-based motion (delta-t, so a
 * dropped frame never jumps); all mutable state lives in the once-run
 * effect's closure — zero React re-renders per frame. The loop fully STOPS
 * (cancelAnimationFrame, not a skip) under document.hidden, body.low-power,
 * or prefers-reduced-motion, and resumes when they clear (visibilitychange
 * + matchMedia change + MutationObserver on body class). A bad frame
 * disables the sky instead of breaking the deck — additive degradation.
 */

import { useEffect, useRef } from "react";

const STAR_COUNT = 120;
const DRIFT_RAD = (200 * Math.PI) / 180; /* field drift heading ~200deg */
/* parallax depths: population share, drift px/s, star size px, base alpha */
const LAYERS = [
  { share: 0.45, speed: 2.0, minSize: 0.6, maxSize: 1.0, alpha: 0.55 }, /* deep */
  { share: 0.35, speed: 3.2, minSize: 0.9, maxSize: 1.4, alpha: 0.75 }, /* mid */
  { share: 0.2, speed: 5.0, minSize: 1.2, maxSize: 1.8, alpha: 1.0 }, /* near */
] as const;
/* purple-white star palette — #e9d5ff / --star / --purple (globals.css) */
const PALETTE = ["#e9d5ff", "#c4b5fd", "#a855f7"] as const;
const TWINKLE_MIN_S = 2;
const TWINKLE_MAX_S = 6;
const SHOOT_GAP_MIN_MS = 6_000;
const SHOOT_GAP_MAX_MS = 14_000;
const SHOOT_LIFE_MS = 700;
const TAU = Math.PI * 2;

type Star = {
  x: number; /* normalized 0..1 of canvas width — survives resize */
  y: number;
  layer: number;
  size: number;
  color: string;
  bright: boolean; /* the brightest near stars get a white core */
  phase: number;
  period: number; /* twinkle period, seconds */
};

type Meteor = {
  x0: number;
  y0: number;
  cos: number;
  sin: number;
  dist: number;
  len: number; /* tail px */
  t0: number;
};

function makeStars(): Star[] {
  const stars: Star[] = [];
  LAYERS.forEach((L, layer) => {
    const n = Math.round(STAR_COUNT * L.share);
    for (let i = 0; i < n; i++) {
      const size = L.minSize + Math.random() * (L.maxSize - L.minSize);
      stars.push({
        x: Math.random(),
        y: Math.random(),
        layer,
        size,
        color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
        bright: layer === 2 && size > 1.55,
        phase: Math.random() * TAU,
        period: TWINKLE_MIN_S + Math.random() * (TWINKLE_MAX_S - TWINKLE_MIN_S),
      });
    }
  });
  return stars;
}

function spawnMeteor(now: number, w: number, h: number): Meteor {
  const leftward = Math.random() < 0.5;
  const tilt = ((Math.random() * 24 - 12) * Math.PI) / 180; /* shallow angle */
  const ang = leftward ? Math.PI - tilt : tilt;
  return {
    x0: w * (leftward ? 0.55 + Math.random() * 0.4 : 0.05 + Math.random() * 0.4),
    y0: h * (0.08 + Math.random() * 0.6),
    cos: Math.cos(ang),
    sin: Math.sin(ang),
    dist: w * (0.35 + Math.random() * 0.3),
    len: 80 + Math.random() * 60,
    t0: now,
  };
}

export function LiveSky() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; /* no 2d context — the deck renders fine without a sky */

    const prm = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stars = makeStars();
    let w = 0;
    let h = 0;
    let raf: number | null = null;
    let last: number | null = null;
    let meteor: Meteor | null = null;
    let nextShootAt = 0;
    let disabled = false;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (!cw || !ch) return;
      w = cw;
      h = ch;
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    /* stillness gates — checked every frame batch (cheap classList read) */
    const gatesClosed = () =>
      document.hidden ||
      prm.matches ||
      document.body.classList.contains("low-power");

    const stop = () => {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      last = null; /* resume never inherits a stale delta-t */
    };

    const frame = (t: number) => {
      try {
        if (gatesClosed()) {
          stop(); /* full stop, not a skip — sync() restarts us */
          return;
        }
        const dt = last === null ? 0 : Math.min((t - last) / 1000, 0.1);
        last = t;
        const tSec = t / 1000;
        const dx = Math.cos(DRIFT_RAD);
        const dy = Math.sin(DRIFT_RAD);
        ctx.clearRect(0, 0, w, h);
        for (const s of stars) {
          const L = LAYERS[s.layer];
          if (dt > 0 && w > 0 && h > 0) {
            s.x += (dx * L.speed * dt) / w;
            s.y += (dy * L.speed * dt) / h;
            if (s.x < 0) s.x += 1;
            else if (s.x >= 1) s.x -= 1;
            if (s.y < 0) s.y += 1;
            else if (s.y >= 1) s.y -= 1;
          }
          const tw = 0.5 + 0.5 * Math.sin(s.phase + (tSec * TAU) / s.period);
          ctx.globalAlpha = L.alpha * (0.3 + 0.7 * tw);
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(s.x * w, s.y * h, s.size, 0, TAU);
          ctx.fill();
          if (s.bright) {
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(s.x * w, s.y * h, s.size * 0.45, 0, TAU);
            ctx.fill();
          }
        }
        /* one shooting star at a time, every 6-14s */
        if (nextShootAt === 0) {
          nextShootAt =
            t + SHOOT_GAP_MIN_MS + Math.random() * (SHOOT_GAP_MAX_MS - SHOOT_GAP_MIN_MS);
        }
        if (!meteor && t >= nextShootAt && w > 0 && h > 0) {
          meteor = spawnMeteor(t, w, h);
        }
        if (meteor) {
          const p = (t - meteor.t0) / SHOOT_LIFE_MS;
          if (p >= 1) {
            meteor = null;
            nextShootAt =
              t + SHOOT_GAP_MIN_MS + Math.random() * (SHOOT_GAP_MAX_MS - SHOOT_GAP_MIN_MS);
          } else {
            const hx = meteor.x0 + meteor.cos * meteor.dist * p;
            const hy = meteor.y0 + meteor.sin * meteor.dist * p;
            const tx = hx - meteor.cos * meteor.len;
            const ty = hy - meteor.sin * meteor.len;
            const tail = ctx.createLinearGradient(hx, hy, tx, ty);
            tail.addColorStop(0, "rgba(233, 213, 255, 0.9)");
            tail.addColorStop(0.4, "rgba(196, 181, 253, 0.35)");
            tail.addColorStop(1, "rgba(168, 85, 247, 0)");
            ctx.globalAlpha = Math.sin(Math.PI * p); /* fade in, fade out */
            ctx.strokeStyle = tail;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(hx, hy);
            ctx.stroke();
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(hx, hy, 1.6, 0, TAU);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      } catch {
        disabled = true; /* a bad frame kills the sky, never the deck */
        stop();
        return;
      }
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (disabled || raf !== null || gatesClosed()) return;
      raf = requestAnimationFrame(frame);
    };
    const sync = () => (gatesClosed() ? stop() : start());

    resize();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(resize);
      ro.observe(canvas);
    } else {
      window.addEventListener("resize", resize);
    }
    document.addEventListener("visibilitychange", sync);
    prm.addEventListener("change", sync);
    /* resume the stopped loop the moment body.low-power (ECO) clears */
    const mo = new MutationObserver(sync);
    mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    start();

    return () => {
      stop();
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", sync);
      prm.removeEventListener("change", sync);
      mo.disconnect();
    };
  }, []);

  /* pointer-events:none, z-index, inset live on .live-sky (deck.css) */
  return <canvas ref={canvasRef} className="live-sky" data-live-sky aria-hidden="true" />;
}
