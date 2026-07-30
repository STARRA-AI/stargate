/**
 * Mouth sync measured against the REAL shipped assets, not fixtures.
 *
 * These read public/avatar/visemes/anchor.json + bank.json off disk and assert
 * the properties the live-path fixes were made for. They are the evidence that
 * the pose ramp actually reduces dropouts on HER footage, and they will fail
 * loudly if the bank is ever re-authored in phase 2 in a way that breaks the
 * assumptions the renderer makes.
 *
 * Run: npx --yes tsx --test tests/*.test.ts   (package.json -> test:v2)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ATTACK_MS,
  POSE_CONFIDENCE_CUTOFF,
  POSE_CONFIDENCE_FLOOR,
  createMouthSmoother,
  isPoseUsable,
  parseAnchorTrack,
  parseVisemeBank,
  pickVisemeFrame,
  poseVisibility,
} from "../src/lib/voice/viseme-sync";

const ASSETS = path.join(process.cwd(), "public", "avatar", "visemes");
const readJson = (f: string): unknown =>
  JSON.parse(readFileSync(path.join(ASSETS, f), "utf8"));

const track = parseAnchorTrack(readJson("anchor.json"));
const bank = parseVisemeBank(readJson("bank.json"));

describe("mouth sync — the shipped assets parse and match the renderer", () => {
  it("anchor.json and bank.json both parse", () => {
    assert.ok(track, "anchor.json must parse");
    assert.ok(bank, "bank.json must parse");
  });

  it("the bank was cut from the clip the renderer paints over", () => {
    assert.ok(bank);
    assert.equal(bank.source, "/avatar/clips/talking.mp4");
  });

  it("the track covers the whole 11.8s talking loop at its own fps", () => {
    assert.ok(track);
    const seconds = track.frames.length / track.fps;
    assert.ok(
      Math.abs(seconds - 11.8) < 0.2,
      `track is ${seconds.toFixed(2)}s, expected ~11.8s (starra-clip-map.ts talking.durationMs)`,
    );
  });
});

describe("mouth sync — the pose ramp cuts real dropouts on her footage", () => {
  it("the old binary gate hid ~14% of frames — that is the bug being fixed", () => {
    assert.ok(track);
    const hidden = track.frames.filter((f) => !isPoseUsable(f)).length;
    const pct = (100 * hidden) / track.frames.length;
    assert.ok(
      pct > 10,
      `expected the legacy gate to hide >10% of frames, measured ${pct.toFixed(1)}%`,
    );
  });

  it("the ramp hides strictly fewer frames than the binary gate did", () => {
    assert.ok(track);
    const gateHidden = track.frames.filter((f) => !isPoseUsable(f)).length;
    const rampHidden = track.frames.filter((f) => poseVisibility(f) <= 0).length;
    assert.ok(
      rampHidden < gateHidden,
      `ramp hides ${rampHidden}, gate hid ${gateHidden} — the ramp must hide fewer`,
    );
    // and the difference is real, not a rounding artefact
    assert.ok(gateHidden - rampHidden >= 20, `only recovered ${gateHidden - rampHidden} frames`);
  });

  it("every hidden run is ENTERED through faded frames, never as a hard cut", () => {
    assert.ok(track);
    const vis = track.frames.map((f) => poseVisibility(f));
    let hardCuts = 0;
    for (let i = 1; i < vis.length; i++) {
      // a hard cut = full strength on one frame, fully gone on the very next
      if (vis[i - 1] === 1 && vis[i] === 0) hardCuts++;
    }
    assert.equal(
      hardCuts,
      0,
      "the patch must dissolve into her filmed mouth, never disappear between two frames",
    );
  });

  it("visibility never steps by more than a modest amount frame to frame", () => {
    assert.ok(track);
    const vis = track.frames.map((f) => poseVisibility(f));
    let worst = 0;
    for (let i = 1; i < vis.length; i++) worst = Math.max(worst, Math.abs(vis[i] - vis[i - 1]));
    // NCC moves smoothly per frame, so the ramp should too — a big jump would
    // read as a flicker at 30fps.
    assert.ok(worst <= 0.5, `largest per-frame visibility jump was ${worst.toFixed(3)}`);
  });

  it("the mouth box is CONTINUOUS through the low-confidence runs, so holding a stale box would be wrong", () => {
    assert.ok(track);
    // This is why the fix keeps using the tracked box instead of freezing it:
    // the tracker never loses the mouth, it just reports a rotated pose.
    let worstStep = 0;
    for (let i = 1; i < track.frames.length; i++) {
      const p = track.frames[i - 1];
      const c = track.frames[i];
      worstStep = Math.max(worstStep, Math.abs(c.x - p.x), Math.abs(c.y - p.y));
    }
    assert.ok(
      worstStep <= 10,
      `box jumps ${worstStep}px between adjacent frames — it is NOT a smooth track`,
    );
  });
});

describe("mouth sync — the bank floor is not a closed mouth (why the stall gate exists)", () => {
  it("zero openness picks a frame that is still visibly OPEN", () => {
    assert.ok(bank);
    const f = pickVisemeFrame(bank, 0);
    assert.ok(f);
    // If this ever becomes ~0 the stall gate could be relaxed — until then a
    // dead analyser must HIDE the canvas, not draw this frame forever.
    assert.ok(
      f.openness > 0.05,
      `bank floor is ${f.openness} — if it were truly closed the stall gate would be unnecessary`,
    );
  });

  it("PHASE 2 marker: there is still no fully-closed bilabial frame", () => {
    assert.ok(bank);
    const min = Math.min(...bank.frames.map((f) => f.openness));
    assert.ok(min > 0.02, `bank now has a near-closed frame (${min}) — revisit /m/ /b/ /p/`);
  });
});

describe("mouth sync — why delta-time must be computed unconditionally", () => {
  it("a stale dt makes the smoother teleport (the mouth POP being fixed)", () => {
    // Reproduces the hazard: every `return hide()` used to skip `last = now`, so
    // after a ~0.5s hidden run dt arrived clamped at 250ms.
    const stale = createMouthSmoother();
    const jumped = stale.step(1, 250);
    assert.ok(
      jumped > 0.99,
      `expected a near-instant snap with a 250ms dt, got ${jumped} (alpha = 1 - exp(-250/${ATTACK_MS}))`,
    );

    // With honest per-frame dt the same target is approached gradually, which is
    // what the reordered `last = now` in StarraClipFace.tick guarantees.
    const honest = createMouthSmoother();
    const oneFrame = honest.step(1, 16);
    assert.ok(
      oneFrame < 0.5,
      `a single 16ms frame should move less than halfway, got ${oneFrame}`,
    );
  });
});

describe("mouth sync — ramp tunables stay coherent", () => {
  it("the cutoff sits below the floor, or the ramp degenerates", () => {
    assert.ok(POSE_CONFIDENCE_CUTOFF < POSE_CONFIDENCE_FLOOR);
  });

  it("the ramp band actually contains some of her real frames", () => {
    assert.ok(track);
    const inBand = track.frames.filter((f) => {
      const v = poseVisibility(f);
      return v > 0 && v < 1;
    }).length;
    assert.ok(inBand > 0, "no frame lands in the fade band — the ramp would be a no-op");
  });
});
