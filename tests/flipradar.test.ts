/**
 * FLIP RADAR — the revenue hunter's contracts.
 *
 * Pins: (1) extraction is total and tolerant of TrustMRR markup drift;
 * (2) verdict parsing survives model sloppiness; (3) the five filters stay
 * the five canon filters; (4) the store serializes writes and never regresses
 * operator status from a re-scan; (5) the route stays behind the auth gate.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  extractTrustMrr,
  parseVerdict,
  FIVE_FILTERS,
} from "../src/lib/flipradar/scan";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

const FIXTURE = `
<table><tbody>
<tr data-slot="table-row"><td><a href="/startup/clickgram"><span>Clickgram</span></a></td>
<td class="font-mono">$3,569,654</td></tr>
<tr data-slot="table-row"><td><a href="/startup/mindtests-io">x</a></td>
<td class="font-mono">$12,340</td></tr>
<tr><td>no link here, just $9,999</td></tr>
<tr><td><a href="/startup/freebie">x</a></td><td>no money cell</td></tr>
</tbody></table>`;

describe("extractTrustMrr — total, tolerant", () => {
  it("pulls slug, humanized name, url and MRR from table rows", () => {
    const got = extractTrustMrr(FIXTURE);
    assert.equal(got.length, 2);
    assert.equal(got[0].id, "clickgram");
    assert.equal(got[0].mrr, 3569654);
    assert.equal(got[0].url, "https://trustmrr.com/startup/clickgram");
    assert.equal(got[1].id, "mindtests-io");
    assert.equal(got[1].name, "Mindtests Io");
  });

  it("sorts by MRR descending and dedupes by slug", () => {
    const dup = FIXTURE + FIXTURE;
    const got = extractTrustMrr(dup);
    assert.equal(got.length, 2);
    assert.ok(got[0].mrr >= got[1].mrr);
  });

  it("junk input yields [] — never a throw", () => {
    for (const junk of ["", "<html>nothing</html>", null, 42]) {
      assert.deepEqual(extractTrustMrr(junk as unknown as string), []);
    }
  });
});

describe("parseVerdict — tolerant of model sloppiness", () => {
  it("accepts strict JSON", () => {
    const v = parseVerdict(
      '{"score":72,"filters":{"diligent":true,"value":true,"divineRight":true,"cost":false,"mission":true},"note":"solid"}',
    );
    assert.ok(v);
    assert.equal(v.score, 72);
    assert.equal(v.filters.cost, false);
  });

  it("accepts JSON buried in prose and clamps score", () => {
    const v = parseVerdict('Sure! Here you go: {"score": 140, "note": "hot"} hope that helps');
    assert.ok(v);
    assert.equal(v.score, 100);
    assert.equal(v.filters.diligent, false); // missing filters default false
  });

  it("returns null on junk", () => {
    assert.equal(parseVerdict("no json at all"), null);
    assert.equal(parseVerdict(""), null);
  });
});

describe("the five filters stay canon", () => {
  it("names all five", () => {
    for (const marker of [
      "DILIGENT-AND-STEADY",
      "REAL VALUE",
      "DIVINE RIGHT",
      "COST COUNTED",
      "MISSION-FIRST",
    ]) {
      assert.ok(FIVE_FILTERS.includes(marker), marker);
    }
  });

  it("divine right forbids identity copying", () => {
    assert.match(FIVE_FILTERS, /own brand/i);
  });
});

describe("store behavior — REAL, on a temp SQLite db", () => {
  it("upserts, preserves operator status across re-scans, fills verdicts only when absent", async () => {
    process.env.STARGATE_DB_PATH = join(
      tmpdir(),
      `flipradar-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    const { upsertScan, setStatus, getRadar } = await import(
      "../src/lib/flipradar/store"
    );
    const c = (id: string, mrr: number) => ({
      id,
      name: id,
      url: `https://trustmrr.com/startup/${id}`,
      mrr,
      source: "trustmrr" as const,
    });
    const v = (score: number) => ({
      score,
      filters: { diligent: true, value: true, divineRight: true, cost: true, mission: true },
      note: "n",
    });

    await upsertScan([c("alpha", 100), c("beta", 200)], new Map([["alpha", v(70)]]), "t1");
    await setStatus("alpha", "approved", "t2");
    // Re-scan: new MRR, a would-be verdict for alpha, a fresh candidate.
    const after = await upsertScan(
      [c("alpha", 150), c("gamma", 50)],
      new Map([["alpha", v(10)]]),
      "t3",
    );
    const alpha = after.entries.find((e) => e.id === "alpha");
    assert.ok(alpha);
    assert.equal(alpha.status, "approved", "re-scan must never regress status");
    assert.equal(alpha.mrr, 150, "re-scan refreshes the listed MRR");
    assert.equal(alpha.verdict?.score, 70, "an existing verdict is never overwritten");
    assert.equal(after.entries.length, 3);
    assert.equal(after.lastScanAt, "t3");
    assert.equal((await getRadar()).entries.length, 3);
    assert.equal(await setStatus("nope", "passed", "t4"), null);
  });

  it("writes are transactional (BEGIN/COMMIT with ROLLBACK), on the source", () => {
    const src = read("src/lib/flipradar/store.ts");
    assert.match(src, /d\.exec\("BEGIN"\)/);
    assert.match(src, /d\.exec\("ROLLBACK"\)/);
  });

  it("the route bounds its free-tier spend and stays gated", () => {
    const src = read("src/app/api/flipradar/route.ts");
    assert.match(src, /SCORE_BUDGET_PER_SCAN = 6/);
    assert.ok(!read("src/middleware.ts").includes("flipradar"), "no auth carve-out");
  });
});
