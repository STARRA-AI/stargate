/**
 * Login brute-force lockout — src/lib/auth-lockout.ts
 *
 * The load-bearing test in this file is "loopback can NEVER be locked out". If
 * that ever fails, the lockout could strand Classic on his own machine, which is
 * strictly worse than the brute-force hole it exists to close.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkLockout,
  recordFailure,
  recordSuccess,
  isLocalRequest,
  clientKey,
  lockoutSize,
  __resetLockout,
} from "../src/lib/auth-lockout";

const MAX_FAILS = 8;
const WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

function h(host: string, extra: Record<string, string> = {}): Headers {
  return new Headers({ host, ...extra });
}

test("isLocalRequest matches the precedent at api/chat/route.ts:264-272", () => {
  for (const local of [
    "",
    "localhost",
    "localhost:3000",
    "127.0.0.1",
    "127.0.0.1:3000",
    "[::1]:3000",
    "::1",
    "LOCALHOST:3000",
  ]) {
    assert.equal(isLocalRequest(local), true, `${local} should be local`);
  }
  for (const remote of ["192.168.1.65:3000", "10.0.0.4", "starra.local:3000"]) {
    assert.equal(isLocalRequest(remote), false, `${remote} should be remote`);
  }
  assert.equal(isLocalRequest(null), true, "absent host counts as local");
  assert.equal(isLocalRequest(undefined), true, "undefined host counts as local");
});

test("LOOPBACK IS NEVER LOCKED — even after far more failures than the threshold", () => {
  __resetLockout();
  const local = h("127.0.0.1:3000");
  for (let i = 0; i < MAX_FAILS * 5; i++) {
    const state = recordFailure(local);
    assert.equal(state.locked, false, `loopback tripped a lock on failure ${i + 1}`);
  }
  assert.equal(checkLockout(local).locked, false, "loopback must never read as locked");
  assert.equal(lockoutSize(), 0, "loopback failures must not be tracked at all");
});

test("loopback still gets in WHILE the LAN side is locked out", () => {
  __resetLockout();
  const lan = h("192.168.1.65:3000");
  for (let i = 0; i < MAX_FAILS; i++) recordFailure(lan);
  assert.equal(checkLockout(lan).locked, true, "LAN should be locked");
  // The whole point: the Mac is unaffected.
  assert.equal(checkLockout(h("127.0.0.1:3000")).locked, false);
  assert.equal(checkLockout(h("localhost:3000")).locked, false);
});

test("a LAN caller locks only after MAX_FAILS, not before", () => {
  __resetLockout();
  const lan = h("192.168.1.65:3000");
  for (let i = 0; i < MAX_FAILS - 1; i++) {
    assert.equal(recordFailure(lan).locked, false, `locked too early at ${i + 1}`);
  }
  const tripped = recordFailure(lan);
  assert.equal(tripped.locked, true, "should lock on the MAX_FAILS-th failure");
  assert.ok(tripped.retryAfterSec > 0, "must report a Retry-After");
});

test("the lock expires on its own", () => {
  __resetLockout();
  const lan = h("192.168.1.65:3000");
  const t0 = 1_000_000;
  for (let i = 0; i < MAX_FAILS; i++) recordFailure(lan, t0);
  assert.equal(checkLockout(lan, t0).locked, true);
  assert.equal(checkLockout(lan, t0 + LOCK_MS - 1).locked, true, "still locked just before expiry");
  assert.equal(checkLockout(lan, t0 + LOCK_MS + 1).locked, false, "must self-unlock");
});

test("failures outside the rolling window do not accumulate", () => {
  __resetLockout();
  const lan = h("192.168.1.65:3000");
  const t0 = 2_000_000;
  // MAX_FAILS-1 failures, then a long gap, then more — must not trip.
  for (let i = 0; i < MAX_FAILS - 1; i++) recordFailure(lan, t0);
  const later = t0 + WINDOW_MS + 1;
  for (let i = 0; i < MAX_FAILS - 1; i++) {
    assert.equal(
      recordFailure(lan, later + i).locked,
      false,
      "stale failures should have aged out",
    );
  }
});

test("a correct password clears the record", () => {
  __resetLockout();
  const lan = h("192.168.1.65:3000");
  for (let i = 0; i < MAX_FAILS - 1; i++) recordFailure(lan);
  recordSuccess(lan);
  // Back to a clean slate: one more failure must not trip the lock.
  assert.equal(recordFailure(lan).locked, false);
});

test("clientKey prefers a forwarded IP, then x-real-ip, then one shared bucket", () => {
  assert.equal(
    clientKey(h("192.168.1.65:3000", { "x-forwarded-for": "203.0.113.9, 10.0.0.1" })),
    "ip:203.0.113.9",
  );
  assert.equal(clientKey(h("192.168.1.65:3000", { "x-real-ip": "203.0.113.7" })), "ip:203.0.113.7");
  assert.equal(clientKey(h("192.168.1.65:3000")), "lan");
});

test("distinct forwarded IPs get independent budgets", () => {
  __resetLockout();
  const a = h("192.168.1.65:3000", { "x-forwarded-for": "203.0.113.1" });
  const b = h("192.168.1.65:3000", { "x-forwarded-for": "203.0.113.2" });
  for (let i = 0; i < MAX_FAILS; i++) recordFailure(a);
  assert.equal(checkLockout(a).locked, true, "attacker A locked");
  assert.equal(checkLockout(b).locked, false, "unrelated B must not be collateral");
});

test("tracked identities stay bounded under a flood", () => {
  __resetLockout();
  for (let i = 0; i < 2000; i++) {
    recordFailure(h("192.168.1.65:3000", { "x-forwarded-for": `198.51.100.${i % 255}.${i}` }));
  }
  assert.ok(lockoutSize() <= 512, `map grew unbounded: ${lockoutSize()}`);
});
