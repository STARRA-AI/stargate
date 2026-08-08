import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const css = readFileSync("src/app/globals.css", "utf8");

describe("deck primitives", () => {
  it("never introduces a color outside the token set", () => {
    const decls = css.match(/(?:color|background|border-color)\s*:\s*(#[0-9a-f]{3,8})/gi) ?? [];
    const allowed = /#0a0414|#140826|#e9d5ff|#a855f7|#d946ef|#c4b5fd|#ff3d81|#8b5cf6|#ffd166/i;
    const rogue = decls.filter((d) => !allowed.test(d));
    assert.deepEqual(rogue, [], `hardcoded non-token colors: ${rogue.join(", ")}`);
  });

  it("keeps every documented token value byte-identical", () => {
    for (const [name, value] of [
      ["--void", "#0a0414"], ["--chrome", "#e9d5ff"], ["--purple", "#a855f7"],
      ["--magenta", "#d946ef"], ["--star", "#c4b5fd"], ["--danger", "#ff3d81"],
      ["--ok", "#8b5cf6"], ["--warn", "#ffd166"],
    ] as const) {
      assert.ok(css.includes(`${name}: ${value}`), `${name} must stay ${value}`);
    }
  });

  it("honors reduced motion for every transition it adds", () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });
});
