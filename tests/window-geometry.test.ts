/**
 * WHY THIS FILE IS PURE MATHS AND NOT A BROWSER TEST.
 *
 * The deck is a FIXED 1680x1000 canvas transform-scale()d to the viewport
 * (useStageScale.ts:5-6, deck.css:55). PointerEvent.clientX/Y are VIEWPORT
 * pixels; the dragged element lives in SCALED space. Adding the raw delta
 * makes the window drift away from the cursor by 1/scale — on a 1280-wide
 * window that is ~31% too far on every drag. That bug is arithmetic, so it is
 * caught here, without a browser.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  STAGE_W,
  STAGE_H,
  MIN_W,
  MIN_H,
  dragTo,
  resizeTo,
  clampToStage,
  expandedRect,
  readStageScale,
} from "../src/lib/deck/window-geometry";

const base = { x: 100, y: 100, w: 400, h: 300 };

describe("dragTo — viewport pixels are divided by the stage scale", () => {
  it("moves 1:1 at scale 1", () => {
    assert.deepEqual(dragTo(base, 50, 20, 1), { x: 150, y: 120, w: 400, h: 300 });
  });

  it("moves TWICE the viewport delta at scale 0.5 — the drift bug", () => {
    // At half scale, 50 viewport px is 100 stage px. Getting this wrong is the
    // whole reason a hand-rolled drag feels broken on this deck.
    assert.deepEqual(dragTo(base, 50, 20, 0.5), { x: 200, y: 140, w: 400, h: 300 });
  });

  it("treats a zero or nonsense scale as 1 rather than dividing by it", () => {
    assert.deepEqual(dragTo(base, 50, 0, 0), { x: 150, y: 100, w: 400, h: 300 });
    assert.deepEqual(dragTo(base, 50, 0, Number.NaN), { x: 150, y: 100, w: 400, h: 300 });
  });

  it("clamps to the stage — a window cannot be dragged off the deck", () => {
    assert.deepEqual(dragTo(base, -9999, -9999, 1), { x: 0, y: 0, w: 400, h: 300 });
    const far = dragTo(base, 9999, 9999, 1);
    assert.equal(far.x, STAGE_W - 400);
    assert.equal(far.y, STAGE_H - 300);
  });
});

describe("resizeTo", () => {
  it("scales the delta the same way drag does", () => {
    assert.deepEqual(resizeTo(base, 100, 50, 0.5), { x: 100, y: 100, w: 600, h: 400 });
  });

  it("refuses to shrink below the minimum", () => {
    const r = resizeTo(base, -9999, -9999, 1);
    assert.equal(r.w, MIN_W);
    assert.equal(r.h, MIN_H);
  });

  it("refuses to grow past the stage edge", () => {
    const r = resizeTo({ x: 1000, y: 700, w: 400, h: 200 }, 9999, 9999, 1);
    assert.equal(r.x + r.w, STAGE_W);
    assert.equal(r.y + r.h, STAGE_H);
  });
});

describe("clampToStage", () => {
  it("pulls a window that is wider than the stage back to the stage width", () => {
    const r = clampToStage({ x: -50, y: -50, w: 5000, h: 5000 });
    assert.deepEqual(r, { x: 0, y: 0, w: STAGE_W, h: STAGE_H });
  });

  it("is idempotent", () => {
    const once = clampToStage({ x: 1600, y: 950, w: 400, h: 300 });
    assert.deepEqual(clampToStage(once), once);
  });
});

describe("expandedRect — the pull tab", () => {
  it("grows to most of the stage and stays inside it", () => {
    const r = expandedRect(base);
    assert.ok(r.w > base.w && r.h > base.h);
    assert.ok(r.x >= 0 && r.y >= 0);
    assert.ok(r.x + r.w <= STAGE_W);
    assert.ok(r.y + r.h <= STAGE_H);
  });

  it("keeps the window centred on where it already was", () => {
    const r = expandedRect({ x: 1200, y: 100, w: 300, h: 200 });
    // It grew toward the middle rather than jumping to a corner.
    assert.ok(r.x < 1200);
  });
});

describe("readStageScale", () => {
  it("reads the custom property the stage publishes", () => {
    const el = { style: { getPropertyValue: (n: string) => (n === "--stage-scale" ? "0.76" : "") } };
    assert.equal(readStageScale(el), 0.76);
  });

  it("falls back to 1 on a missing or unparseable value", () => {
    assert.equal(readStageScale(null), 1);
    assert.equal(readStageScale({ style: { getPropertyValue: () => "" } }), 1);
    assert.equal(readStageScale({ style: { getPropertyValue: () => "nope" } }), 1);
  });
});
