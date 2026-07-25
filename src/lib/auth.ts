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
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
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

/** Mint a signed session token (exp.hmac), keyed by the password itself. */
export async function makeToken(): Promise<string | null> {
  const secret = authPassword();
  if (!secret) return null;
  const exp = String(Date.now() + TTL_MS);
  const sig = await hmacHex(exp, secret);
  return `${exp}.${sig}`;
}

/** Verify a session cookie value: fresh + signature matches the password. */
export async function verifyToken(token: string | undefined): Promise<boolean> {
  const secret = authPassword();
  if (!secret || !token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false;
  const expected = await hmacHex(exp, secret);
  return safeEqual(sig, expected);
}
