/**
 * ONE MOTION LAYER FOR THE DECK.
 *
 * Every animation on this deck should come from here, so the cadence stays one
 * decision instead of forty scattered ones. The numbers are the design
 * doctrine's (`.claude/skills/starra-design`), and tests/motion-doctrine.test.ts
 * fails the build if they drift.
 *
 * WHAT THIS IS NOT. It is not "animate everything". The doctrine is explicit:
 * reduce competing motion BEFORE adding new motion, keep ONE animated focal
 * point, and let the reactor lead. So this drives STATE CHANGES only — a panel
 * arriving, a row entering, a tab becoming active. The reactor's own long ring
 * loops stay in CSS where they were tuned, and nothing here loops forever.
 *
 * anime.js v4 API NOTE (verified against animejs@4.5.0 in node_modules):
 * v4 REMOVED the default export. `import anime from "animejs"` is undefined at
 * runtime — it must be named: `import { animate, stagger } from "animejs"`.
 */

import { animate, stagger } from "animejs";

/**
 * The duration scale, in ms. Doctrine: panel/state shifts 180-240ms, badge
 * breathe ~3s, ring rotation left alone in CSS.
 */
export const DUR = {
  /** A panel sliding or revealing itself. */
  panel: 220,
  /** A control changing state — active, armed, disabled. */
  state: 190,
  /** Content appearing: console lines, feed rows, list items. */
  reveal: 200,
  /** The badge's resting breath. Slow enough to read as alive, not as busy. */
  badgeBreathe: 3000,
} as const;

/**
 * Easing. Doctrine bans springiness: "decisive and controlled", "prefer
 * ease-out or smooth custom curves over playful springiness."
 */
export const EASE = {
  /** Default for things arriving. Fast out of the gate, settles gently. */
  out: "outQuad",
  /** For things that both start and stop on screen. */
  inOut: "inOutQuad",
  /** Brightening chrome — near-linear so it does not draw the eye. */
  chrome: "outSine",
} as const;

/** Gap between staggered siblings. Small: a list should land, not cascade. */
const STAGGER_MS = 28;

/**
 * Does this operator want motion suppressed?
 *
 * Answers `false` rather than throwing when there is no DOM — server rendering
 * and the node test suite both call this.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    // A matchMedia that throws is not a reason to animate against someone's
    // stated accessibility preference. Fail toward stillness.
    return true;
  }
}

/** Anything we can hand to anime.js. */
type Target = Parameters<typeof animate>[0];

/**
 * Reveal content: fade up into place.
 *
 * Under reduced motion the element is left exactly as the stylesheet drew it —
 * fully visible, correctly positioned, no animation scheduled. The doctrine
 * requires the reduced-motion path keep hierarchy and clarity, so this must
 * never leave something stuck at opacity 0.
 */
export function reveal(target: Target): void {
  if (prefersReducedMotion()) return;
  animate(target, {
    opacity: [0, 1],
    translateY: [6, 0],
    duration: DUR.reveal,
    ease: EASE.out,
  });
}

/** Reveal a group in sequence — feed rows, tool cards, list items. */
export function revealAll(target: Target): void {
  if (prefersReducedMotion()) return;
  animate(target, {
    opacity: [0, 1],
    translateY: [6, 0],
    duration: DUR.reveal,
    ease: EASE.out,
    delay: stagger(STAGGER_MS),
  });
}

/** A panel arriving from its edge. Transform + opacity only — no layout thrash. */
export function slideIn(target: Target, from: "left" | "right" = "right"): void {
  if (prefersReducedMotion()) return;
  animate(target, {
    opacity: [0, 1],
    translateX: [from === "right" ? 14 : -14, 0],
    duration: DUR.panel,
    ease: EASE.out,
  });
}

/** Chrome coming to attention — an active tab, an armed control. */
export function brighten(target: Target): void {
  if (prefersReducedMotion()) return;
  animate(target, { opacity: [0.62, 1], duration: DUR.state, ease: EASE.chrome });
}

/** Chrome standing down. */
export function dim(target: Target): void {
  if (prefersReducedMotion()) return;
  animate(target, { opacity: [1, 0.62], duration: DUR.state, ease: EASE.chrome });
}
