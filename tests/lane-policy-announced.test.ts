/**
 * LANE POLICY — grok is the standing brain, and NOTHING ELSE answers silently.
 *
 * Classic, verbatim: "it all needs to be xai's grok and only the others IF we
 * run out of tokens and if i take her private chat or speak to her offline."
 *
 * Two things must be true of every lane that is NOT grok-4.5:
 *   (a) the FEED says so  — Classic sees which brain answered him;
 *   (b) HER PROMPT says so — she is told she is on a backup brain, so she can
 *       tell him plainly instead of being quietly diminished.
 *
 * (b) is the half that was missing everywhere: localFallback re-streamed with
 * the ordinary prompt, and the Anthropic rung under `auto` had neither half.
 *
 * The composition half is unit-tested for real (buildOneStarraPrompt). The
 * wiring half is asserted at source level, the same way tests/hosted-lane-
 * policy.test.ts pins the provider table: the branches are inside a streaming
 * route handler and are not reachable from a unit call without a network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { backupBrainNotice, buildOneStarraPrompt } from "../src/lib/brain";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const route = readFileSync(join(REPO, "src/app/api/chat/route.ts"), "utf8");

/** Text of the chat route's lane ladder — `useOllama` down to the offline stub. */
function laneLadder(): string {
  const start = route.indexOf("const localFallback = async (");
  const end = route.indexOf("Link degraded — start Ollama");
  assert.ok(start > 0 && end > start, "lane ladder moved — retarget this test");
  return route.slice(start, end);
}

describe("she is told when she is not on her standing brain", () => {
  it("buildOneStarraPrompt marks the backup brain, first, before her canon", () => {
    const plain = buildOneStarraPrompt();
    const backup = buildOneStarraPrompt({ backupBrain: "local Ollama" });
    assert.notEqual(plain, backup);
    assert.ok(backup.startsWith(backupBrainNotice("local Ollama")));
    assert.match(backup, /local Ollama/);
    assert.doesNotMatch(plain, /\[STATE: you are running on your backup brain/);
  });

  it("the notice tells her to say it out loud", () => {
    assert.match(backupBrainNotice("x"), /tell him plainly/);
  });
});

describe("lane policy — every non-grok lane announces itself twice", () => {
  const ladder = laneLadder();

  it("grok is the only lane composed from the plain prompt", () => {
    // The grok branch streams `system` (no backupBrain). Every other rung in
    // the ladder must build its prompt through backupSystem(...).
    assert.match(route, /provider: "grok",\n\s+system,/);
  });

  it("the local-Ollama fallback carries the backup-brain state block", () => {
    assert.match(
      ladder,
      /dropping to local Ollama[\s\S]{0,400}?system: clipSystemForLocal\(\s*backupSystem\(/,
      "localFallback still re-streams the ordinary prompt — she is never told",
    );
  });

  it("the deliberate local lane announces and marks too", () => {
    assert.match(ladder, /if \(useOllama && ollamaUp && hasModel\)[\s\S]{0,600}?pushFeed\(/);
    assert.match(
      ladder,
      /if \(useOllama && ollamaUp && hasModel\)[\s\S]{0,600}?backupSystem\(/,
    );
  });

  it("the Kimi lane announces the LANE CHANGE, not just the model, and marks her prompt", () => {
    const kimi = ladder.slice(ladder.indexOf('prefer === "kimi"'));
    assert.match(kimi, /pushFeed\(\s*\n?\s*"ALERT",[\s\S]{0,200}?Kimi/);
    // Budgeted inside the tiered builder so the truth can never 413 the lane.
    assert.match(kimi, /buildTieredSystemPrompt\(\{\s*\n\s*backupBrain:/);
  });

  it("the Anthropic rung is announced and marked — no silent third Starra", () => {
    const anth = ladder.slice(ladder.indexOf("anthropicKey &&"));
    assert.match(anth, /pushFeed\(\s*\n?\s*"ALERT",[\s\S]{0,200}?Anthropic/);
    assert.match(anth, /backupBrainNotice\(/);
    assert.match(anth, /system: backupBlocks,/);
  });

  it("the last-resort local rung is announced and marked", () => {
    const tail = ladder.slice(ladder.lastIndexOf("} else if (ollamaUp && hasModel) {"));
    assert.match(tail, /pushFeed\(/);
    assert.match(tail, /backupSystem\(/);
  });

  it("the private lane keeps its NO-hosted-fallback rule", () => {
    // Private mode is local-only by design; nothing may add a hosted rung to it.
    assert.doesNotMatch(
      route,
      /privateMode[\s\S]{0,400}?streamHosted\(/,
      "private mode must never reach a hosted provider",
    );
  });
});
