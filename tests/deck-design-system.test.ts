/**
 * Deck primitives v1 — the SHARED CONTRACT, pinned to source text.
 *
 * Division B1/B2 write markup against these exact class names. If a rename or a
 * palette tweak ever lands in globals.css, every screen goes unstyled with no
 * runtime error to catch it — so the names, the palette and `.panel-etch`'s
 * decoration are asserted here against the file itself.
 *
 * There is no DOM renderer in this suite: these read source and assert on text,
 * the same way tests/funding.test.ts does.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

const globals = read("src/app/globals.css");
const deck = read("src/styles/deck.css");

/** Frozen by the contract. No agent may rename, redefine, or add to this list. */
const CONTRACT_CLASSES = [
  "deck-grid",
  "deck-panel",
  "deck-panel-wide",
  "deck-title",
  "deck-subtitle",
  "deck-note",
  "deck-stack",
  "deck-badge",
  "is-ok",
  "is-warn",
  "is-danger",
  "is-idle",
];

/** Every hex the aesthetic lock nails down. A changed value is a changed deck. */
const PALETTE: [string, string][] = [
  ["--void", "#0a0414"],
  ["--void-2", "#140826"],
  ["--chrome", "#e9d5ff"],
  ["--purple", "#a855f7"],
  ["--magenta", "#d946ef"],
  ["--star", "#c4b5fd"],
  ["--danger", "#ff3d81"],
  ["--ok", "#8b5cf6"],
  ["--warn", "#ffd166"],
];

describe("deck primitives — contract class names", () => {
  for (const name of CONTRACT_CLASSES) {
    it(`.${name} is defined in globals.css`, () => {
      // The char class is what makes this a SELECTOR match and not a comment or
      // a substring of a longer class (`.deck-panel` vs `.deck-panel-wide`).
      assert.match(globals, new RegExp(`\\.${name}[\\s,{.:]`));
    });
  }

  it("defines exactly the four badge states, no fifth", () => {
    const states = [...globals.matchAll(/\.deck-badge\.(is-[a-z-]+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(states)].sort(), ["is-danger", "is-idle", "is-ok", "is-warn"]);
  });
});

describe("deck primitives — tokens", () => {
  it("--warn is defined in globals.css :root (it is used by .deck-badge.is-warn)", () => {
    assert.match(globals, /--warn:\s*#ffd166;/);
  });

  for (const [token, hex] of PALETTE) {
    it(`${token} is still ${hex}`, () => {
      assert.match(globals, new RegExp(`${token}:\\s*${hex};`));
    });
  }
});

describe("deck primitives — .panel-etch is untouched", () => {
  /** The decoration rule: whatever selector list carries `.panel-etch`. */
  const block = /\.panel-etch[^{]*\{([^}]*)\}/.exec(globals);

  it("the .panel-etch rule still exists", () => {
    assert.ok(block, "no rule in globals.css carries the .panel-etch selector");
  });

  it("keeps var(--panel), var(--border) and backdrop-filter", () => {
    const body = block![1];
    assert.match(body, /background:\s*var\(--panel\)/);
    assert.match(body, /border:\s*1px solid var\(--border\)/);
    assert.match(body, /backdrop-filter:\s*blur\(8px\)/);
  });

  it("shares that one decoration rule with .deck-panel — no duplicated block", () => {
    assert.match(globals, /\.panel-etch,\s*\.deck-panel\s*\{/);
    // `.deck-panel` carries the rhythm in its OWN rule, and only the rhythm.
    assert.match(globals, /\.deck-panel\s*\{[^}]*padding:\s*16px[^}]*\}/);
  });
});

describe("deck.css scope is load-bearing", () => {
  it("still opens with `#stage-wrap, :root` — re-scoping it repaints the Bridge", () => {
    assert.ok(
      deck.split("\n")[0].startsWith("#stage-wrap, :root"),
      `deck.css:1 is ${JSON.stringify(deck.split("\n")[0])}`,
    );
  });
});
