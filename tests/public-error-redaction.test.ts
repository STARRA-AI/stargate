/**
 * PUBLIC ERROR TEXT — what a stranger on the internet is allowed to read.
 *
 * /api/mcp and /api/voice-tools are the only two routes reachable from outside
 * the house (middleware.ts:12 lists them public because xAI's servers cannot
 * hold Classic's session cookie). Both used to interpolate `String(err)`
 * straight into a response body. A filesystem error names absolute paths — and
 * therefore the machine and the operator; an upstream error can carry a
 * provider key. `redactSecrets` already existed and was used on the LLM lane
 * (src/lib/llm/hosted.ts:321,326,355); it was simply never applied here.
 *
 * These tests pin BOTH halves: the formatter is safe, and the routes actually
 * use it. The second half is a source grep on purpose — a leak here is
 * invisible at runtime, because the call still works. It just tells a stranger
 * where the file lives.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { safePublicError } from "../src/lib/api/public-errors";

describe("safePublicError — nothing internal reaches the internet", () => {
  it("strips absolute filesystem paths", () => {
    const out = safePublicError(
      new Error("ENOENT: /Users/starrallc/STARGATE/stargate/data/memory.json"),
    );
    assert.doesNotMatch(out, /\/Users\//, "an absolute path names the machine and the operator");
  });

  it("keeps the basename so the message is still diagnostic", () => {
    const out = safePublicError(new Error("ENOENT: /Users/starrallc/STARGATE/data/funding.json"));
    assert.match(out, /funding\.json/, "she should still be able to say WHAT failed");
  });

  it("strips anything shaped like a key", () => {
    for (const secret of [
      "xai-abc123def456ghi789jkl",
      "gsk_abc123def456ghi789",
      "sk-abc123def456ghi789",
      "r8_abc123def456ghi789xy",
      "hf_abc123def456ghi789xy",
    ]) {
      const out = safePublicError(new Error(`upstream rejected ${secret}`));
      assert.ok(!out.includes(secret), `leaked: ${secret}`);
    }
  });

  it("strips a bearer header that ended up inside a message", () => {
    const out = safePublicError(new Error("failed: Authorization: Bearer sup3r-s3cret-token-value-123456"));
    assert.ok(!out.includes("sup3r-s3cret-token-value-123456"), "a bearer token must never echo back");
  });

  it("never returns a stack trace", () => {
    const e = new Error("boom");
    assert.doesNotMatch(safePublicError(e), /\n\s+at /);
  });

  it("is bounded", () => {
    assert.ok(safePublicError(new Error("x".repeat(5000))).length <= 200);
  });

  it("honours a caller-supplied bound (the phone-call budget)", () => {
    assert.ok(safePublicError(new Error("y".repeat(5000)), { maxLen: 80 }).length <= 80);
  });

  it("still says something useful rather than nothing", () => {
    assert.ok(safePublicError(new Error("boom")).length > 0);
  });

  it("survives non-Error throws", () => {
    for (const v of [undefined, null, 42, { a: 1 }, "plain string"]) {
      assert.equal(typeof safePublicError(v), "string");
    }
  });

  it("never returns an empty string — a mute failure is still a failure", () => {
    for (const v of [new Error(""), "", "   "]) {
      assert.ok(safePublicError(v).length > 0);
    }
  });
});

describe("no public route returns raw error text", () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
  const PUBLIC_ROUTES = [
    "src/app/api/mcp/route.ts",
    "src/app/api/voice-tools/[action]/route.ts",
  ];

  for (const rel of PUBLIC_ROUTES) {
    it(`${rel} routes errors through safePublicError`, () => {
      const src = readFileSync(join(REPO, rel), "utf8");
      assert.match(src, /safePublicError\(/, "must use the safe formatter");
      assert.doesNotMatch(
        src,
        /`[^`]*\$\{String\(err\)/,
        "raw String(err) must never reach a response body",
      );
    });
  }
});
