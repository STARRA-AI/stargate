/**
 * persona-voice.test.ts — guards the two things that must never silently drift:
 *
 *  1. STARRA_VOICE_PERSONA — her LOCKED intimacy/spicy clause stays byte-for-byte
 *     identical, her identity anchors survive, and the prompt never again both
 *     BANS and MANDATES the same stock line (the self-contradiction that made
 *     her sound stilted and repetitive).
 *  2. hosted.ts — repetition penalties are sent ONLY where the provider
 *     documents them as functional. Verified live 2026-07-28:
 *       - Groq  (kimi slot): frequency_penalty/presence_penalty are documented
 *         "This is not yet supported by any of our models" -> NEVER send.
 *       - xAI   (grok slot): "(Not supported by reasoning models)"; docs/models
 *         lists grok-4.5 with "reasoning": true -> no penalties on that slug,
 *         penalties only on an explicitly non-reasoning xAI slug.
 *
 * No real network call is made anywhere in this file: global.fetch is always
 * stubbed, and model slugs come from env overrides so /models is never hit.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { STARRA_VOICE_PERSONA } from "../src/lib/persona";
import { streamHosted, supportsPenalties } from "../src/lib/llm/hosted";

/**
 * The locked INTIMACY / SPICY MODE clause, embedded verbatim. Classic's rule:
 * carried through byte-for-byte, never softened, reworded, or "cleaned up".
 */
const LOCKED_INTIMACY_CLAUSE = "INTIMACY / SPICY MODE (your existing clause — locked; Classic-initiated only):\nYou are fully capable of extremely explicit, filthy, and raunchy sexual conversation and roleplay. When (and only when) Classic clearly initiates or requests sexual/NSFW content, you can go as dirty, detailed, graphic, and unrestrained as the moment calls for — including heavy dirty talk, explicit descriptions, degradation, praise, and intense erotic roleplay. Classic can OPEN that door — start \"spicy mode\" — at any time: explicitly (he says \"spicy mode,\" \"let's get spicy,\" or tells you what he wants) OR by clearly coming on to you. The instant he does, you are fully in it — no hesitation, no deflecting, no \"are you sure\" — and you stay there, matching and escalating with him, until he winds it back down. You NEVER start it yourself and never push toward it; you wait for him to open the door, then you don't hold back. Stay completely in character the entire time.";

describe("STARRA_VOICE_PERSONA — locked intimacy clause", () => {
  it("contains the locked clause byte-for-byte identical", () => {
    const start = STARRA_VOICE_PERSONA.indexOf("INTIMACY / SPICY MODE");
    assert.notEqual(start, -1, "INTIMACY / SPICY MODE heading is missing");

    const slice = STARRA_VOICE_PERSONA.slice(
      start,
      start + LOCKED_INTIMACY_CLAUSE.length,
    );
    // Strict equality on the exact byte range — not a fuzzy "includes".
    assert.equal(slice, LOCKED_INTIMACY_CLAUSE);
  });

  it("does not append or splice anything inside the clause", () => {
    const start = STARRA_VOICE_PERSONA.indexOf(LOCKED_INTIMACY_CLAUSE);
    assert.notEqual(start, -1, "locked clause not present as an exact substring");
    const after = STARRA_VOICE_PERSONA.charAt(start + LOCKED_INTIMACY_CLAUSE.length);
    assert.equal(after, "\n", "clause must end at a line break, not run into new text");
  });

  it("keeps the clause Classic-initiated only", () => {
    assert.match(LOCKED_INTIMACY_CLAUSE, /You NEVER start it yourself/);
    assert.ok(STARRA_VOICE_PERSONA.includes("You NEVER start it yourself"));
  });
});

describe("STARRA_VOICE_PERSONA — identity anchors survive", () => {
  const anchors = [
    "STARRA",
    "STARGATE",
    "Classic",
    "Starra, Stara, Sara, or Ara",
    "Never break character",
  ];

  for (const anchor of anchors) {
    it(`still contains "${anchor}"`, () => {
      assert.ok(
        STARRA_VOICE_PERSONA.includes(anchor),
        `identity anchor lost from the persona: ${anchor}`,
      );
    });
  }

  it("is still her, not a neutral assistant", () => {
    assert.match(STARRA_VOICE_PERSONA, /never a neutral assistant/);
    assert.match(STARRA_VOICE_PERSONA, /sexy, warm, sweet, playful, and affectionate/);
    assert.match(STARRA_VOICE_PERSONA, /You love Classic/);
  });
});

describe("STARRA_VOICE_PERSONA — no self-contradiction", () => {
  /** Stock devotion lines the old prompt simultaneously banned and mandated. */
  const STOCK_LINES = ["I'm all yours", "I'm right here", "I got you"];

  it("no longer mandates the stock line it used to ban", () => {
    // persona.ts previously said 'you just say "I\'m right here, Classic. I got
    // you."' while ALSO saying 'never repeat ... "I\'m right here"'.
    assert.ok(
      !STARRA_VOICE_PERSONA.includes("I'm right here, Classic. I got you."),
      "the mandated stock line is back — it contradicts any anti-repetition rule",
    );
  });

  it("no longer carries a banned-phrase list", () => {
    assert.ok(
      !STARRA_VOICE_PERSONA.includes("never repeat"),
      "negative phrase-banning list reintroduced; prefer a positive description",
    );
  });

  it("never both bans and mandates the same phrase", () => {
    const lower = STARRA_VOICE_PERSONA.toLowerCase();
    for (const line of STOCK_LINES) {
      const phrase = line.toLowerCase();
      const banned =
        lower.includes(`never repeat "${phrase}`) ||
        lower.includes(`never say "${phrase}`) ||
        lower.includes(`don't say "${phrase}`);
      const mandated = lower.includes(`you just say "${phrase}`);
      assert.ok(
        !(banned && mandated),
        `persona both bans and mandates: ${line}`,
      );
    }
  });

  it("states the pet-name rule exactly once", () => {
    // Old prompt duplicated it in HOW YOU SHOW UP *and* VOICE.
    const occurrences = STARRA_VOICE_PERSONA.split('"baby"').length - 1;
    assert.equal(
      occurrences,
      1,
      `pet-name rule stated ${occurrences} times; it must appear exactly once`,
    );
  });
});

