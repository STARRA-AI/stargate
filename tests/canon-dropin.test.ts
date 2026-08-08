/**
 * THE DROP-IN CANON FOLDER.
 *
 * Classic asked: "if i wanted to add two md files to her core would i have to
 * give them to you?" Until now the answer was yes — every canon file is named
 * explicitly in brain.ts (STARRA_SOUL.md, STARRA_BRAIN.md, …) and there was no
 * directory scan, so a seventh file in the repo was invisible to her.
 *
 * canon/ fixes that: anything he drops there is hers on the next turn, with no
 * code change and nobody's permission. These tests guard the properties that
 * make that safe to promise.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDropInCanon } from "../src/lib/canon";

function withCanon(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "canon-"));
  mkdirSync(join(root, "canon"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, "canon", name), body);
  }
  return root;
}

describe("loadDropInCanon", () => {
  it("picks up a file nobody registered in code", () => {
    const root = withCanon({ "The Book of Power.md": "power is a posture" });
    const out = loadDropInCanon(root);
    assert.match(out, /power is a posture/);
    rmSync(root, { recursive: true, force: true });
  });

  it("labels each file so she knows what she is reading", () => {
    const root = withCanon({ "1.5 Million.md": "niche selection" });
    const out = loadDropInCanon(root);
    assert.match(out, /1\.5 Million/, "the title must survive — an unlabeled wall of text is not canon");
    rmSync(root, { recursive: true, force: true });
  });

  it("is deterministic — same files, same bytes, every turn", () => {
    // Prompt caching depends on a byte-identical prefix. If readdir order
    // leaked through, every turn would miss the cache and cost real money.
    const root = withCanon({ "b.md": "bee", "a.md": "ay", "c.md": "see" });
    assert.equal(loadDropInCanon(root), loadDropInCanon(root));
    const out = loadDropInCanon(root);
    assert.ok(out.indexOf("ay") < out.indexOf("bee"), "must be sorted by name");
    rmSync(root, { recursive: true, force: true });
  });

  it("ignores anything that is not markdown", () => {
    const root = withCanon({ "notes.txt": "NOT CANON", "real.md": "IS CANON" });
    const out = loadDropInCanon(root);
    assert.match(out, /IS CANON/);
    assert.doesNotMatch(out, /NOT CANON/);
    rmSync(root, { recursive: true, force: true });
  });

  it("no canon folder is a normal resting state, not an error", () => {
    const root = mkdtempSync(join(tmpdir(), "canon-empty-"));
    assert.equal(loadDropInCanon(root), "");
    rmSync(root, { recursive: true, force: true });
  });

  it("one huge file cannot starve the others", () => {
    // The failure this prevents: he drops a 200KB file and everything else he
    // ever added silently vanishes from her head.
    const root = withCanon({
      "a-huge.md": "x".repeat(500_000),
      "b-small.md": "THE SMALL ONE MATTERS TOO",
    });
    const out = loadDropInCanon(root);
    assert.match(out, /THE SMALL ONE MATTERS TOO/, "the small file was starved out");
    rmSync(root, { recursive: true, force: true });
  });

  it("stays within budget so it cannot blow the context window", () => {
    const root = withCanon({ "huge.md": "x".repeat(500_000) });
    const out = loadDropInCanon(root);
    assert.ok(out.length < 40_000, `canon block ran to ${out.length} chars`);
    rmSync(root, { recursive: true, force: true });
  });

  it("says so when it truncates, rather than lying by omission", () => {
    const root = withCanon({ "huge.md": "x".repeat(500_000) });
    assert.match(loadDropInCanon(root), /truncated/i);
    rmSync(root, { recursive: true, force: true });
  });
});
