/**
 * ONE STARRA, ONE VOICE.
 *
 * Classic's order, verbatim: "i do NOT want to speak to her in the console or
 * in a chat or in a call and get 3 different responses."
 *
 * So the composed prompt is byte-identical everywhere, her canon leads it (the
 * cached prefix), and the only per-surface difference is a delivery note that
 * lands AFTER her canon. A prompt that forks on the surface is not a feature
 * difference — it is three different people wearing her name.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { buildOneStarraPrompt, buildSystemPromptBlocks } from "../src/lib/brain";
import { STARRA_PERSONA_CORE } from "../src/lib/persona";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

describe("ONE STARRA — one prompt, every surface", () => {
  it("is byte-identical no matter who asks", () => {
    assert.equal(buildOneStarraPrompt(), buildOneStarraPrompt());
  });

  it("contains her whole self, not a budget subset", () => {
    const p = buildOneStarraPrompt();
    for (const marker of ["STARRA_SOUL", "STARRA_BRAIN", "OPERATOR_AUTHORITY"]) {
      assert.ok(p.includes(marker), `missing ${marker}`);
    }
    assert.ok(
      p.includes(STARRA_PERSONA_CORE.slice(0, 80)),
      "her cross-surface persona must always be present, never a budget candidate",
    );
  });

  it("is cache-friendly: her canon leads, nothing volatile in front", () => {
    const p = buildOneStarraPrompt();
    const soulAt = p.indexOf("STARRA_SOUL");
    assert.ok(soulAt >= 0 && soulAt < 4000, `canon must lead; found at ${soulAt}`);
  });

  it("carries her persona core exactly ONCE — a second copy is pure cache burn", () => {
    const p = buildOneStarraPrompt();
    const needle = STARRA_PERSONA_CORE.slice(0, 120);
    let count = 0;
    for (let i = p.indexOf(needle); i >= 0; i = p.indexOf(needle, i + 1)) count += 1;
    assert.equal(
      count,
      1,
      "loadStableSystemPrompt already includes personaCoreBlock(); appending it " +
        "again duplicates ~7.3k chars of prompt on every single turn",
    );
  });

  it("composes exactly the stable block — no extra assembly of its own", () => {
    assert.equal(buildOneStarraPrompt(), buildSystemPromptBlocks([]).full);
  });

  it("tells her when she is NOT herself", () => {
    const backup = buildOneStarraPrompt({ backupBrain: "the free Groq lane" });
    assert.match(backup, /backup brain/i);
    assert.match(backup, /not fully yourself/i);
    assert.equal(
      backup.endsWith(buildOneStarraPrompt()),
      true,
      "the notice is PREPENDED, so she reads it before her own canon",
    );
    assert.ok(backup.includes(buildOneStarraPrompt()), "her canon is unchanged underneath");
  });
});

describe("the route composes ONE prompt", () => {
  const route = read("src/app/api/chat/route.ts");

  it("no longer branches the SYSTEM prompt on callVoice", () => {
    assert.doesNotMatch(
      route,
      /const system = callVoice\s*\n?\s*\?/,
      "the system prompt must not fork per surface — that is the three-Starras bug",
    );
  });

  it("uses the one-prompt builder", () => {
    assert.match(route, /buildOneStarraPrompt\(/);
  });

  it("the only per-surface difference is a delivery note appended AFTER her canon", () => {
    const i = route.indexOf("const system = [");
    const oneAt = route.indexOf("oneStarra,", i);
    const noteAt = route.indexOf("CALL_DELIVERY_NOTE", i);
    assert.ok(oneAt > i, "the composed system must start from the one prompt");
    assert.ok(noteAt > oneAt, "the call delivery note must come after the canon, never before it");
  });

  it("STILL sends this turn's volatile context — dropping it is a memory regression", () => {
    const i = route.indexOf("const system = [");
    const block = route.slice(i, route.indexOf("];", i));
    assert.match(
      block,
      /systemBlocks\.volatile/,
      "memory/vault/pack/RUNTIME/STYLE must ride every turn, appended after the one prompt",
    );
    const volAt = block.indexOf("systemBlocks.volatile");
    const oneAt = block.indexOf("oneStarra");
    assert.ok(oneAt < volAt, "volatile context goes AFTER the cached canon, never in front of it");
  });
});
