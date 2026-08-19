/**
 * Modelled on the deck-prefs contract: a read that fails returns the default,
 * a write that fails is dropped, and importing on the server is harmless.
 * A stored rect is clamped on the way OUT — a window saved on a bigger stage,
 * or a hand-edited value, must never strand itself off-deck.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { STAGE_W } from "../src/lib/deck/window-geometry";

const FALLBACK = { x: 10, y: 10, w: 400, h: 300 };

function installStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const g = globalThis as unknown as { window?: unknown };
  const prev = g.window;
  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    dispatchEvent: () => true,
    CustomEvent: class {
      constructor(public type: string) {}
    },
  };
  return () => {
    if (prev === undefined) delete g.window;
    else g.window = prev;
  };
}

let restore: () => void;
afterEach(() => restore?.());

describe("getWindowRect", () => {
  beforeEach(() => {
    restore = installStorage();
  });

  it("returns the fallback when nothing is stored", async () => {
    const { getWindowRect } = await import("../src/lib/deck/deck-windows");
    assert.deepEqual(getWindowRect("console", FALLBACK), FALLBACK);
  });

  it("returns the fallback on unparseable JSON rather than throwing", async () => {
    restore();
    restore = installStorage({ "stargate.window.rect.console": "{{{" });
    const { getWindowRect } = await import("../src/lib/deck/deck-windows");
    assert.deepEqual(getWindowRect("console", FALLBACK), FALLBACK);
  });

  it("clamps a stored rect that would sit off the deck", async () => {
    restore();
    restore = installStorage({
      "stargate.window.rect.console": JSON.stringify({ x: 99999, y: 0, w: 400, h: 300 }),
    });
    const { getWindowRect } = await import("../src/lib/deck/deck-windows");
    assert.equal(getWindowRect("console", FALLBACK).x, STAGE_W - 400);
  });

  it("rejects a stored value missing a field", async () => {
    restore();
    restore = installStorage({ "stargate.window.rect.console": JSON.stringify({ x: 1, y: 2 }) });
    const { getWindowRect } = await import("../src/lib/deck/deck-windows");
    assert.deepEqual(getWindowRect("console", FALLBACK), FALLBACK);
  });
});

describe("expanded flag", () => {
  beforeEach(() => {
    restore = installStorage();
  });

  it("defaults to collapsed", async () => {
    const { getWindowExpanded } = await import("../src/lib/deck/deck-windows");
    assert.equal(getWindowExpanded("console"), false);
  });

  it("round-trips", async () => {
    const { getWindowExpanded, setWindowExpanded } = await import(
      "../src/lib/deck/deck-windows"
    );
    setWindowExpanded("console", true);
    assert.equal(getWindowExpanded("console"), true);
  });
});

describe("key-prefix collision", () => {
  beforeEach(() => {
    restore = installStorage();
  });

  it("a window id starting with 'expanded.' cannot collide with another window's flag", async () => {
    const { getWindowRect, setWindowRect, getWindowExpanded, setWindowExpanded } = await import(
      "../src/lib/deck/deck-windows"
    );
    setWindowRect("expanded.foo", { x: 1, y: 2, w: 300, h: 200 });
    setWindowExpanded("foo", true);
    // Neither write may have disturbed the other.
    assert.equal(getWindowExpanded("foo"), true);
    assert.deepEqual(getWindowRect("expanded.foo", FALLBACK), { x: 1, y: 2, w: 300, h: 200 });
  });
});

describe("server import is harmless", () => {
  beforeEach(() => {
    const g = globalThis as unknown as { window?: unknown };
    const prev = g.window;
    delete g.window;
    restore = () => {
      if (prev !== undefined) g.window = prev;
    };
  });

  it("reads the default with no window at all", async () => {
    const { getWindowRect, getWindowExpanded } = await import(
      "../src/lib/deck/deck-windows"
    );
    assert.deepEqual(getWindowRect("console", FALLBACK), FALLBACK);
    assert.equal(getWindowExpanded("console"), false);
  });
});
