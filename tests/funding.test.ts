/**
 * FUNDING tracker — parser + route discipline. Every doc row is a LEAD to
 * verify (the playbook's own rule); the parser is total; the route is gated
 * and validates status transitions against the closed set.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseFundingDoc } from "../src/lib/funding/store";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

describe("parseFundingDoc — total, doc-shaped", () => {
  it("parses bold-first-cell table rows into leads", () => {
    const md = [
      "| Institution | Pull | Notes |",
      "|---|---|---|",
      "| **FNBO (First National Bank of Omaha)** | Soft-pull prequal | EX at full app |",
      "| **Nusenda CU** | Soft-pull | NM footprint |",
      "| plain row | not | bold |",
    ].join("\n");
    const got = parseFundingDoc(md);
    assert.equal(got.length, 2);
    assert.equal(got[0].institution, "FNBO (First National Bank of Omaha)");
    assert.match(got[0].intel, /Soft-pull prequal · EX at full app/);
  });

  it("parses the REAL playbook doc to a non-trivial pipeline", () => {
    const got = parseFundingDoc(read("docs/BACKYARD_BANKS_AND_SOFT_PULL_FUNDING.md"));
    assert.ok(got.length >= 10, `expected >=10 leads, got ${got.length}`);
  });

  it("junk input yields []", () => {
    assert.deepEqual(parseFundingDoc(null as unknown as string), []);
    assert.deepEqual(parseFundingDoc("no tables here"), []);
  });
});

describe("route discipline", () => {
  it("gated + closed status set", () => {
    const src = read("src/app/api/funding/route.ts");
    assert.match(src, /lead\|prequal\|applied\|funded\|dead/);
    assert.ok(!read("src/middleware.ts").includes("funding"));
  });
});
