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
 * prefers-reduced-motion, or body.in-call, and resumes when they clear
 * (visibilitychange + matchMedia change + MutationObserver on body class).
 * A bad frame disables the sky instead of breaking the deck — additive
 * degradation.
 *
 * STOPPED IS STILL, NEVER EMPTY (2026-09-30). Every one of those gates paints
 * ONE static frame (paintStill -> paint(t, 0)) and holds it, so a reduced-motion
 * user, an ECO-on reload and a deck opened in a background tab all see the stars
 * STANDING STILL — the same thing the retired CSS star layers gave them. This is
 * load-bearing now that Bridge no longer renders <Starfield />: on this deck
 * nothing else paints a star.
 */

/**
 * MEASUREMENTS (recorded 2026-07-31) — every number the sky and the reactor
 * run on, and where each one is enforced. tests/live-sky.test.ts parses this
 * file and deck.css and asserts each value below, so this block cannot
 * silently drift away from the code it describes.
 *
 * STARFIELD (this file)
 *   STAR_COUNT ......... 120 stars drawn per frame
 *   LAYERS ............. 3 parallax depths — share / drift / size / alpha:
 *       deep  0.45 -> 54 stars, 2.0 px/s, 0.6-1.0 px, alpha 0.55
 *       mid   0.35 -> 42 stars, 3.2 px/s, 0.9-1.4 px, alpha 0.75
 *       near  0.20 -> 24 stars, 5.0 px/s, 1.2-1.8 px, alpha 1.00
 *       shares sum to 1.00, so the drawn population is exactly STAR_COUNT.
 *   DRIFT heading ...... 200deg, wrapping at every edge
 *   TWINKLE period ..... 2-6 s per star, random phase
 *   white core ......... near layer only, star size above 1.55 px
 *   PALETTE ............ #e9d5ff / #c4b5fd (--star) / #a855f7 (--purple)
 *
 * METEOR — the rare streak (this file)
 *   gap ................ 6000-14000 ms between streaks, one alive at a time
 *   life ............... 700 ms, sine fade in and out
 *   tail 80-140 px, travel 0.35-0.65 x canvas width, tilt +/-12deg
 *
 * FRAME BUDGET (this file)
 *   devicePixelRatio ... capped at 2 (retina crispness without a 3x fill cost)
 *   delta-t clamp ...... 0.1 s, so a stalled tab never jumps the field
 *
 * REACTOR (deck.css)
 *   center ............. --reactor-cx 50% / --reactor-cy 49% on #stage
 *   rings .............. 40 / 54 / 68 vmin at 18s cw, 45s ccw, 90s cw
 *   ring opacity ....... 0.75 / 0.55 / 0.40, 2.5-3 px band via radial mask
 *   core glow .......... 26 vmin, breathe 4.5 s, scale 1.00 -> 1.06
 *   nebula wash ........ opacity 0.4 (was 0.6) so the canvas reads on top
 *
 * AUTHED-DOM VERIFICATION — NOT PERFORMED. Stated plainly rather than
 * implied: the dev deck answers on :3000, but every page sits behind the
 * session gate (src/middleware.ts:29-46 redirects to /login) and this agent
 * does not type Classic's password to authenticate. So every number above is
 * verified from SOURCE only — the constants below in this file, plus
 * deck.css --reactor-cx/--reactor-cy and .reactor-ring-1/2/3 +
 * .reactor-core-glow. The reactor CENTER (50%/49%) is recorded in deck.css as
 * CEO-measured against the recording; nobody has re-derived it from pixels
 * since, which is exactly why it is a nudge var and not a hard-coded offset.
 *
 * One paste in the logged-in deck's DevTools console closes the live leg:
 *   const c = document.querySelector('canvas.live-sky');
 *   const s = getComputedStyle(document.getElementById('stage'));
 *   ({ canvas: !!c, w: c && c.width, h: c && c.height,
 *      rings: document.querySelectorAll('.reactor-ring').length,
 *      glow: !!document.querySelector('.reactor-core-glow'),
 *      cx: s.getPropertyValue('--reactor-cx').trim(),
 *      cy: s.getPropertyValue('--reactor-cy').trim() })
 * Expected: canvas true with non-zero w/h, rings 3, glow true, cx 50%, cy 49%.
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
      /* NOTE: setting width/height WIPES the canvas. The running loop repaints
         it on the next frame; when the gates are closed there IS no next frame,
         so onResize below repaints explicitly. */
    };

    /* stillness gates — checked every frame batch (cheap classList read) */
    const gatesClosed = () =>
      document.hidden ||
      prm.matches ||
      document.body.classList.contains("low-power") ||
      /* behind an opaque call panel: 120 star arcs nobody can see, competing
         with her mouth canvas for frames. VoiceCallOverlay sets this class only
         while the call is EXPANDED and covering the viewport, never while it is
         the collapsed 268px window (VoiceCallOverlay.tsx, the in-call effect) —
         collapsing must not freeze the deck he collapsed it to keep using. The
         MutationObserver below re-syncs on body class changes, so both expand
         and hang-up restart this on their own. */
      document.body.classList.contains("in-call");

    const stop = () => {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      last = null; /* resume never inherits a stale delta-t */
    };

    /* DRAW ONE FRAME. `dt === 0` means a STILL frame: nothing advances — no
       star drift, no meteor spawn, no meteor state touched — the field is
       painted exactly where it already stands. That is what every closed gate
       renders (see paintStill), so ECO, a hidden tab, reduced motion and an
       expanded call all leave STARS FROZEN on screen instead of an empty sky.
       Splitting this out of frame() is the whole reason the sky can be still
       without being blank; before the split, a gate that closed before the
       first frame landed meant the canvas was never painted at all. */
    const paint = (t: number, dt: number) => {
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
      /* one shooting star at a time, every 6-14s. Skipped entirely on a still
         frame (dt 0): a frozen sky must not spawn or advance a streak. */
      if (dt > 0) {
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
      }
      ctx.globalAlpha = 1;
    };

    /* THE STARS ALWAYS PAINT AT LEAST ONCE. Every gate in gatesClosed() used to
       mean an unpainted canvas if it was already shut when the loop tried to
       start: prefers-reduced-motion (permanently), ECO restored on at load, and
       a deck opened in a background tab. The old CSS star layers gave a still
       sky on those paths; this gives the same thing from the canvas. */
    const paintStill = () => {
      if (disabled || w <= 0 || h <= 0) return;
      try {
        paint(performance.now(), 0);
      } catch {
        disabled = true; /* same additive degradation as a bad live frame */
      }
    };

    const frame = (t: number) => {
      try {
        if (gatesClosed()) {
          stop(); /* full stop, not a skip — sync() restarts us */
          paintStill(); /* leave the sky visible and frozen, never blank */
          return;
        }
        const dt = last === null ? 0 : Math.min((t - last) / 1000, 0.1);
        last = t;
        paint(t, dt);
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
    const sync = () => {
      if (gatesClosed()) {
        stop();
        paintStill();
      } else {
        start();
      }
    };
    /* A RESIZE MUST NOT BLANK A FROZEN SKY. resize() wipes the canvas, and with
       the gates closed no frame is coming to repaint it — so under ECO or
       reduced motion a window resize used to leave an empty stage. This is also
       how the stars get up when canvas.clientWidth was still 0 at mount: the
       first observer callback lands here. */
    const onResize = () => {
      resize();
      if (gatesClosed()) paintStill();
    };

    resize();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(onResize);
      ro.observe(canvas);
    } else {
      window.addEventListener("resize", onResize);
    }
    document.addEventListener("visibilitychange", sync);
    prm.addEventListener("change", sync);
    /* resume the stopped loop the moment body.low-power (ECO) clears */
    const mo = new MutationObserver(sync);
    mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    /* sync(), not start(): if a gate is ALREADY closed at mount — reduced
       motion, ECO restored on from localStorage, or the deck opened in a
       background tab — start() returns without ever painting and the sky is
       EMPTY. sync() paints the one still frame instead. */
    sync();

    return () => {
      stop();
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", sync);
      prm.removeEventListener("change", sync);
      mo.disconnect();
    };
  }, []);

  /* pointer-events:none, z-index, inset live on .live-sky (deck.css) */
  return <canvas ref={canvasRef} className="live-sky" data-live-sky aria-hidden="true" />;
}
