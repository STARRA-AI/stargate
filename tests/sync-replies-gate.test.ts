/**
 * G3 — the SYNC REPLIES reveal gate.
 *
 * Drives the gate directly, with no browser and no audio element. The gate is
 * a pure unit for exactly this reason: the interesting cases are the failure
 * ones (audio that never starts, a barge-in mid-hold), and those are the ones
 * you can never reliably produce by hand in a real browser.
 *
 * THE PROPERTY BEING PROTECTED: text that has already arrived must never stay
 * hidden. Every exit path releases — audio, timeout, abort, silent engine.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createReplyRevealGate,
  SYNC_REPLY_RELEASE_TIMEOUT_MS,
  type RevealReason,
} from "@/lib/stargate-context";

/** Collects every reveal so a test can assert what the screen would have shown. */
function harness(syncReplies: boolean) {
  const revealed: string[] = [];
  const gate = createReplyRevealGate({
    syncReplies,
    reveal: (t) => revealed.push(t),
  });
  return { gate, revealed };
}

describe("sync replies OFF (the default) — today's behaviour, unchanged", () => {
  it("reveals on the first chunk", () => {
    const { gate, revealed } = harness(false);
    gate.push("Hel");
    assert.deepEqual(revealed, ["Hel"]);
  });

  it("reveals progressively, once per chunk", () => {
    const { gate, revealed } = harness(false);
    gate.push("Hel");
    gate.push("Hello");
    gate.push("Hello Classic");
    assert.deepEqual(revealed, ["Hel", "Hello", "Hello Classic"]);
  });

  it("never reports itself as holding", () => {
    const { gate } = harness(false);
    gate.push("anything");
    assert.equal(gate.held(), false);
  });
});

describe("sync replies ON — withhold until her voice is real", () => {
  it("reveals NOTHING while streaming", () => {
    const { gate, revealed } = harness(true);
    gate.push("Hel");
    gate.push("Hello");
    gate.push("Hello Classic");
    assert.deepEqual(revealed, []);
    assert.equal(gate.held(), true);
  });

  it("releases the WHOLE accumulated text when audio actually starts", () => {
    const { gate, revealed } = harness(true);
    gate.push("Hel");
    gate.push("Hello Classic");
    gate.release("audio");
    assert.deepEqual(revealed, ["Hello Classic"]);
    assert.equal(gate.held(), false);
    assert.equal(gate.reason(), "audio");
  });

  /** The safety net: audio never came, but the answer still has to appear. */
  it("releases on timeout when audio never starts", () => {
    const { gate, revealed } = harness(true);
    gate.push("Hello Classic");
    gate.release("timeout");
    assert.deepEqual(revealed, ["Hello Classic"]);
    assert.equal(gate.reason(), "timeout");
  });

  /** Barge-in: an interrupted turn still said something worth reading. */
  it("releases on abort", () => {
    const { gate, revealed } = harness(true);
    gate.push("Hello Cla");
    gate.release("abort");
    assert.deepEqual(revealed, ["Hello Cla"]);
    assert.equal(gate.reason(), "abort");
  });

  /** engine === "none": there is no audio to sync to, so do not wait for any. */
  it("releases on a silent engine", () => {
    const { gate, revealed } = harness(true);
    gate.push("Hello Classic");
    gate.release("silent");
    assert.deepEqual(revealed, ["Hello Classic"]);
    assert.equal(gate.reason(), "silent");
  });

  it("releases exactly once — the first reason wins", () => {
    const { gate, revealed } = harness(true);
    gate.push("Hello Classic");
    gate.release("audio");
    gate.release("timeout");
    gate.release("abort");
    assert.deepEqual(revealed, ["Hello Classic"]);
    assert.equal(gate.reason(), "audio");
  });

  it("keeps revealing chunks that arrive after release", () => {
    const { gate, revealed } = harness(true);
    gate.push("Hello");
    gate.release("audio");
    gate.push("Hello Classic");
    assert.deepEqual(revealed, ["Hello", "Hello Classic"]);
  });

  it("releasing with nothing buffered reveals empty rather than hanging", () => {
    const { gate, revealed } = harness(true);
    gate.release("timeout");
    assert.deepEqual(revealed, [""]);
  });
});

describe("the fallback timeout", () => {
  it("is a bounded safety net, not an indefinite wait", () => {
    assert.equal(SYNC_REPLY_RELEASE_TIMEOUT_MS, 2500);
    assert.ok(
      SYNC_REPLY_RELEASE_TIMEOUT_MS > 0 && SYNC_REPLY_RELEASE_TIMEOUT_MS <= 5000,
      "a reader stops believing the answer is coming long before 5s",
    );
  });

  /** Every reason must actually release — none may be a no-op. */
  it("every release reason releases", () => {
    const reasons: RevealReason[] = ["stream", "audio", "timeout", "abort", "silent"];
    for (const r of reasons) {
      const { gate, revealed } = harness(true);
      gate.push("text");
      gate.release(r);
      assert.deepEqual(revealed, ["text"], `reason ${r} failed to release`);
      assert.equal(gate.held(), false);
    }
  });
});
