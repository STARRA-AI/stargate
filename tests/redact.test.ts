/**
 * Phase 1A — secret redaction.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

describe("redact", () => {
  let redact: (text: string, maxLen?: number) => string;

  before(async () => {
    process.env.ANTHROPIC_API_KEY = "weird-format-key-98765";
    ({ redact } = await import("../src/lib/security/redact"));
  });

  it("scrubs anthropic and openai keys", () => {
    const s = redact(
      "my key is sk-ant-api03-AbCdEf0123456789AbCdEf0123456789AbCd and sk-AbCdEf0123456789AbCdEf0123456789AbCd",
    );
    assert.ok(!s.includes("sk-ant"));
    assert.ok(!s.includes("sk-AbCdEf"));
    assert.ok(s.includes("[REDACTED"));
  });

  it("scrubs aws and github", () => {
    const s = redact(
      "AKIAIOSFODNN7EXAMPLE and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    );
    assert.ok(!s.includes("AKIA"));
    assert.ok(!s.includes("ghp_"));
  });

  it("scrubs email and card", () => {
    const s = redact("mail silentshadowauth@proton.me card 4111 1111 1111 1111");
    assert.ok(!s.includes("@proton.me"));
    assert.ok(!s.includes("4111"));
  });

  it("scrubs keyword-anchored secrets", () => {
    const s = redact(
      "password=hunter2 api_key: abc123XYZ token = deadbeefcafe",
    );
    assert.ok(!s.includes("hunter2"));
    assert.ok(!s.includes("abc123XYZ"));
    assert.ok(!s.includes("deadbeefcafe"));
  });

  it("scrubs jwt and bearer", () => {
    const s = redact(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
    );
    assert.ok(!s.includes("eyJ"));
  });

  it("leaves plain operator text untouched", () => {
    const plain = "Schedule the Silent Shadow post for Thursday at 9am.";
    assert.equal(redact(plain), plain);
  });

  it("scrubs live env secret values", () => {
    const s = redact("the key is weird-format-key-98765 ok");
    assert.ok(!s.includes("weird-format-key-98765"));
  });
});
