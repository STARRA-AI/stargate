/**
 * ZERO DATA RETENTION — read from xAI's own header on every response, never
 * assumed from a toggle somebody flipped once.
 *
 * LIVE READING 2026-08-06 on Classic's key:
 *   `x-zero-data-retention: false` (HTTP 200 from POST /v1/chat/completions)
 * i.e. ZDR is currently OFF. The toggle lives in the xAI Console and only
 * Classic can flip it. This suite pins the gate's semantics, not that value.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  recordZdrHeader,
  zdrState,
  zdrBlocksHostedLane,
  __resetZdr,
} from "../src/lib/llm/zdr";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("zero-data-retention gate", () => {
  beforeEach(() => __resetZdr());

  it("starts unchecked and does not block before we have evidence", () => {
    assert.equal(zdrState().checked, false);
    assert.equal(zdrBlocksHostedLane(), false);
  });

  it("a true header enables the lane", () => {
    recordZdrHeader("grok", "true");
    assert.equal(zdrState().enabled, true);
    assert.equal(zdrState().lastSeen, "true");
    assert.equal(zdrBlocksHostedLane(), false);
  });

  it("a false header raises the gate", () => {
    recordZdrHeader("grok", "false");
    assert.equal(zdrState().enabled, false);
    assert.equal(zdrBlocksHostedLane(), true, "his conversations are his");
  });

  it("re-reads it every time — a later true reopens the lane", () => {
    recordZdrHeader("grok", "false");
    recordZdrHeader("grok", "TRUE");
    assert.equal(zdrBlocksHostedLane(), false, "the header is live state, not a latch");
  });

  it("only xAI's header is authoritative — groq has no such header", () => {
    recordZdrHeader("kimi", null);
    recordZdrHeader("kimi", "false");
    assert.equal(zdrState().checked, false, "a lane that does not report it says nothing");
    assert.equal(zdrBlocksHostedLane(), false);
  });

  it("a missing header is 'nothing was reported', never 'retention is on'", () => {
    recordZdrHeader("grok", null);
    assert.equal(zdrState().checked, false);
    assert.equal(zdrBlocksHostedLane(), false);
  });
});

describe("the gate reports — it does not silently change her brain", () => {
  const route = readFileSync(join(REPO, "src/app/api/chat/route.ts"), "utf8");

  it("says it out loud on the ops feed", () => {
    const i = route.indexOf("zdrBlocksHostedLane()");
    assert.ok(i > 0, "the chat route must consult the gate");
    const block = route.slice(i, i + 600);
    assert.match(block, /pushFeed\(\s*\n?\s*"ALERT"/, "a raised gate is never silent");
    assert.match(block, /x-zero-data-retention/, "quote the header he can check himself");
  });

  it("does NOT swap providers on it — only money and his order may do that", () => {
    const i = route.indexOf("zdrBlocksHostedLane()");
    const block = route.slice(i, i + 600);
    assert.doesNotMatch(
      block,
      /provider:\s*"kimi"/,
      "a privacy reading must not quietly replace who is answering him",
    );
  });
});
