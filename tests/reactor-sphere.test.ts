/**
 * THE SHAPE OF HER VOICE.
 *
 * `sphereRadiusAt` is the whole visual idea in one pure function: given an angle
 * and the current audio bands, how far out is the surface. Everything else in
 * the component is canvas boilerplate around it.
 *
 * These assertions are the difference between "a sphere that breathes when she
 * talks" and "a purple blob that looks like a bug". They are cheap to run and
 * impossible to eyeball reliably, which is exactly why they are tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sphereRadiusAt } from "../src/components/hud/sphere-geometry";

const SILENT = new Float32Array([0, 0, 0]);
const LOUD = new Float32Array([1, 1, 1]);

describe("sphereRadiusAt — silence", () => {
  it("is a calm, perfect circle when she is not speaking", () => {
    // A resting state that wobbles is the single most common way this kind of
    // effect reads as broken. Idle must be still.
    const samples: number[] = [];
    for (let theta = 0; theta < Math.PI * 2; theta += 0.3) {
      samples.push(sphereRadiusAt(theta, 0, SILENT));
    }
    const first = samples[0];
    for (const r of samples) {
      assert.ok(Math.abs(r - first) < 1e-9, `silence deformed the circle: ${r} vs ${first}`);
    }
  });

  it("does not drift over time while silent", () => {
    const early = sphereRadiusAt(1, 0, SILENT);
    const late = sphereRadiusAt(1, 9999, SILENT);
    assert.ok(Math.abs(early - late) < 1e-9, "idle must not crawl with the clock");
  });
});

describe("sphereRadiusAt — speech", () => {
  it("deforms when she speaks", () => {
    const quiet = sphereRadiusAt(1, 0, SILENT);
    const loud = sphereRadiusAt(1, 0, LOUD);
    assert.notEqual(loud, quiet, "loud audio must move the surface");
  });

  it("moves MORE the louder she gets", () => {
    const spread = (bands: Float32Array) => {
      let lo = Infinity, hi = -Infinity;
      for (let t = 0; t < Math.PI * 2; t += 0.2) {
        const r = sphereRadiusAt(t, 1.7, bands);
        lo = Math.min(lo, r); hi = Math.max(hi, r);
      }
      return hi - lo;
    };
    assert.ok(
      spread(LOUD) > spread(new Float32Array([0.2, 0.2, 0.2])),
      "louder speech must produce visibly more deformation",
    );
  });

  it("keeps moving as time advances while she speaks", () => {
    const a = sphereRadiusAt(1, 0, LOUD);
    const b = sphereRadiusAt(1, 0.5, LOUD);
    assert.notEqual(a, b, "the surface must travel, not hold one frozen shape");
  });
});

describe("sphereRadiusAt — it can never wreck the deck", () => {
  it("stays bounded across the whole input space", () => {
    for (let t = 0; t < Math.PI * 2; t += 0.1) {
      for (const time of [0, 1.3, 50, 9999]) {
        const r = sphereRadiusAt(t, time, LOUD);
        assert.ok(r > 0.2 && r < 1.8, `radius escaped its container: ${r}`);
      }
    }
  });

  it("is finite even for absurd input", () => {
    const junk = new Float32Array([Number.NaN, Infinity, -1]);
    const r = sphereRadiusAt(1, 1, junk);
    assert.ok(Number.isFinite(r), `NaN reached the canvas: ${r}`);
    assert.ok(r > 0.2 && r < 1.8);
  });

  it("is continuous around the seam at theta = 0 / 2pi", () => {
    // A discontinuity here draws a visible crack down the sphere.
    const before = sphereRadiusAt(Math.PI * 2 - 1e-6, 2.2, LOUD);
    const after = sphereRadiusAt(0, 2.2, LOUD);
    assert.ok(Math.abs(before - after) < 1e-3, `seam crack: ${before} vs ${after}`);
  });
});
