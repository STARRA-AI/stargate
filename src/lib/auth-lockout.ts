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
 *
 * 2026-08-07 — TWO HOLES CLOSED, both on the PUBLIC TUNNEL path:
 *
 *   A. IDENTITY WAS CLIENT-CONTROLLED. `clientKey` trusted `X-Forwarded-For`
 *      unconditionally and keyed the budget on it. Nothing between the attacker
 *      and this function sets that header authoritatively — Cloudflare APPENDS
 *      to XFF and the client-supplied value stays FIRST, which is exactly the
 *      element that was read. So a stranger could send a new `X-Forwarded-For`
 *      per request, land in a fresh bucket every time, and never be locked out:
 *      unlimited password guesses from the open internet, with the lockout
 *      code running and reporting "not locked" the whole way. Default is now
 *      ONE SHARED BUDGET for every non-local caller — no header a client can
 *      write may mint a new one. Set `STARRA_TRUST_PROXY=1` only when a proxy
 *      you control is the ONLY way in, and per-IP budgets come back.
 *   B. THE LOOPBACK EXEMPTION IGNORED THE REST OF THE REQUEST. A request that
 *      claims `Host: 127.0.0.1` while ALSO carrying proxy/CDN headers did not
 *      arrive on the loopback interface — something forwarded it. Such a
 *      request is no longer exempt (`isLocalCaller`).
 *
 * `isLocalRequest(host)` keeps its exact old signature and meaning, because
 * src/app/api/chat/route.ts:761 and the private lane import it for a different
 * decision (tests/private-lane.test.ts:797 pins that import). The stricter,
 * header-aware check is a NEW function used only by this lockout.
 *
 * REMAINING RESIDUAL, not papered over: an attacker with DIRECT access to the
 * deck's port who sends `Host: 127.0.0.1` and no other headers is still exempt.
 * That path is the LAN, not the internet, and closing it would require an
 * unforgeable identity Next.js does not expose to a route handler
 * (`NextRequest.ip` was removed in Next 15).
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
 * Headers that only appear when something FORWARDED the request. Any of them
 * means the request did not arrive on the loopback interface, whatever the Host
 * header claims. (Cloudflare's tunnel sets cf-connecting-ip / cf-ray; ordinary
 * reverse proxies set the x-forwarded-* family.)
 */
const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "cf-ray",
  "true-client-ip",
] as const;

/**
 * Is this caller REALLY the Mac itself? Loopback Host and nothing that betrays
 * a hop in front of it. Stricter than `isLocalRequest` on purpose — see hole B
 * in the file header. Can only ever REMOVE an exemption, never grant one, so
 * the "loopback is never locked" guarantee is untouched for a genuine local
 * request (a browser on this machine sends none of these headers).
 */
export function isLocalCaller(headers: Headers): boolean {
  if (!isLocalRequest(headers.get("host"))) return false;
  for (const name of FORWARDING_HEADERS) {
    if ((headers.get(name) ?? "").trim()) return false;
  }
  return true;
}

/** Is a proxy we control the only way in? Off unless explicitly turned on. */
function trustProxyHeaders(): boolean {
  return (process.env.STARRA_TRUST_PROXY ?? "") === "1";
}

/**
 * Budget identity for a non-local caller.
 *
 * Next.js self-hosted does not expose the socket address to a route handler
 * (`NextRequest.ip` was removed in Next 15), so the only candidate identities
 * are headers — and a header the CLIENT can write is not an identity, it is a
 * request for a fresh budget. By default every non-local caller therefore
 * shares ONE "lan" bucket: strictly stricter, and impossible to escape by
 * rotating a header. Loopback never reaches here (it is exempt), so the shared
 * bucket can never strand Classic on his own machine.
 *
 * `STARRA_TRUST_PROXY=1` restores per-IP budgets, and is correct ONLY when a
 * proxy you control terminates every connection and overwrites these headers.
 */
export function clientKey(headers: Headers): string {
  if (!trustProxyHeaders()) return "lan";
  const cf = headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return `ip:${cf.trim()}`;
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
  if (isLocalCaller(headers)) return { locked: false, retryAfterSec: 0 };
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
  if (isLocalCaller(headers)) return { locked: false, retryAfterSec: 0 };
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
