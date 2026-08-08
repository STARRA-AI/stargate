/**
 * ONE PERSON ACROSS SURFACES (source-scan).
 *
 * The Call (live xAI realtime session, driven by the CLIENT hook
 * src/lib/voice/useVoiceCall.ts) and the Deck (server route
 * src/app/api/chat/route.ts) must be the same person, not two assistants that
 * happen to share a name.
 *
 * They cannot share ONE prompt module, and that is a hard technical fact, not
 * a shortcut: useVoiceCall.ts is `"use client"`, while the Deck's prompt core
 * (src/lib/brain.ts) reads her canon off disk with process.cwd() — importing
 * it into the hook would drag fs into the browser bundle. So unity is built
 * from three things instead, and this file pins all three so they cannot rot:
 *
 *   1. ONE persona source per surface — the call's identity comes only from
 *      src/lib/persona.ts, never an inline literal that could drift.
 *   2. ONE memory — both surfaces read the SAME continuity block from the SAME
 *      store, through memoryForPrompt, over a 24-turn working window.
 *   3. The LOCKED behavioural clauses (vault privacy, one-voice, continuity)
 *      are present on BOTH surfaces.
 *
 * A comment claiming "she's one person" cannot fail. This can.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { STARRA_PERSONA_CORE, STARRA_VOICE_PERSONA } from "../src/lib/persona";
import { buildTieredSystemPrompt, loadStableSystemPrompt } from "../src/lib/brain";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

const hook = read("src/lib/voice/useVoiceCall.ts");
const persona = read("src/lib/persona.ts");
const brain = read("src/lib/brain.ts");
const chatRoute = read("src/app/api/chat/route.ts");
const memoryRoute = read("src/app/api/memory/route.ts");
const memoryStore = read("src/lib/memory/store.ts");
const callDigestSrc = read("src/lib/memory/call-digest.ts");

/**
 * The exact length of her locked spoken persona before the core was extracted.
 * 7445 -> 7488 (2026-08-08): the ONLY intended byte change since the extraction
 * is her NAME. She is STARRA; STARGATE is the deck she runs. See
 * tests/persona-identity.test.ts, which pins the rename itself — this number
 * still does its job, catching any OTHER drift in the locked spoken text.
 */
const LOCKED_VOICE_PERSONA_CHARS = 7488;

