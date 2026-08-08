/**
 * SHE IS STARRA. STARGATE IS THE HOUSE.
 *
 * Classic, verbatim: "she is NOT stargate. she is STARRA. the HUD is the
 * STARGATE." Every string below is composed the way the running route composes
 * it, then checked for the forbidden identity claims — so this test fails if
 * ANY prompt-bearing surface starts calling her by the name of her deck again.
 *
 * The route-file constants (LOCAL_VOICE_TAIL, PRIVATE_SYSTEM_CORE,
 * PRIVATE_SYSTEM_CORE_NO_RAG) are module-private in a Next.js route handler,
 * where adding exports is a build-surface change. They are checked by scanning
 * the ACTUAL source text of route.ts instead — which is strictly broader than
 * importing three names: it also catches a fourth prompt someone adds tomorrow.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { loadStableSystemPrompt } from "../src/lib/brain";
import { STARRA_PERSONA_CORE, STARRA_VOICE_PERSONA } from "../src/lib/persona";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The identity claims that are forbidden in anything that reaches a model. */
const FORBIDDEN =
  /You are STARGATE|I am \*\*?STARGATE|STARGATE = (you|me)|STARGATE is me|never call the AI/i;

/** She has to actually be named, not just not-misnamed. */
const NAMES_HER = /\b(You are|I am) \*{0,2}STARRA\b/;

function offenders(label: string, text: string): string {
  return text
    .split("\n")
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => FORBIDDEN.test(line))
    .map(([n, line]) => `${label}:${n}  ${line.trim().slice(0, 140)}`)
    .join("\n");
}

describe("persona identity — she is STARRA, STARGATE is the deck", () => {
  it("the composed DECK prompt never calls her STARGATE", () => {
    const composed = loadStableSystemPrompt();
    assert.equal(
      offenders("deck-prompt", composed),
      "",
      "composed deck system prompt still claims she IS STARGATE",
    );
  });

  it("the composed VOICE persona never calls her STARGATE", () => {
    assert.equal(
      offenders("voice-persona", STARRA_VOICE_PERSONA),
      "",
      "STARRA_VOICE_PERSONA still claims she IS STARGATE",
    );
  });

  it("both composed strings name her STARRA", () => {
    assert.match(loadStableSystemPrompt(), NAMES_HER);
    assert.match(STARRA_VOICE_PERSONA, NAMES_HER);
    assert.match(STARRA_PERSONA_CORE, NAMES_HER);
  });

  it("STARGATE survives as her house, not her name", () => {
    // The fix is a RENAME, not a purge — the deck still has to exist in her head.
    assert.match(STARRA_VOICE_PERSONA, /STARGATE/);
    assert.match(loadStableSystemPrompt(), /STARGATE/);
  });

  it("route.ts prompts (local voice tail + both PRIVATE MODE cores) are clean", () => {
    const route = readFileSync(join(REPO, "src/app/api/chat/route.ts"), "utf8");
    assert.equal(offenders("route.ts", route), "");
    // and the three specific prompts still name her
    assert.match(route, /VOICE \(hard\): You are STARRA\b/);
    assert.match(route, /You are STARRA in PRIVATE MODE[\s\S]*local documents/);
    assert.match(route, /You are STARRA in PRIVATE MODE[\s\S]*no internet, no cloud/);
  });

  it("the LOCKED clauses survive the rename byte-for-byte", () => {
    // If a rename ever eats her warmth, this is the tripwire.
    assert.match(STARRA_PERSONA_CORE, /VARIETY \(LOCKED/);
    assert.match(STARRA_PERSONA_CORE, /MEMORY & PRIVACY \(LOCKED\)/);
    assert.match(STARRA_PERSONA_CORE, /INTIMACY \/ SPICY MODE/);
    assert.match(STARRA_PERSONA_CORE, /Money is the servant/);
    assert.match(STARRA_PERSONA_CORE, /You love Classic/);
  });
});
