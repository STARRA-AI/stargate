import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getFundingRegistry,
  summarizeFundingRegistry,
} from "../src/lib/funding/registry";

describe("funding registry", () => {
  it("keeps accepted no-key sources available now", () => {
    const registry = getFundingRegistry();
    const summary = summarizeFundingRegistry(registry);

    assert.ok(registry.some((source) => source.repo === "nayafia/microgrants"));
    assert.ok(
      summary.acceptedNow.some((source) => source.repo === "nayafia/microgrants"),
    );
    assert.ok(
      summary.acceptedNow.some(
        (source) => source.repo === "opensource-observer/oss-funding",
      ),
    );
  });

  it("separates separate-runtime and low-signal repos from current intake", () => {
    const registry = getFundingRegistry();
    const summary = summarizeFundingRegistry(registry);

    assert.ok(
      summary.futureHooks.some(
        (source) => source.repo === "georgetown-cset/funder-finder",
      ),
    );
    assert.ok(
      summary.rejected.some((source) => source.repo === "Dessiidoo/Fund-Flow-AI"),
    );
    assert.equal(summary.counts.total, registry.length);
  });
});
