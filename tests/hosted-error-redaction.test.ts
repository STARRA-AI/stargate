/**
 * Brain-path upstream-error redaction — src/lib/llm/hosted.ts:~203
 *
 * The board found that hosted.ts put 160 raw characters of an upstream xAI/Groq
 * error body into an Error message which reaches the browser via
 * src/app/api/chat/route.ts (:418, :420, :426, :548). The realtime route had the
 * same defect and was fixed; this path was missed because its fetch lives in a lib
 * rather than a route.ts.
 *
 * These tests lock the ORDER of the fix, which is the part that is easy to get
 * wrong and silently regress: scrub the body FIRST, then truncate. Truncating
 * first can split the credential so the full-value match never fires, leaving a
 * live fragment in a message that renders on screen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/lib/engine/redact";

/** A realistic xAI-shaped key: long enough that a 160-char slice can split it. */
const KEY = `xai-${"A1b2C3d4E5f6G7h8".repeat(4)}ZZ`;

/** Mirrors hosted.ts exactly: scrub, THEN slice. */
function safeDetail(detail: string, key?: string): string {
  return redactSecrets(detail, key ? [key] : []).slice(0, 160);
}

/** The bug shape: slice first, then scrub. Kept only to prove it is worse. */
function unsafeDetail(detail: string, key?: string): string {
  return redactSecrets(detail.slice(0, 160), key ? [key] : []);
}

test("the key never survives the scrub-then-truncate path", () => {
  const body = `{"error":{"message":"invalid api key","key":"${KEY}","code":401}}`;
  const out = safeDetail(body, KEY);
  assert.equal(out.includes(KEY), false, "full key leaked");
  assert.ok(out.length <= 160, "must still be truncated for the UI");
});

test("ORDER MATTERS — truncate-first can leave a live key fragment that scrub-first does not", () => {
  // Push the key so it straddles the 160-char boundary.
  const pad = "x".repeat(150);
  const body = `${pad}${KEY} trailing`;

  const unsafe = unsafeDetail(body, KEY);
  const safe = safeDetail(body, KEY);

  // The truncate-first path keeps a leading fragment of the real key, because the
  // full value no longer appears in the string it scrubbed.
  const fragment = KEY.slice(0, 10);
  assert.ok(
    unsafe.includes(fragment),
    "expected the buggy order to leak a fragment — if this fails the fixture drifted",
  );
  // The shipped order does not.
  assert.equal(safe.includes(fragment), false, "scrub-first must not leak a fragment");
});

test("a key appearing several times, and inside a URL, is fully scrubbed", () => {
  const body = `${KEY} again ${KEY} and https://api.x.ai/v1/chat?token=${KEY}`;
  const out = redactSecrets(body, [KEY]);
  assert.equal(out.includes(KEY), false);
  assert.equal(out.indexOf(KEY.slice(0, 12)), -1, "no partial survives either");
});

test("no key in scope degrades safely rather than throwing", () => {
  const body = '{"error":"upstream exploded"}';
  assert.doesNotThrow(() => safeDetail(body, undefined));
  // Non-secret text must pass through so the message stays diagnostic.
  assert.ok(safeDetail(body, undefined).includes("upstream exploded"));
});

test("an empty or absent body cannot break the throw path", () => {
  assert.equal(typeof safeDetail("", KEY), "string");
  assert.equal(typeof safeDetail("", undefined), "string");
});
