/**
 * STARRA Engine — the server-only guard.
 *
 * WHY A LOCAL GUARD instead of `import "server-only"`: the `server-only`
 * package is NOT installed in this repo (only bundled privately inside
 * next/dist/compiled), and adding a dependency is forbidden by the build
 * constraints. Verified: `import("server-only")` under tsx fails with
 * ERR_MODULE_NOT_FOUND. So the engine ships its own equivalent — a loud
 * module-scope throw if a browser bundle ever pulls a secret-bearing module.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertServerOnly } from "../src/lib/engine/providers";

describe("engine server-only guard", () => {
  it("is a no-op on the server (no window)", () => {
    assert.equal(typeof (globalThis as { window?: unknown }).window, "undefined");
    assert.doesNotThrow(() => assertServerOnly("test"));
  });

  it("throws loudly if a browser environment loads the module", () => {
    const g = globalThis as { window?: unknown };
    g.window = {};
    try {
      assert.throws(() => assertServerOnly("providers.ts"), /server-only/i);
    } finally {
      delete g.window;
    }
  });

  it("names the offending module in the message, and no secrets", () => {
    const g = globalThis as { window?: unknown };
    g.window = {};
    try {
      assertServerOnly("config.ts");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /config\.ts/);
    } finally {
      delete g.window;
    }
  });
});
