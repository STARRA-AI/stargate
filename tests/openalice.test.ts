import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OPENALICE_CAPABILITIES,
  buildResearchPlan,
  getOpenAliceCapabilities,
} from "../src/lib/tools/openalice";

describe("openalice registry", () => {
  it("exposes read-first capabilities with gated trading", () => {
    const caps = getOpenAliceCapabilities();
    assert.equal(caps.length, OPENALICE_CAPABILITIES.length);
    assert.ok(caps.some((c) => c.id === "market_research" && c.mode === "read"));
    assert.ok(
      caps.some((c) => c.id === "trading_as_git" && c.mode === "write_gated"),
    );
  });

  it("builds honest research plans without live numbers", () => {
    const plan = buildResearchPlan("Kalshi adjacency scan");
    assert.equal(plan.query, "Kalshi adjacency scan");
    assert.ok(plan.steps.length >= 3);
    assert.match(plan.readout, /Plan only/i);
    assert.match(plan.executionNote, /disabled from STARGATE/i);
  });
});
