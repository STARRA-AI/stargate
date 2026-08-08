import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SRC = readFileSync(new URL("../src/components/bridge/Bridge.tsx", import.meta.url), "utf8");

/**
 * The deck's press feedback is wired by hand at each call site, so nothing
 * enforces it but this file. If a control loses its `pressable` call the deck
 * silently goes dead under the finger — no type error, no lint error.
 */
describe("Bridge press feedback", () => {
  it("imports pressable from the sanctioned motion module", () => {
    assert.match(SRC, /import \{[^}]*\bpressable\b[^}]*\} from "@\/lib\/ui\/motion"/);
  });

  it("wires every press target it is supposed to own", () => {
    // Each entry is a marker that must appear inside a handler that also
    // presses. Keyed on the control's class/href so a rename is caught too.
    const targets = [
      "mobile-tab",
      "eco-btn",
      "brief-banner",
      "btn-approve",
      "btn-later",
      "panel-tag",
    ];
    for (const t of targets) {
      assert.ok(SRC.includes(t), `Bridge.tsx no longer has a "${t}" control`);
    }
    const wired = SRC.match(/pressable\(e\.currentTarget\)/g) ?? [];
    assert.equal(
      wired.length,
      11,
      `expected 11 wired press targets, found ${wired.length} — a control lost (or gained) its press feedback`,
    );
  });

  it("leaves the call trigger alone — the hard wall", () => {
    // The call is the deck's most-used feature. Press feedback may never be
    // the reason its click handler changes shape.
    assert.match(SRC, /onClick=\{openCall\}/);
  });

  it("never presses without going through motion.ts reduced-motion gate", () => {
    // pressable() itself honours prefers-reduced-motion; Bridge must not
    // hand-roll a scale animation that bypasses it.
    assert.doesNotMatch(SRC, /animate\(\s*e\.currentTarget/);
  });
});
