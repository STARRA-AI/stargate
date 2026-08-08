/**
 * THE DESIGN DOCTRINE, AS A TEST.
 *
 * `.claude/skills/starra-design` sets STARGATE's motion cadence in prose. Prose
 * does not fail a build. Six months from now somebody bumps a duration to
 * 400ms "because it felt smoother" and the deck slowly turns into a generic AI
 * app with mushy transitions — which is the exact failure mode the doctrine
 * exists to prevent.
 *
 * So the numbers live here, and drift breaks the suite.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DUR, EASE, prefersReducedMotion } from "../src/lib/ui/motion";

describe("motion doctrine — durations", () => {
  it("panel and state shifts are 180-240ms", () => {
    for (const k of ["panel", "state", "reveal"] as const) {
      assert.ok(
        DUR[k] >= 180 && DUR[k] <= 240,
        `DUR.${k} = ${DUR[k]}ms is outside the doctrine's 180-240ms band`,
      );
    }
  });

  it("the badge breathes at about 3 seconds", () => {
    assert.ok(
      Math.abs(DUR.badgeBreathe - 3000) <= 200,
      `DUR.badgeBreathe = ${DUR.badgeBreathe}ms; doctrine says ~3s`,
    );
  });

  it("nothing in the scale is instant or sluggish", () => {
    for (const [k, v] of Object.entries(DUR)) {
      assert.ok(v > 0, `DUR.${k} must be positive`);
      assert.ok(v <= 3200, `DUR.${k} = ${v}ms is long enough to feel broken`);
    }
  });
});

describe("motion doctrine — easing", () => {
  it("is decisive, never springy or bouncy", () => {
    // Doctrine: "Ease should feel decisive and controlled. Prefer ease-out or
    // smooth custom curves over playful springiness."
    for (const [k, v] of Object.entries(EASE)) {
      assert.ok(
        !/spring|elastic|bounce|back/i.test(v),
        `EASE.${k} = "${v}" is the playful springiness the doctrine bans`,
      );
    }
  });

  it("every curve is a real anime.js easing string", () => {
    for (const [k, v] of Object.entries(EASE)) {
      assert.ok(
        /^(linear|ease|in|out|inOut|cubicBezier|steps)/.test(v),
        `EASE.${k} = "${v}" does not look like an anime.js easing`,
      );
    }
  });
});

describe("reduced motion", () => {
  it("is honored, and answers safely when there is no window at all", () => {
    // Runs under node with no DOM. It must not throw — server rendering and
    // the test suite both hit this path.
    assert.equal(typeof prefersReducedMotion(), "boolean");
  });
});
