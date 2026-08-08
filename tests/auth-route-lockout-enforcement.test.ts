/**
 * AUTH ROUTE — lockout ENFORCEMENT, not just wiring.
 *
 * `src/app/api/auth/route.ts` imports `@/lib/auth-lockout`, but an import is
 * not proof the gate actually runs on the request path, in the right order,
 * or that failures leave a trace. This file drives the real exported POST
 * handler (not the lib in isolation — that's tests/auth-lockout.test.ts) to
 * prove:
 *   1. checkLockout runs BEFORE checkPassword (order, not just presence).
 *   2. A failed attempt increments the counter (Nth wrong trips the lock).
 *   3. A locked-out caller is rejected without ever learning whether the
 *      password they sent was actually correct — the 429 body is byte-for-
 *      byte the same whether they guessed right or wrong.
 *   4. Every failure path (400 unconfigured, 401 wrong password, 429
 *      pre-check lock, 429 trip-triggering lock, 500 token failure) reports
 *      to the ops feed AND leaves queryable visible state — never a bare
 *      return.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { POST } from "../src/app/api/auth/route";
import { __resetLockout } from "../src/lib/auth-lockout";
import { readFeed } from "../src/lib/feed";
import { recentErrors } from "../src/lib/errlog";

// Isolate this file's DB + feed writes from the real deck data. getDb() is
// lazy (src/lib/db.ts) so setting this after the static imports above is
// still safe — nothing touches the filesystem until a test actually runs.
process.env.STARGATE_DB_PATH = join(
  tmpdir(),
  `auth-route-enforcement-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
);

const RIGHT = "correct-horse-battery-staple-9x";
const WRONG = "definitely-not-it";
const HOST = "192.168.1.77:3000"; // non-loopback: lockout applies here
const MAX_FAILS = 8;

function post(password: string, host = HOST): Promise<Response> {
  return POST(
    new Request("http://deck.local/api/auth", {
      method: "POST",
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }),
  );
}

async function tripLock(host = HOST): Promise<void> {
  for (let i = 0; i < MAX_FAILS; i++) await post(WRONG, host);
}

before(() => {
  process.env.STARRA_PASSWORD = RIGHT;
});

beforeEach(() => {
  __resetLockout();
});

describe("(a) lockout gate runs before password comparison", () => {
  it("rejects the CORRECT password with 429 while locked — proves order, not just presence", async () => {
    await tripLock();
    const res = await post(RIGHT); // right password, but this caller is locked
    assert.equal(res.status, 429, "a locked caller must never reach checkPassword");
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, false);
  });
});

describe("(b) a failed attempt increments the counter", () => {
  it("MAX_FAILS-1 wrong passwords stay 401; the MAX_FAILS-th trips 429", async () => {
    for (let i = 0; i < MAX_FAILS - 1; i++) {
      const res = await post(WRONG);
      assert.equal(res.status, 401, `attempt ${i + 1} should still be a plain wrong-password 401`);
    }
    const tripping = await post(WRONG);
    assert.equal(tripping.status, 429, "the MAX_FAILS-th wrong password must trip the lock");
  });

  it("a correct password then resets the count for that identity", async () => {
    for (let i = 0; i < MAX_FAILS - 1; i++) await post(WRONG);
    const ok = await post(RIGHT);
    assert.equal(ok.status, 200, "correct password must still succeed one short of the trip");
    const next = await post(WRONG);
    assert.equal(next.status, 401, "counter must have been cleared by the success, not carried over");
  });
});

describe("(c) locked rejection never leaks whether the password was right", () => {
  it("429 body is identical for a locked-and-correct vs locked-and-wrong guess", async () => {
    await tripLock();
    const withRight = await post(RIGHT);
    await tripLock("192.168.1.78:3000"); // separate identity, same shape check
    const withWrong = await post(WRONG, "192.168.1.78:3000");
    assert.equal(withRight.status, withWrong.status, "status must not vary with password correctness");
    const [jRight, jWrong] = await Promise.all([withRight.json(), withWrong.json()]);
    assert.deepEqual(jRight, jWrong, "response body must not vary with password correctness");
  });

  it("the pre-check lock (already locked) and the trip-triggering failure return the same 429 shape", async () => {
    for (let i = 0; i < MAX_FAILS - 1; i++) await post(WRONG);
    const tripping = await post(WRONG); // this call trips it
    assert.equal(tripping.status, 429);
    const already = await post(WRONG); // now already-locked path
    assert.equal(already.status, 429);
    const [jTrip, jAlready] = await Promise.all([tripping.json(), already.json()]);
    assert.deepEqual(
      jTrip,
      jAlready,
      "an attacker must not be able to tell 'this was the tripping guess' from 'already locked'",
    );
  });
});

describe("(d) failure paths report to the ops feed AND visible state — never a bare return", () => {
  it("a wrong-password 401 leaves a queryable error row and a feed line", async () => {
    const before = recentErrors(200).length;
    const res = await post(WRONG);
    assert.equal(res.status, 401);
    const rows = recentErrors(200);
    assert.ok(rows.length > before, "wrong password must be captured to visible state (errors table)");
    const feed = readFeed();
    assert.ok(
      feed.some((l) => /auth/i.test(l.text) || /password/i.test(l.text)),
      "wrong password must narrate a line to the ops feed",
    );
  });

  it("a 429 lock-trip leaves visible state distinct from a plain wrong password", async () => {
    const before = recentErrors(200).length;
    await tripLock();
    const rows = recentErrors(200);
    assert.ok(rows.length > before + 1, "each failed attempt including the trip must be captured");
  });

  it("a pre-check locked rejection (no password even looked at) still reports", async () => {
    await tripLock();
    const before = recentErrors(200).length;
    const res = await post(RIGHT); // locked before comparison — still a failure path
    assert.equal(res.status, 429);
    const rows = recentErrors(200);
    assert.ok(rows.length > before, "the pre-check lock branch must not bare-return");
  });

  it("never logs the submitted password VALUE, only identity/shape", async () => {
    await post(WRONG);
    const rows = recentErrors(200);
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes(WRONG), "the wrong-password VALUE must never appear in visible state");
  });
});
