/**
 * Login brute-force lockout for the deck's password gate.
 *
 * WHY THIS EXISTS. Verified 2026-07-29: `src/app/api/auth/route.ts` had NO rate
 * limiting, no attempt counter and no lockout of any kind, while the deck binds
 * 0.0.0.0 by default (`scripts/starra:69`) and answers on the Wi-Fi — confirmed
 * live, `http://192.168.1.65:3000/login` returned 200 from the LAN. That is an
 * unlimited-guess oracle against a single shared password, reachable by anyone on
 * the network. The password itself is strong-ish and compared in constant time
 * (`src/lib/auth.ts:27-32`), but "unlimited attempts" is the actual hole.
 *
 * SAFE BY CONSTRUCTION — it must be impossible for this file to lock Classic out
 * of his own machine. Three independent guarantees:
 *
 *   1. LOOPBACK IS NEVER LOCKED. Requests whose Host is localhost / 127.0.0.1 /
 *      [::1] are not counted and not blocked, ever. So the Mac itself always gets
 *      in — even while the LAN side is locked out mid-attack. This reuses the
 *      EXACT local-vs-LAN boundary the codebase already trusts for a more
 *      dangerous decision: disabling shell execution over the network
 *      (`src/app/api/chat/route.ts:264-272`, `src/app/api/avatar/stop/route.ts:11-17`).
 *   2. MEMORY ONLY. State lives in a module-scope Map. Nothing is persisted, so a
 *      dev-server restart clears every lock. A lockout can never become permanent.
 *   3. SELF-EXPIRING. Both the counting window and the lock expire on a timer, so
 *      it always unlocks itself with no intervention.
 *
 * HONEST LIMIT, stated rather than hidden: the Host header is client-supplied, so
 * an attacker on the LAN could send `Host: 127.0.0.1` to land in the exempt path.
 * This is defence in depth, not the primary control — the password and (once the
 * mkcert CA is trusted) HTTPS are. The tradeoff is deliberate: a lockout that
 * could strand Classic would be worse than one that a determined attacker can
 * sidestep, and Host-spoofing does not by itself reveal the password.
 */

/** Failures allowed from one identity inside WINDOW_MS before the lock trips. */
const MAX_FAILS = 8;
/** Rolling window the failures must fall inside (ms). */
const WINDOW_MS = 10 * 60 * 1000;
/** How long a tripped lock lasts (ms). */
const LOCK_MS = 15 * 60 * 1000;
/** Hard cap on tracked identities, so this can never grow without bound. */
const MAX_TRACKED = 512;

type Bucket = { fails: number; firstAt: number; lockedUntil: number };

const buckets = new Map<string, Bucket>();

/**
 * Is this request coming from the Mac itself rather than over the network?
 *
 * Copied deliberately from the established idiom at
 * `src/app/api/chat/route.ts:264-272` so the two cannot drift apart. An empty Host
 * counts as local, matching that precedent.
 */
export function isLocalRequest(host: string | null | undefined): boolean {
  const h = (host || "").toLowerCase();
  return (
    h === "" ||
    h.startsWith("localhost") ||
    h.startsWith("127.0.0.1") ||
    h.startsWith("[::1]") ||
    h.startsWith("::1")
  );
}

/**
 * Best-effort identity for a non-local caller.
 *
 * Next.js self-hosted does not expose the socket address to a route handler
 * (`NextRequest.ip` was removed in Next 15), and a direct LAN connection sets no
 * forwarding header. So: prefer a real forwarded IP when one exists, otherwise
 * fall back to ONE shared "lan" bucket. The shared bucket is the conservative
 * choice — it means many attackers share one budget, which is stricter, not
 * looser. Only loopback escapes it, and loopback is exempt anyway.
 */
export function clientKey(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return `ip:${first}`;
  }
  const real = headers.get("x-real-ip");
  if (real && real.trim()) return `ip:${real.trim()}`;
  return "lan";
}

/** Drop buckets whose window AND lock have both expired. */
function sweep(now: number): void {
  for (const [k, b] of buckets) {
    const windowDead = now - b.firstAt > WINDOW_MS;
    const lockDead = b.lockedUntil <= now;
    if (windowDead && lockDead) buckets.delete(k);
  }
}

/**
 * Hard-bound the map so a flood of spoofed X-Forwarded-For values cannot grow it
 * without limit. Called AFTER insertion — bounding before the insert let the size
 * reach MAX_TRACKED + 1, which a unit test caught. Oldest-seen entries go first;
 * attack traffic is what fills this, and the newest entry is the live caller.
 */
function bound(): void {
  if (buckets.size <= MAX_TRACKED) return;
  const ordered = [...buckets.entries()].sort((a, b) => a[1].firstAt - b[1].firstAt);
  for (const [k] of ordered.slice(0, buckets.size - MAX_TRACKED)) buckets.delete(k);
}

export type LockState = { locked: boolean; retryAfterSec: number };

/**
 * Is this caller currently locked out? Loopback is always `false`.
 * `now` is injectable so the behaviour is unit-testable without waiting.
 */
export function checkLockout(
  headers: Headers,
  now: number = Date.now(),
): LockState {
  if (isLocalRequest(headers.get("host"))) return { locked: false, retryAfterSec: 0 };
  sweep(now);
  const b = buckets.get(clientKey(headers));
  if (!b || b.lockedUntil <= now) return { locked: false, retryAfterSec: 0 };
  return {
    locked: true,
    retryAfterSec: Math.max(1, Math.ceil((b.lockedUntil - now) / 1000)),
  };
}

/**
 * Record one wrong password. Returns the resulting lock state so the caller can
 * answer 429 immediately on the attempt that trips it. Loopback is never counted.
 */
export function recordFailure(
  headers: Headers,
  now: number = Date.now(),
): LockState {
  if (isLocalRequest(headers.get("host"))) return { locked: false, retryAfterSec: 0 };
  sweep(now);
  const key = clientKey(headers);
  const b = buckets.get(key);
  if (!b || now - b.firstAt > WINDOW_MS) {
    // Fresh window.
    buckets.set(key, { fails: 1, firstAt: now, lockedUntil: 0 });
    bound();
    return { locked: false, retryAfterSec: 0 };
  }
  b.fails += 1;
  if (b.fails >= MAX_FAILS) {
    b.lockedUntil = now + LOCK_MS;
    b.fails = 0;
    b.firstAt = now;
    return { locked: true, retryAfterSec: Math.ceil(LOCK_MS / 1000) };
  }
  return { locked: false, retryAfterSec: 0 };
}

/** A correct password clears the caller's record entirely. */
export function recordSuccess(headers: Headers): void {
  buckets.delete(clientKey(headers));
}

/** Test-only reset so suites do not leak state into each other. */
export function __resetLockout(): void {
  buckets.clear();
}

/** Introspection for diagnostics/tests. Never exposed to the browser. */
export function lockoutSize(): number {
  return buckets.size;
}
