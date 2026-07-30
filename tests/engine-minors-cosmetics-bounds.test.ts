/**
 * COSMETICS BOUNDS — one authoritative range, and a CLAMP instead of a wipe.
 *
 * THE BUG THIS FILE EXISTS TO PREVENT. Cosmetics were bounded TWICE with
 * DIFFERENT numbers, and the WIDER one was the store:
 *   • src/lib/engine/config.ts:154,158  — glowIntensity max 3, fontScale 0.5-2
 *   • src/app/api/engine/_shared.ts:283,287 — glowIntensity max 1.6, fontScale 0.85-1.35
 * So a hand-edited or migrated data/engine.json holding glowIntensity 2.0 passed
 * the store's sanitize untouched, then `normalizeCosmetics` failed schema
 * validation on the MERGED object and returned `{...DEFAULT_COSMETICS}` —
 * silently discarding EVERY cosmetic Classic had set, accentHue included.
 *
 * The contract now: the NARROW, UI-safe range is the single source of truth (the
 * wide range had no consumer — the panel clamps to 0-1.6 / 0.85-1.35 at
 * OptionsPanel.tsx:133-134 and the client hook clamps to the same numbers at
 * useCosmetics.ts:80-84), and an out-of-range value CLAMPS to the nearest valid
 * value. One bad field may never reset the fields around it.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLiveCosmetics } from "../src/lib/engine/useCosmetics";

type Shared = typeof import("../src/app/api/engine/_shared");
type EngineConfigMod = typeof import("../src/lib/engine/config");
let S: Shared;
let E: EngineConfigMod;

const ENGINE_ENV = "STARRA_ENGINE_CONFIG_PATH";
const savedEngineEnv = process.env[ENGINE_ENV];

before(async () => {
  S = await import("../src/app/api/engine/_shared");
  // config.ts is server-only (assertServerOnly). Under node there is no
  // `window`, so importing it here is exactly how the routes import it.
  E = await import("../src/lib/engine/config");
});

after(() => {
  if (savedEngineEnv === undefined) delete process.env[ENGINE_ENV];
  else process.env[ENGINE_ENV] = savedEngineEnv;
  E.__resetEngineConfigCache();
});

describe("cosmetics bounds — ONE authoritative range", () => {
  it("the store and the projection publish the SAME bounds object", () => {
    assert.deepEqual(
      E.COSMETIC_BOUNDS,
      S.COSMETIC_BOUNDS,
      "the store and the API projection disagree on the cosmetics range again",
    );
  });

  it("the published bounds are the NARROW, UI-safe set the panel can actually produce", () => {
    assert.deepEqual(S.COSMETIC_BOUNDS.accentHue, [0, 360]);
    assert.deepEqual(S.COSMETIC_BOUNDS.glowIntensity, [0, 1.6]);
    assert.deepEqual(S.COSMETIC_BOUNDS.fontScale, [0.85, 1.35]);
  });

  it("the strict cosmeticsSchema agrees with the published bounds at both edges", () => {
    const at = (patch: Record<string, number>) =>
      S.cosmeticsSchema.safeParse({ ...S.DEFAULT_COSMETICS, ...patch }).success;

    assert.equal(at({ glowIntensity: S.COSMETIC_BOUNDS.glowIntensity[1] }), true);
    assert.equal(at({ glowIntensity: S.COSMETIC_BOUNDS.glowIntensity[1] + 0.01 }), false);
    assert.equal(at({ fontScale: S.COSMETIC_BOUNDS.fontScale[0] }), true);
    assert.equal(at({ fontScale: S.COSMETIC_BOUNDS.fontScale[0] - 0.01 }), false);
  });
});

describe("cosmetics bounds — the store CLAMPS, it does not silently widen", () => {
  it("sanitizeEngineConfig clamps a glowIntensity the panel could never produce", () => {
    const cfg = E.sanitizeEngineConfig({ cosmetics: { glowIntensity: 2.0 } });
    assert.equal(cfg.cosmetics.glowIntensity, 1.6);
  });

  it("sanitizeEngineConfig clamps fontScale at BOTH ends", () => {
    assert.equal(E.sanitizeEngineConfig({ cosmetics: { fontScale: 1.8 } }).cosmetics.fontScale, 1.35);
    assert.equal(E.sanitizeEngineConfig({ cosmetics: { fontScale: 0.2 } }).cosmetics.fontScale, 0.85);
  });

  it("sanitizeEngineConfig clamps accentHue and keeps it an integer", () => {
    assert.equal(E.sanitizeEngineConfig({ cosmetics: { accentHue: 5000 } }).cosmetics.accentHue, 360);
    assert.equal(E.sanitizeEngineConfig({ cosmetics: { accentHue: -40 } }).cosmetics.accentHue, 0);
    assert.equal(E.sanitizeEngineConfig({ cosmetics: { accentHue: 200.6 } }).cosmetics.accentHue, 201);
  });

  it("a NON-number stays a fallback-to-default, never a coerced 0", () => {
    const cfg = E.sanitizeEngineConfig({
      cosmetics: { glowIntensity: "bright", fontScale: null, accentHue: "blue" },
    });
    assert.equal(cfg.cosmetics.glowIntensity, S.DEFAULT_COSMETICS.glowIntensity);
    assert.equal(cfg.cosmetics.fontScale, S.DEFAULT_COSMETICS.fontScale);
    assert.equal(cfg.cosmetics.accentHue, S.DEFAULT_COSMETICS.accentHue);
  });

  it("NaN and Infinity can never reach the deck", () => {
    // JSON cannot carry these, but deepMergeConfig can — a patch is plain JS.
    const cfg = E.sanitizeEngineConfig({
      cosmetics: { glowIntensity: Number.POSITIVE_INFINITY, fontScale: Number.NaN },
    });
    assert.ok(Number.isFinite(cfg.cosmetics.glowIntensity));
    assert.ok(Number.isFinite(cfg.cosmetics.fontScale));
    assert.ok(cfg.cosmetics.glowIntensity <= 1.6);
    assert.ok(cfg.cosmetics.fontScale >= 0.85 && cfg.cosmetics.fontScale <= 1.35);
  });

  it("every sanitized config is accepted by the strict projection schema", () => {
    const hostile: unknown[] = [
      { cosmetics: { glowIntensity: 3 } },
      { cosmetics: { fontScale: 2 } },
      { cosmetics: { fontScale: 0.5 } },
      { cosmetics: { accentHue: 360 } },
      { cosmetics: { glowIntensity: 2.0, accentHue: 200, fontScale: 1.9 } },
    ];
    for (const raw of hostile) {
      const cfg = E.sanitizeEngineConfig(raw);
      assert.equal(
        S.cosmeticsSchema.safeParse(cfg.cosmetics).success,
        true,
        `the store produced cosmetics the projection rejects: ${JSON.stringify(cfg.cosmetics)}`,
      );
    }
  });
});

describe("cosmetics bounds — THE REGRESSION: one bad field may not wipe the rest", () => {
  it("glowIntensity 2.0 in a hand-edited engine.json keeps accentHue and every other field", () => {
    // Exactly the reported failure. Pure path first: store → projection.
    const cfg = E.sanitizeEngineConfig({
      cosmetics: {
        accentHue: 200,
        glowIntensity: 2.0,
        fontScale: 1.2,
        reduceMotion: true,
        mouthSync: false,
        idlePool: ["idle_c1"],
      },
    });
    const view = S.normalizeCosmetics(cfg.cosmetics);

    assert.equal(view.accentHue, 200, "his accent hue was discarded by an unrelated field");
    assert.equal(view.glowIntensity, 1.6, "glowIntensity did not clamp to the nearest valid value");
    assert.equal(view.fontScale, 1.2, "a valid fontScale was reset");
    assert.equal(view.reduceMotion, true, "reduceMotion was reset");
    assert.equal(view.mouthSync, false, "mouthSync was reset");
    assert.deepEqual(view.idlePool, ["idle_c1"], "his idle pool was reset");
  });

  it("normalizeCosmetics clamps rather than resetting, for EVERY ranged field", () => {
    const cases: ReadonlyArray<readonly [Record<string, unknown>, string, number]> = [
      [{ glowIntensity: 12 }, "glowIntensity", 1.6],
      [{ glowIntensity: -5 }, "glowIntensity", 0],
      [{ fontScale: 40 }, "fontScale", 1.35],
      [{ fontScale: 0 }, "fontScale", 0.85],
      [{ accentHue: 5000 }, "accentHue", 360],
      [{ accentHue: -1 }, "accentHue", 0],
    ];
    for (const [patch, field, expected] of cases) {
      const out = S.normalizeCosmetics({ ...patch, mouthSync: false, accentHue: 200, ...patch });
      assert.equal(
        (out as unknown as Record<string, number>)[field],
        expected,
        `${field} did not clamp for ${JSON.stringify(patch)}`,
      );
      assert.equal(
        out.mouthSync,
        false,
        `an out-of-range ${field} wiped mouthSync — the exact reported failure`,
      );
    }
  });

  it("a hostile idlePool entry is dropped without wiping the numeric fields", () => {
    const out = S.normalizeCosmetics({
      accentHue: 300,
      glowIntensity: 1.2,
      idlePool: ["idle_a1", "../../etc/passwd", "<script>", "idle_c1"],
    });
    assert.deepEqual(out.idlePool, ["idle_a1", "idle_c1"]);
    assert.equal(out.accentHue, 300);
    assert.equal(out.glowIntensity, 1.2);
  });

  it("an idlePool with NOTHING usable falls back to the vetted pool, not to empty", () => {
    const out = S.normalizeCosmetics({ accentHue: 300, idlePool: ["../x", 7, null] });
    assert.deepEqual(out.idlePool, S.DEFAULT_COSMETICS.idlePool);
    assert.equal(out.accentHue, 300, "an unusable idlePool wiped accentHue");
  });

  it("the returned idlePool is never the module default's own array", () => {
    const out = S.normalizeCosmetics(null);
    assert.notEqual(
      out.idlePool,
      S.DEFAULT_COSMETICS.idlePool,
      "normalizeCosmetics handed back the shared default array — a caller could mutate the module default",
    );
    assert.deepEqual(out.idlePool, S.DEFAULT_COSMETICS.idlePool);
  });

  it("garbage that is not an object still falls back to the whole default set", () => {
    for (const raw of [null, undefined, "nope", 7, [1, 2]]) {
      assert.deepEqual(S.normalizeCosmetics(raw), S.DEFAULT_COSMETICS);
    }
  });
});

describe("cosmetics bounds — the client hook and the server now agree", () => {
  it("normalizeCosmetics and normalizeLiveCosmetics clamp to the SAME values", () => {
    const probes: unknown[] = [
      { glowIntensity: 3 },
      { glowIntensity: -1 },
      { fontScale: 2 },
      { fontScale: 0.1 },
      { accentHue: 5000 },
      { accentHue: -1 },
      { glowIntensity: 2.0, accentHue: 200 },
    ];
    for (const raw of probes) {
      const server = S.normalizeCosmetics(raw);
      const client = normalizeLiveCosmetics(raw);
      assert.equal(server.glowIntensity, client.glowIntensity, `glow drift on ${JSON.stringify(raw)}`);
      assert.equal(server.fontScale, client.fontScale, `fontScale drift on ${JSON.stringify(raw)}`);
      assert.equal(server.accentHue, client.accentHue, `accentHue drift on ${JSON.stringify(raw)}`);
    }
  });
});

describe("cosmetics bounds — the WRITE path stays strict", () => {
  it("cosmeticsPatchSchema still REJECTS out-of-range values from the panel", () => {
    // Clamping is for a file Classic hand-edited. A patch coming off the wire is
    // a slider the UI controls, so an impossible value there is still a bug.
    const bad: unknown[] = [
      { accentHue: 9999 },
      { accentHue: -1 },
      { fontScale: 40 },
      { fontScale: 0 },
      { glowIntensity: 12 },
      { idlePool: [] },
      { unknownField: 1 },
    ];
    for (const b of bad) {
      assert.equal(
        S.cosmeticsPatchSchema.safeParse(b).success,
        false,
        `the write path accepted ${JSON.stringify(b)}`,
      );
    }
  });
});

describe("cosmetics bounds — the real file, end to end", () => {
  it("a real hand-edited engine.json survives a full read with every cosmetic intact", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starra-cosmetics-bounds-"));
    const file = path.join(dir, "engine.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        cosmetics: { accentHue: 200, glowIntensity: 2.0, fontScale: 1.9, mouthSync: false },
      }),
      "utf8",
    );
    process.env[ENGINE_ENV] = file;
    E.__resetEngineConfigCache();
    try {
      const cfg = await E.readEngineConfig();
      const view = S.normalizeCosmetics(cfg.cosmetics);
      assert.equal(view.accentHue, 200);
      assert.equal(view.glowIntensity, 1.6);
      assert.equal(view.fontScale, 1.35);
      assert.equal(view.mouthSync, false);
    } finally {
      if (savedEngineEnv === undefined) delete process.env[ENGINE_ENV];
      else process.env[ENGINE_ENV] = savedEngineEnv;
      E.__resetEngineConfigCache();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
