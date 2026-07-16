/**
 * Phase 0 — agent loop terminates within MAX_AGENT_TURNS.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LOOP_CAP_MESSAGE,
  MAX_AGENT_TURNS,
  runBoundedAgentLoop,
} from "../src/lib/agent/loop";

describe("bounded agent loop", () => {
  it("terminates when step never completes", async () => {
    let calls = 0;
    const { value, turns, capped } = await runBoundedAgentLoop({
      step: async () => {
        calls += 1;
        return { done: false };
      },
      onCap: async () => LOOP_CAP_MESSAGE,
    });
    assert.equal(capped, true);
    assert.equal(turns, MAX_AGENT_TURNS);
    assert.equal(calls, MAX_AGENT_TURNS);
    assert.ok(typeof value === "string" && value.length > 0);
    assert.match(value, /step limit/i);
  });

  it("returns early when step completes", async () => {
    let calls = 0;
    const { value, turns, capped } = await runBoundedAgentLoop({
      step: async () => {
        calls += 1;
        if (calls >= 3) return { done: true, value: "done-ok" };
        return { done: false };
      },
      onCap: async () => "capped",
    });
    assert.equal(capped, false);
    assert.equal(turns, 3);
    assert.equal(value, "done-ok");
  });
});
