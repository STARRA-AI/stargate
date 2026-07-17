import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchWakeWord } from "../src/lib/voice/wake-word";

describe("wake word", () => {
  it("matches bare starra", () => {
    const r = matchWakeWord("starra");
    assert.equal(r.woke, true);
    assert.equal(r.command, "");
  });

  it("matches hey starra plus command", () => {
    const r = matchWakeWord("hey starra what's next");
    assert.equal(r.woke, true);
    assert.match(r.command, /what's next/i);
  });

  it("ignores unrelated speech", () => {
    const r = matchWakeWord("schedule the short");
    assert.equal(r.woke, false);
  });
});