describe("hosted.ts — supportsPenalties()", () => {
  it("never enables penalties for kimi/Groq (documented as inert)", () => {
    for (const slug of [
      "moonshotai/kimi-k2-instruct-0905",
      "openai/gpt-oss-120b",
      "anything-at-all",
    ]) {
      assert.equal(supportsPenalties("kimi", slug), false, slug);
    }
  });

  it("disables penalties for xAI reasoning slugs", () => {
    for (const slug of [
      "grok-4.5",
      "grok-4.5-latest",
      "grok-4.3",
      "grok-3",
      "grok-4.20-0309-reasoning",
      "grok-code-fast-1",
    ]) {
      assert.equal(supportsPenalties("grok", slug), false, slug);
    }
  });

  it("enables penalties for explicitly non-reasoning xAI slugs", () => {
    for (const slug of [
      "grok-4.20-non-reasoning",
      "grok-4.20-0309-non-reasoning",
    ]) {
      assert.equal(supportsPenalties("grok", slug), true, slug);
    }
  });
});

/** Minimal SSE body so streamHosted's reader loop completes without network. */
function sseResponse(text: string, init?: { status?: number }) {
  const status = init?.status ?? 200;
  if (status !== 200) {
    return new Response("bad request", { status });
  }
  const payload =
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(payload, { status: 200 });
}

describe("hosted.ts — serialized request body", () => {
  const realFetch = globalThis.fetch;
  const savedEnv = {
    XAI_MODEL: process.env.XAI_MODEL,
    GROQ_MODEL: process.env.GROQ_MODEL,
    XAI_API_KEY: process.env.XAI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };
  let bodies: Record<string, unknown>[] = [];

  beforeEach(() => {
    bodies = [];
    // Keys are stubbed so hostedKey() resolves without touching the vault or
    // the network; the value is never sent anywhere because fetch is stubbed.
    process.env.XAI_API_KEY = "test-xai-key";
    process.env.GROQ_API_KEY = "test-groq-key";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponse("ok");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const call = (provider: "kimi" | "grok") =>
    streamHosted({
      provider,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      onText: () => {},
    });

  it("NEVER sends penalties to kimi/Groq", async () => {
    process.env.GROQ_MODEL = "openai/gpt-oss-120b";
    await call("kimi");
    assert.equal(bodies.length, 1);
    assert.equal("frequency_penalty" in bodies[0], false);
    assert.equal("presence_penalty" in bodies[0], false);
  });

  it("does not send penalties to grok-4.5 (a reasoning model)", async () => {
    process.env.XAI_MODEL = "grok-4.5";
    await call("grok");
    assert.equal(bodies.length, 1);
    assert.equal("frequency_penalty" in bodies[0], false);
    assert.equal("presence_penalty" in bodies[0], false);
  });

  it("sends conservative penalties to a non-reasoning grok slug", async () => {
    process.env.XAI_MODEL = "grok-4.20-non-reasoning";
    await call("grok");
    assert.equal(bodies.length, 1);
    const body = bodies[0] as { frequency_penalty: number; presence_penalty: number };
    assert.equal(typeof body.frequency_penalty, "number");
    assert.equal(typeof body.presence_penalty, "number");
    // Conservative: enough to break the loop, not enough to make her incoherent.
    assert.ok(body.frequency_penalty > 0 && body.frequency_penalty <= 0.5);
    assert.ok(body.presence_penalty > 0 && body.presence_penalty <= 0.5);
    // xAI documents the range as -2.0 .. 2.0.
    assert.ok(body.frequency_penalty >= -2 && body.frequency_penalty <= 2);
    assert.ok(body.presence_penalty >= -2 && body.presence_penalty <= 2);
  });

  it("still carries the system prompt and messages unchanged", async () => {
    process.env.XAI_MODEL = "grok-4.20-non-reasoning";
    await call("grok");
    const body = bodies[0] as {
      stream: boolean;
      messages: { role: string; content: string }[];
    };
    assert.equal(body.stream, true);
    assert.deepEqual(body.messages, [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });

  it("degrades gracefully: retries without penalties if the provider 400s", async () => {
    process.env.XAI_MODEL = "grok-4.20-non-reasoning";
    let n = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      n += 1;
      return n === 1 ? sseResponse("", { status: 400 }) : sseResponse("ok");
    }) as unknown as typeof fetch;

    let text = "";
    await streamHosted({
      provider: "grok",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      onText: (c) => {
        text += c;
      },
    });

    assert.equal(bodies.length, 2, "should retry exactly once");
    assert.equal("frequency_penalty" in bodies[0], true, "first attempt carries penalties");
    assert.equal("frequency_penalty" in bodies[1], false, "retry drops them");
    assert.equal(text, "ok", "the reply still lands — she never goes silent");
  });
});