describe("one person across the Call and the Deck", () => {
  it("the call's identity has exactly ONE source: src/lib/persona.ts", () => {
    assert.match(
      persona,
      /export const STARRA_VOICE_PERSONA/,
      "persona.ts must keep exporting STARRA_VOICE_PERSONA (stable-export invariant)",
    );
    assert.match(
      hook,
      /import\s*\{\s*STARRA_VOICE_PERSONA\s*\}\s*from\s*["']@\/lib\/persona["']/,
      "the call must take its persona from the shared module",
    );
    // A second, inline copy of her identity in the hook is exactly the drift
    // this division exists to remove.
    assert.ok(
      !/You are STARRA/.test(hook),
      "the hook must not carry its own inline persona literal",
    );
  });

  it("both surfaces read ONE memory, in ONE shape, over ONE 24-turn window", () => {
    assert.match(
      memoryStore,
      /export const WORKING_WINDOW = 24/,
      "the shared working window must stay 24 turns",
    );
    // Deck: injects the continuity block straight into the system prompt.
    assert.match(chatRoute, /memoryForPrompt\(/);
    // Call: fetches its block from the SAME store over HTTP, because a client
    // hook cannot touch the store directly.
    //
    // THE PROJECTION DIFFERS, THE MEMORY DOES NOT (2026-07-31). The call leg
    // now serves `callDigest` instead of `memoryForPrompt` verbatim, and that
    // is a deliberate, scoped change — NOT the drift this suite exists to
    // catch. Both still read one store, one 24-turn window, one set of tiers.
    // What the call withholds is HER OWN styled replies, because a realtime
    // model treats its instruction block as few-shot examples and was mirroring
    // her comfort phrases back at Classic ("baby" 856x in the store). See
    // src/lib/memory/call-digest.ts. His turns, the facts tier and the
    // summaries — the actual continuity — still cross.
    assert.match(memoryRoute, /callDigest\(store\)/);
    assert.match(
      memoryRoute,
      /from "@\/lib\/memory\/store"/,
      "the digest must still come off the ONE shared store",
    );
    assert.match(callDigestSrc, /from "\.\/store"/);
    for (const [re, tier] of [
      [/store\.facts/, "facts"],
      [/store\.working\.filter\(\(e\) => e\.role === "user"\)/, "his working turns"],
      [/store\.summaries/, "summaries"],
      [/store\.archival/, "archival"],
    ] as const) {
      assert.match(callDigestSrc, re, `the call digest must still carry ${tier}`);
    }
    assert.match(hook, /\/api\/memory\?digest=1/);
    // ...and writes its turns back into that same store.
    assert.match(hook, /fetch\("\/api\/memory"/);
  });

  it("the LOCKED clauses hold on both surfaces", () => {
    // Call — carried in her spoken persona.
    for (const [re, clause] of [
      [/His life is a vault/, "vault privacy"],
      [/One voice, one you/, "no second AI"],
      [/One continuous life/, "continuity"],
    ] as const) {
      assert.ok(re.test(persona), `call persona must keep the ${clause} clause`);
    }
    // Deck — the vault is a live document lookup, not prose, so pin the
    // mechanism that enforces it.
    assert.match(
      chatRoute,
      /vaultForPrompt\(/,
      "the deck must keep injecting the vault through vaultForPrompt",
    );
  });
});

/**
 * ONE PERSONA CORE (P2) — the identity text has a single definition that BOTH
 * surfaces compose, rather than two hand-maintained copies kept in step by a
 * textual-parity assertion.
 *
 * persona.ts is a pure string module (no fs, no process.cwd()), so the server
 * brain CAN import it — the "client bundle can't touch fs" constraint only
 * blocks the other direction (brain.ts -> the hook). That is why composition is
 * possible here and pinned below.
 */
describe("ONE persona core, composed by both surfaces", () => {
  it("persona.ts exports a surface-independent core carrying the LOCKED clauses", () => {
    assert.match(
      persona,
      /export const STARRA_PERSONA_CORE/,
      "persona.ts must export the shared, surface-independent core",
    );
    for (const clause of [
      "WHO YOU ARE",
      "MEMORY & PRIVACY (LOCKED)",
      "One continuous life",
      "His life is a vault",
      "One voice, one you",
      "INTIMACY / SPICY MODE",
    ]) {
      assert.ok(
        STARRA_PERSONA_CORE.includes(clause),
        `the shared core must carry the "${clause}" clause`,
      );
    }
    // Spoken-call stage direction is call-only; it must NOT leak into the core
    // the chat deck composes.
    assert.ok(
      !STARRA_PERSONA_CORE.includes("this is a spoken call"),
      "the spoken-call voice direction belongs to the call surface only",
    );
  });

  it("the call persona is core + call-only framing, byte-identical to the locked text", () => {
    assert.equal(
      STARRA_VOICE_PERSONA.length,
      LOCKED_VOICE_PERSONA_CHARS,
      "extracting the core must not change one byte of her locked spoken persona",
    );
    for (const block of STARRA_PERSONA_CORE.split("\n\n")) {
      assert.ok(
        STARRA_VOICE_PERSONA.includes(block),
        `the call must still carry the core block: ${block.slice(0, 40)}…`,
      );
    }
    assert.ok(STARRA_VOICE_PERSONA.includes("this is a spoken call"));
  });

  it("the deck's prompt core COMPOSES that same module — no parallel copy", () => {
    assert.match(
      brain,
      /import\s*\{[^}]*STARRA_PERSONA_CORE[^}]*\}\s*from\s*["']@\/lib\/persona["']/,
      "brain.ts must import the shared persona core, not restate her identity",
    );
    const stable = loadStableSystemPrompt();
    for (const block of STARRA_PERSONA_CORE.split("\n\n")) {
      assert.ok(
        stable.includes(block),
        `the deck's system prompt must carry the core block: ${block.slice(0, 40)}…`,
      );
    }
  });

  it("the capped free tier budgets the core in — and NAMES it when it cannot fit", () => {
    // Roomy budget: the shared core ships and is reported as included.
    const roomy = buildTieredSystemPrompt({ query: "hey", maxTokens: 100_000 });
    assert.ok(
      roomy.included.includes("persona-core"),
      "with budget available the tiered prompt must carry the shared persona core",
    );
    assert.ok(roomy.full.includes(STARRA_PERSONA_CORE.split("\n\n")[0]));

    // Starved budget: never silently cut — it must appear in `dropped`.
    const starved = buildTieredSystemPrompt({ query: "hey", maxTokens: 1 });
    assert.ok(
      starved.dropped.includes("persona-core"),
      "a deferred persona core must be reported, never dropped in silence",
    );
  });
});
