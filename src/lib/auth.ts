/**
 * Deck access auth — a single shared password gate for STARGATE.
 *
 * The password is `STARRA_PASSWORD` (server env, set in .env.local). It never
 * reaches the browser. On correct entry we set an HMAC-signed, httpOnly session
 * cookie; middleware verifies it on every request. Web Crypto only (no Node
 * APIs) so the same helpers run in Edge middleware AND Node route handlers.
 *
 * The gate is INACTIVE when STARRA_PASSWORD is unset — so the deck is never
 * locked with no way in; set the env var to turn protection on.
 */

const COOKIE = "starra_auth";
// 12 HOURS (was 30 days — Classic, 2026-07-30: "the sign in isn't coming
// up... fix that"). The cookie itself is now session-scoped (api/auth sets no
// maxAge), so closing the browser/dock app signs out immediately; this TTL is
// the hard ceiling even where a webview persists session cookies.
const TTL_MS = 12 * 60 * 60 * 1000;
const enc = new TextEncoder();

export function authPassword(): string | undefined {
  const p = process.env.STARRA_PASSWORD;
  return p && p.length > 0 ? p : undefined;
}

export function authCookieName(): string {
  return COOKIE;
}

/** Constant-time-ish string compare (length leak acceptable for a local app). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmacHex(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** True if the submitted password matches the configured one. */
export function checkPassword(input: string): boolean {
  const secret = authPassword();
  if (!secret) return false;
  return safeEqual(input, secret);
}

/** Token format version. Bumped v1→v2 with the 12h TTL (2026-07-30) ON
 *  PURPOSE: verifyToken accepts only the current version, so every cookie
 *  minted under the old 30-day rule died the moment this shipped — the login
 *  wall comes back for everyone immediately, no waiting out old tokens. */
const TOKEN_VERSION = "v2";

/** Mint a signed session token (v2.exp.hmac), keyed by the password itself. */
export async function makeToken(): Promise<string | null> {
  const secret = authPassword();
  if (!secret) return null;
  const payload = `${TOKEN_VERSION}.${Date.now() + TTL_MS}`;
  const sig = await hmacHex(payload, secret);
  return `${payload}.${sig}`;
}

/** Verify a session cookie value: current version + fresh + signature matches. */
export async function verifyToken(token: string | undefined): Promise<boolean> {
  const secret = authPassword();
  if (!secret || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return false;
  const [ver, exp, sig] = parts;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false;
  const expected = await hmacHex(`${ver}.${exp}`, secret);
  return safeEqual(sig, expected);
}
