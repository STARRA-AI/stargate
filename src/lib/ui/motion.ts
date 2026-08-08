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

import { animate, createTimeline, stagger } from "animejs";

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

/**
 * THE DECK COMING ONLINE.
 *
 * One timeline, run once on mount. The order is the point: chrome first, then
 * the rails carrying her panels, then the panels themselves — so the deck reads
 * as ASSEMBLING around the reactor rather than everything appearing at once.
 *
 * The reactor is deliberately NOT in here. It is the deck's single animated
 * focal point (design doctrine), it has its own life off her voice, and giving
 * it a boot flourish would put two things in competition at exactly the moment
 * the eye is looking for one.
 *
 * Nothing loops. When the timeline ends the deck is at rest.
 */
export function deckBoot(root: ParentNode = document): void {
  if (prefersReducedMotion()) return;

  const pick = (sel: string) => Array.from(root.querySelectorAll(sel));
  const topbar = pick(".topbar");
  const rails = pick(".col");
  const panels = pick(".panel");

  // Nothing on screen yet (or the markup moved) — do not animate a fiction.
  if (!topbar.length && !rails.length && !panels.length) return;

  const tl = createTimeline({ defaults: { ease: EASE.out } });

  if (topbar.length) {
    tl.add(topbar, { opacity: [0, 1], translateY: [-8, 0], duration: DUR.panel }, 0);
  }
  // Left rail from the left, right rail from the right — they arrive from where
  // they live, which is what makes it read as assembly and not a fade. Two
  // explicit tracks rather than one function-valued tween: anime.js v4 does not
  // type a per-element function returning a [from, to] pair.
  const leftRail = rails.filter((el) => !el.classList.contains("col-right"));
  const rightRail = rails.filter((el) => el.classList.contains("col-right"));
  if (leftRail.length) {
    tl.add(leftRail, { opacity: [0, 1], translateX: [-18, 0], duration: DUR.panel }, 60);
  }
  if (rightRail.length) {
    tl.add(rightRail, { opacity: [0, 1], translateX: [18, 0], duration: DUR.panel }, 60);
  }
  if (panels.length) {
    tl.add(
      panels,
      {
        opacity: [0, 1],
        translateY: [10, 0],
        duration: DUR.reveal,
        delay: stagger(34),
      },
      120,
    );
  }
}

/**
 * A mobile tab becoming active: the outgoing content is already gone (the panel
 * is re-keyed and remounts), so this only has to bring the incoming one in.
 * Deliberately shorter than a panel reveal — a tab switch should feel like a
 * flick, not a page load.
 */
export function tabSwitch(target: Target): void {
  if (prefersReducedMotion()) return;
  animate(target, {
    opacity: [0, 1],
    translateX: [10, 0],
    duration: DUR.state,
    ease: EASE.out,
  });
}

/** The tab bar itself, on first paint — the row lands left to right. */
export function tabsIn(target: Target): void {
  if (prefersReducedMotion()) return;
  animate(target, {
    opacity: [0, 1],
    translateY: [6, 0],
    duration: DUR.state,
    ease: EASE.out,
    delay: stagger(22),
  });
}
