/**
 * STARRA Engine — secret masking / redaction. Pure, client-safe, no fs, no env.
 *
 * The single most important rule in the engine: a key value must never leave a
 * server module in plaintext — not in a GET payload, not in a log, not in an
 * error message. These tests assert that with realistically-shaped keys.
 *
 * Run: npx --yes tsx --test tests/*.test.ts   (package.json -> test:v2)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasKey,
  last4,
  maskKey,
  redactSecrets,
  redactUrl,
  safeErrorMessage,
} from "../src/lib/engine/redact";

// Realistically-shaped fakes — never real credentials.
const GROQ = "gsk_0OqkPvW3s7TnJ1mHbF4dQ8aZrY6xC2eL5uK9iG3wN7pS1vB0";
const XAI = "xai-9fK2mQ7tR4wL8sJ0nH5cV3bZ6yX1dG2eA7uP4iO9lT8rS6qW";
const REPLICATE = "r8_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9";
const HF = "hf_QwErTyUiOpAsDfGhJkLzXcVbNm1234567890";
const OPAQUE = "9d41c2b6f0a84e37bb5a7c1e8f206d3477e9ab52"; // no prefix at all

describe("engine redact — masking", () => {
  it("masks everything but the last 4 characters", () => {
    const masked = maskKey(GROQ);
    assert.equal(typeof masked, "string");
    assert.ok(masked!.endsWith(GROQ.slice(-4)), "keeps the last 4");
    assert.ok(!masked!.includes(GROQ.slice(0, 8)), "no leading plaintext");
    assert.ok(!masked!.includes(GROQ), "never the whole key");
  });

  it("does not leak key length through the mask", () => {
    const a = maskKey(GROQ)!;
    const b = maskKey(XAI.slice(0, 12) + "abcd")!;
    assert.equal(a.length, b.length, "mask width is fixed");
  });

  it("fully masks a value too short to safely show 4 characters", () => {
    const masked = maskKey("abcd")!;
    assert.ok(!masked.includes("abcd"));
    const tiny = maskKey("ab")!;
    assert.ok(!tiny.includes("ab"));
  });

  it("returns null for absent values instead of throwing", () => {
    assert.equal(maskKey(undefined), null);
    assert.equal(maskKey(null), null);
    assert.equal(maskKey(""), null);
    assert.equal(maskKey("   "), null);
    assert.equal(last4(undefined), null);
    assert.equal(last4(""), null);
    assert.equal(last4(GROQ), GROQ.slice(-4));
  });

  it("hasKey reports presence without revealing anything", () => {
    assert.equal(hasKey(GROQ), true);
    assert.equal(hasKey(""), false);
    assert.equal(hasKey("   "), false);
    assert.equal(hasKey(undefined), false);
  });
});

describe("engine redact — text scrubbing", () => {
  it("scrubs known secret VALUES, including opaque ones with no prefix", () => {
    const out = redactSecrets(`base=http://x/v1 token=${OPAQUE} ok`, [OPAQUE]);
    assert.ok(!out.includes(OPAQUE), out);
    assert.ok(out.includes("[REDACTED"), out);
  });

  it("scrubs provider key SHAPES even when the value list is empty", () => {
    const out = redactSecrets(
      `groq=${GROQ} xai=${XAI} rep=${REPLICATE} hf=${HF}`,
      [],
    );
    for (const k of [GROQ, XAI, REPLICATE, HF]) {
      assert.ok(!out.includes(k), `leaked ${k.slice(0, 6)}…`);
    }
  });

  it("scrubs Authorization headers", () => {
    const out = redactSecrets(`Authorization: Bearer ${GROQ}`, []);
    assert.ok(!out.includes(GROQ));
  });

  it("stringifies non-strings without throwing and still scrubs", () => {
    const out = redactSecrets({ nested: { key: GROQ } }, [GROQ]);
    assert.ok(!out.includes(GROQ), out);
    assert.equal(typeof redactSecrets(undefined, []), "string");
    assert.equal(typeof redactSecrets(null, []), "string");
    assert.equal(typeof redactSecrets(12, []), "string");
    // a circular object must not throw
    const circ: Record<string, unknown> = { a: 1 };
    circ.self = circ;
    assert.equal(typeof redactSecrets(circ, []), "string");
  });

  it("ignores empty / trivially short entries in the secret list", () => {
    const out = redactSecrets("hello world", ["", "  ", "a"]);
    assert.equal(out, "hello world");
  });
});

describe("engine redact — errors and URLs", () => {
  it("never lets a key survive an Error message", () => {
    const err = new Error(`probe failed for key ${GROQ} and ${OPAQUE}`);
    const msg = safeErrorMessage(err, [OPAQUE]);
    assert.ok(!msg.includes(GROQ), msg);
    assert.ok(!msg.includes(OPAQUE), msg);
  });

  it("handles thrown non-Errors of every shape without throwing", () => {
    assert.equal(typeof safeErrorMessage(`raw ${GROQ}`, []), "string");
    assert.ok(!safeErrorMessage(`raw ${GROQ}`, []).includes(GROQ));
    assert.equal(typeof safeErrorMessage(undefined, []), "string");
    assert.equal(typeof safeErrorMessage(null, []), "string");
    assert.equal(typeof safeErrorMessage({ code: 1 }, []), "string");
  });

  it("strips credentials out of a URL, query values included", () => {
    const out = redactUrl(`https://api.x.ai/v1/models?api_key=${XAI}&x=1`);
    assert.ok(!out.includes(XAI), out);
    assert.ok(out.includes("api.x.ai"), "keeps the host for diagnostics");
  });

  it("redactUrl tolerates a non-URL string", () => {
    assert.equal(typeof redactUrl("not a url"), "string");
  });
});
