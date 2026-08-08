import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DUR, EASE } from "../src/lib/ui/motion";

describe("interaction motion", () => {
  it("a press is faster than a panel move — touch must feel instant", () => {
    assert.ok(DUR.press > 0 && DUR.press <= 120, `DUR.press=${DUR.press} should be <=120ms`);
    assert.ok(DUR.press < DUR.panel, "a press that takes as long as a panel reads as lag");
  });

  it("a status change is inside the doctrine band", () => {
    assert.ok(DUR.status >= 180 && DUR.status <= 240, `DUR.status=${DUR.status} outside 180-240ms`);
  });

  it("still bans springiness on the new curves", () => {
    for (const [k, v] of Object.entries(EASE)) {
      assert.ok(!/spring|elastic|bounce|back/i.test(v), `EASE.${k}="${v}" is banned`);
    }
  });
});
