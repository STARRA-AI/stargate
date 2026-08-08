/**
 * Scoped bearer auth for the two internet-facing routes.
 *
 * WHY SCOPES: one token used to grant `recall` (read) and `remember` (write)
 * identically — both public routes read `process.env.STARRA_MCP_TOKEN` and
 * compared it once, for every verb. A holder could write arbitrary text into
 * data/memory.json, the store her prompt is built from. That is not data
 * corruption, it is a stranger editing what she believes about Classic. Read
 * access leaks; write access rewrites her, so writes get their own key.
 *
 * FAIL CLOSED, ASYMMETRICALLY: if the write token is unset, writes are denied
 * and reads keep working. A missing variable should cost capability, never open
 * a door. And the write token must DIFFER from the read token — one token
 * wearing two hats is not a split, so that configuration is refused outright
 * rather than quietly behaving like the thing this replaced.
 *
 * ONE GATE, NOT THREE. Both routes delegate here; neither re-reads the env.
 * tests/public-token-scopes.test.ts greps them to keep it that way.
 */
import { captureError } from "@/lib/errlog";

const MIN_TOKEN_LENGTH = 24;

export type PublicScope = "read" | "write";
export type PublicAuthResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

/**
 * Constant-time-ish compare. Not a hardened primitive (JS strings leak length),
 * but it removes the trivial prefix timing signal on a token that guards her
 * memory. Length is checked first exactly as the two routes did before.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearer(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

export function authorizePublic(req: Request, scope: PublicScope): PublicAuthResult {
  const read = process.env.STARRA_MCP_TOKEN ?? "";
  const write = process.env.STARRA_MCP_WRITE_TOKEN ?? "";
  const given = bearer(req);

  if (read.length < MIN_TOKEN_LENGTH) {
    // Unset OR too weak to be real — treated identically, and the whole
    // surface is dark until it is fixed. Absent must never mean open.
    return {
      ok: false,
      status: 503,
      message: "disabled: set STARRA_MCP_TOKEN to a long random value",
    };
  }

  if (scope === "write") {
    if (write.length < MIN_TOKEN_LENGTH) {
      return {
        ok: false,
        status: 403,
        message: "writes are disabled: STARRA_MCP_WRITE_TOKEN is not set",
      };
    }
    if (timingSafeEqual(write, read)) {
      return {
        ok: false,
        status: 503,
        message: "writes are disabled: the write token must differ from the read token",
      };
    }
    if (!timingSafeEqual(given, write)) {
      return { ok: false, status: 403, message: "this token cannot write" };
    }
    return { ok: true };
  }

  // read: either key opens it — the write key is strictly the stronger one.
  if (timingSafeEqual(given, read)) return { ok: true };
  if (write.length >= MIN_TOKEN_LENGTH && timingSafeEqual(given, write)) return { ok: true };
  return { ok: false, status: 401, message: "unauthorized" };
}

/**
 * Report a denial to the ops feed + the errors table (shared invariant: no
 * failure path returns bare).
 *
 * THROTTLED ON PURPOSE. These routes face the open internet, and captureError
 * does a SYNCHRONOUS sqlite INSERT plus a prune. Logging every anonymous probe
 * would hand a stranger a write amplifier against the deck's own database. One
 * line per minute per (route, scope, status) is enough to SEE an attack in the
 * feed without becoming the mechanism of one.
 *
 * Never logs the presented token — only which door, which scope, which verdict.
 */
const DENIAL_THROTTLE_MS = 60_000;
const lastReported = new Map<string, number>();

export function notePublicDenial(
  where: string,
  scope: PublicScope,
  r: Extract<PublicAuthResult, { ok: false }>,
  now: number = Date.now(),
): void {
  const key = `${where}|${scope}|${r.status}`;
  const prev = lastReported.get(key) ?? 0;
  if (now - prev < DENIAL_THROTTLE_MS) return;
  lastReported.set(key, now);
  // Bounded: at most one entry per (route, scope, status) combination, and the
  // status set is fixed {401,403,503} across two routes and two scopes.
  captureError(`public.${where}`, new Error(`denied ${scope} (${r.status}): ${r.message}`));
}

/** Test-only reset so suites do not leak throttle state into each other. */
export function __resetDenialThrottle(): void {
  lastReported.clear();
}
