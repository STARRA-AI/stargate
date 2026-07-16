import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bookOfStarraTemplate,
  briefForPipeline,
  MONTAGE_PIPELINES,
  silentShadowTemplate,
} from "../src/lib/tools/openmontage";

describe("openmontage templates", () => {
  it("lists expected pipelines", () => {
    assert.ok(MONTAGE_PIPELINES.includes("silent-shadow-short"));
    assert.ok(MONTAGE_PIPELINES.includes("book-of-starra"));
  });

  it("silent shadow brief forbids Higgsfield and keeps Storm Ink", () => {
    const brief = silentShadowTemplate("stay standing");
    assert.match(brief, /Storm Ink/);
    assert.match(brief, /OpenMontage only/i);
    assert.match(brief, /Higgsfield is retired/i);
    assert.match(brief, /pseudonymous/i);
  });

  it("book of starra brief uses mythic tone", () => {
    const brief = bookOfStarraTemplate("the hearth");
    assert.match(brief, /Book of Starra/);
    assert.match(brief, /mythic/i);
    assert.match(brief, /Higgsfield is retired/i);
  });

  it("briefForPipeline routes correctly", () => {
    assert.match(
      briefForPipeline("book-of-starra", "x"),
      /Book of Starra/,
    );
    assert.match(
      briefForPipeline("silent-shadow-short", "x"),
      /Silent Shadow/,
    );
  });
});
