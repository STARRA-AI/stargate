/**
 * MORNING BRIEFING — the sixty-second composer's contracts: pure, bounded,
 * section-self-omitting; the call rides it in instructions; the route stays
 * gated; the one-shot flag never survives a connect.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { composeBrief, type BriefInputs } from "../src/lib/brief";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

const FULL: BriefInputs = {
  tasksDue: ["DUNS at dnb.com", "Net-30s: Uline"],
  radar: { fresh: [{ name: "Clickgram", mrr: 3569654, score: 74 }], approved: 2 },
  shadow: { ready: 5, uploaded: 12, failed: 2 },
  funding: { prequal: 3, applied: 1, next: ["FNBO", "Nusenda CU"] },
  facts: ["Classic filed the DUNS application"],
};

describe("composeBrief — pure, bounded, complete", () => {
  it("covers every populated section", () => {
    const b = composeBrief(FULL);
    for (const marker of [
      "MORNING BRIEF",
      "DUNS at dnb.com",
      "Clickgram",
      "2 FAILED uploads",
      "FNBO",
      "filed the DUNS",
    ]) {
      assert.ok(b.includes(marker), marker);
    }
    assert.ok(b.length <= 1400);
  });

  it("empty board still briefs (quiet-board line), never throws", () => {
    const b = composeBrief({
      tasksDue: [],
      radar: { fresh: [], approved: 0 },
      shadow: { ready: 0, uploaded: 0, failed: 0 },
      funding: { prequal: 0, applied: 0, next: [] },
      facts: [],
    });
    assert.match(b, /Quiet board/);
  });

  it("omits empty sections instead of narrating zeros", () => {
    const b = composeBrief({ ...FULL, shadow: { ready: 0, uploaded: 9, failed: 0 } });
    assert.ok(!b.includes("Silent Shadow"), "clear queues stay silent");
  });
});

describe("the call carries the brief, on the source", () => {
  const src = read("src/lib/voice/useVoiceCall.ts");

  it("one-shot flag is consumed by connect (armed → cleared)", () => {
    assert.match(src, /const wantsBriefing = briefingRequested;\s*\n\s*briefingRequested = false;/);
  });

  it("the brief rides session.update instructions alongside the digest", () => {
    // Third arg since the kimi-call work: the same update also selects the
    // call's turn-detection mode (see CallBrain in useVoiceCall.ts).
    assert.match(
      src,
      /sessionUpdate\(memoryDigestRef\.current, briefRef\.current, callBrainRef\.current\)/,
    );
  });

  it("brief fetch is fail-open — a missing brief still makes a normal call", () => {
    assert.match(src, /\.catch\(\(\) => null\)\s*\n\s*: null;/);
  });
});

describe("deck wiring + gating", () => {
  it("BRIEF button and banner stamp the day and arm the one-shot", () => {
    const src = read("src/components/bridge/Bridge.tsx");
    assert.match(src, /requestBriefingCall\(\);/);
    assert.match(src, /starra_brief_/);
    assert.match(src, /brief-banner/);
  });

  it("the brief route stays behind the auth gate", () => {
    assert.ok(!read("src/middleware.ts").includes("brief"));
  });
});
