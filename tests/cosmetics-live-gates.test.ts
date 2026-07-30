/**
 * LIVE COSMETICS — the two controls that used to LIE.
 *
 * Board finding MAJOR 4(a)/(b): the Options panel persisted `cosmetics.mouthSync`
 * and `cosmetics.idlePool` to data/engine.json and NOTHING read either one. The
 * real mouth gate was a BUILD-TIME env read (viseme-sync.ts MOUTH_SYNC_ENABLED)
 * and the real idle pool was a frozen const (starra-clip-map.ts IDLE_POOL). So
 * Classic could switch a glitchy clip OFF, watch the panel say OFF, watch
 * engine.json record OFF — and her face kept playing it forever.
 *
 * These tests pin the RUNTIME behaviour that closes that gap:
 *   - the env var stays the HARD kill switch (it can only ever turn the mouth OFF)
 *   - cosmetics can only NARROW the vetted idle pool, never invent a clip
 *   - an empty / unknown / hand-corrupted selection falls back to the full pool
 *     rather than leaving her face frozen or blank
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MOUTH_SYNC_ENABLED, effectiveMouthSync } from "../src/lib/voice/viseme-sync";
import {
  IDLE_POOL,
  STARRA_CLIPS,
  pickIdle,
  resolveIdlePool,
  type StarraClipKey,
} from "../src/lib/voice/starra-clip-map";

describe("effective mouth gate — env AND cosmetics", () => {
  it("env OFF beats cosmetics ON (the env var is the hard kill switch)", () => {
    assert.equal(effectiveMouthSync(true, false), false);
  });

  it("env ON + cosmetics OFF = OFF (the panel toggle is now real)", () => {
    assert.equal(effectiveMouthSync(false, true), false);
  });

  it("both ON = ON", () => {
    assert.equal(effectiveMouthSync(true, true), true);
  });

  it("both OFF = OFF", () => {
    assert.equal(effectiveMouthSync(false, false), false);
  });

  it("cosmetics UNAVAILABLE degrades to today's behaviour (env alone decides)", () => {
    // undefined/null = the engine is absent, logged out, or the fetch has not
    // landed yet. That must never change the mouth from what it does today.
    assert.equal(effectiveMouthSync(undefined, true), true);
    assert.equal(effectiveMouthSync(null, true), true);
    assert.equal(effectiveMouthSync(undefined, false), false);
    assert.equal(effectiveMouthSync(null, false), false);
  });

  it("a non-boolean cosmetic is treated as unavailable, never as OFF", () => {
    // A hand-edited engine.json is sanitized upstream, but this gate is total.
    assert.equal(effectiveMouthSync("yes" as unknown as boolean, true), true);
    assert.equal(effectiveMouthSync(0 as unknown as boolean, true), true);
  });

  it("defaults its env argument to the shipped MOUTH_SYNC_ENABLED", () => {
    assert.equal(effectiveMouthSync(true), MOUTH_SYNC_ENABLED);
    assert.equal(effectiveMouthSync(false), false);
    assert.equal(effectiveMouthSync(undefined), MOUTH_SYNC_ENABLED);
  });
});

describe("idle pool narrowing — the panel's IDLE POOL toggles are now real", () => {
  it("honors a valid SUBSET, in the order given", () => {
    assert.deepEqual([...resolveIdlePool(["idle_a1", "idle_c1"])], ["idle_a1", "idle_c1"]);
    assert.deepEqual([...resolveIdlePool(["idle_c1"])], ["idle_c1"]);
    assert.deepEqual([...resolveIdlePool(["idle_a2", "idle_a1"])], ["idle_a2", "idle_a1"]);
  });

  it("drops UNKNOWN ids", () => {
    assert.deepEqual([...resolveIdlePool(["idle_a1", "nope", "idle_zz"])], ["idle_a1"]);
  });

  it("drops clips that exist but are NOT vetted pool members", () => {
    // idle_a / idle_b / idle_c are the full originals: each has a MEASURED
    // disqualifying defect (starra-clip-map.ts:50-61). `talking` loops forever,
    // so it would never fire `ended` and her face would freeze on it.
    for (const id of ["idle_a", "idle_b", "idle_c", "talking"]) {
      assert.ok(id in STARRA_CLIPS, `${id} should exist in STARRA_CLIPS`);
      assert.deepEqual(
        [...resolveIdlePool([id])],
        [...IDLE_POOL],
        `${id} must not be honored as an idle-pool member`,
      );
    }
  });

  it("de-duplicates repeats", () => {
    assert.deepEqual([...resolveIdlePool(["idle_a1", "idle_a1", "idle_c1"])], ["idle_a1", "idle_c1"]);
  });

  it("an EMPTY result falls back to the full default pool (never a blank face)", () => {
    assert.deepEqual([...resolveIdlePool([])], [...IDLE_POOL]);
    assert.deepEqual([...resolveIdlePool(["nope"])], [...IDLE_POOL]);
    assert.deepEqual([...resolveIdlePool(["idle_b"])], [...IDLE_POOL]);
  });

  it("a MISSING or malformed selection falls back to the full default pool", () => {
    assert.deepEqual([...resolveIdlePool(undefined)], [...IDLE_POOL]);
    assert.deepEqual([...resolveIdlePool(null)], [...IDLE_POOL]);
    assert.deepEqual([...resolveIdlePool("idle_a1" as unknown as string[])], [...IDLE_POOL]);
    assert.deepEqual(
      [...resolveIdlePool([null, 1, {}] as unknown as string[])],
      [...IDLE_POOL],
    );
  });

  it("never returns a key that is absent from STARRA_CLIPS", () => {
    for (const input of [["idle_a1"], ["nope"], [], undefined, ["idle_b", "idle_c1"]]) {
      for (const key of resolveIdlePool(input as string[] | undefined)) {
        assert.ok(key in STARRA_CLIPS, `resolveIdlePool produced unknown clip ${key}`);
      }
    }
  });
});

describe("pickIdle honors the resolved pool", () => {
  it("only ever returns a member of the pool it was given", () => {
    const pool = resolveIdlePool(["idle_a1", "idle_c1"]);
    for (let i = 0; i < 40; i++) {
      const got = pickIdle(null, i / 40, pool);
      assert.ok(pool.includes(got), `pickIdle returned ${got}, outside the pool`);
    }
  });

  it("a SINGLE-clip pool keeps returning that clip, even as `prev`", () => {
    // The narrow case that used to be able to strand her: filtering out `prev`
    // empties the pool, so the filter must fall back to the pool itself.
    const pool = resolveIdlePool(["idle_c1"]);
    assert.deepEqual([...pool], ["idle_c1"]);
    assert.equal(pickIdle("idle_c1", 0, pool), "idle_c1");
    assert.equal(pickIdle("idle_c1", 0.999, pool), "idle_c1");
    assert.equal(pickIdle(null, 0.5, pool), "idle_c1");
  });

  it("avoids an immediate repeat when the pool has room to", () => {
    const pool = resolveIdlePool(["idle_a1", "idle_c1"]);
    for (let i = 0; i < 20; i++) {
      assert.notEqual(pickIdle("idle_a1", i / 20, pool), "idle_a1");
    }
  });

  it("defaults to IDLE_POOL when no pool is passed (existing call sites unchanged)", () => {
    for (let i = 0; i < 30; i++) {
      const got = pickIdle(null, i / 30);
      assert.ok((IDLE_POOL as readonly string[]).includes(got));
    }
  });

  it("an EMPTY pool argument degrades to IDLE_POOL instead of returning undefined", () => {
    const got = pickIdle(null, 0.5, [] as readonly StarraClipKey[]);
    assert.ok((IDLE_POOL as readonly string[]).includes(got));
  });

  it("never returns undefined for an out-of-range rand", () => {
    for (const rand of [-1, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const got = pickIdle(null, rand);
      assert.ok(typeof got === "string" && got in STARRA_CLIPS, `rand ${rand} -> ${got}`);
    }
  });
});
