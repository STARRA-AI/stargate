/**
 * WebAuthn passkey store + RP config for STARGATE.
 *
 * A passkey login is an ALTERNATIVE to the password: on a verified assertion the
 * route mints the SAME `starra_auth` cookie the password flow sets (see
 * src/lib/auth.ts makeToken), so it plugs straight into the existing middleware.
 * Registering a passkey is gated behind an existing password session — only
 * someone already logged in can add Touch ID / Face ID.
 *
 * Credentials live in data/passkeys.json (gitignored, never leaves the Mac).
 */
import fs from "fs";
import path from "path";

const STORE = path.join(process.cwd(), "data", "passkeys.json");

export const RP_NAME = "STARGATE";

export interface StoredPasskey {
  id: string; // base64url credential id
  publicKey: string; // base64url-encoded COSE public key
  counter: number;
  transports?: string[];
  label: string;
  createdAt: number;
}

export function loadPasskeys(): StoredPasskey[] {
  try {
    const raw = fs.readFileSync(STORE, "utf8");
    const list = JSON.parse(raw) as StoredPasskey[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function savePasskeys(list: StoredPasskey[]): void {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(list, null, 2));
}

/**
 * Derive the Relying Party ID + expected origin from the request. rpID is the
 * bare hostname (WebAuthn requires it match the origin's domain); origin is the
 * full scheme+host+port. Works on localhost (a secure context over plain HTTP);
 * a LAN/phone client needs HTTPS for passkeys (mkcert) — origin/rpID derive
 * automatically from wherever the request came from.
 */
export function rpFromRequest(req: Request): { rpID: string; origin: string } {
  const origin =
    req.headers.get("origin") ||
    (req.headers.get("host") ? `http://${req.headers.get("host")}` : "http://localhost:3000");
  let rpID = "localhost";
  try {
    rpID = new URL(origin).hostname;
  } catch {
    /* keep localhost */
  }
  return { rpID, origin };
}

/**
 * WebAuthn forbids an IP address as the Relying Party ID — passkeys bind to
 * hostnames only. The deck is usually opened at http://127.0.0.1:3000 or the
 * LAN IP, where credentials.create() throws a SecurityError before the browser
 * ever shows the Touch ID sheet. Returns the operator-facing reason if this
 * rpID can never work, or null if it's usable.
 */
export function passkeyBlocker(rpID: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rpID) || rpID.includes(":")) {
    return "Touch ID can't bind to an IP address. Open the deck at http://localhost:3000 — same deck, same login — and set it up there.";
  }
  return null;
}

// COSE public key is a Uint8Array on the wire; store/restore as base64url.
export function pubKeyToStore(publicKey: Uint8Array): string {
  return Buffer.from(publicKey).toString("base64url");
}
export function pubKeyFromStore(stored: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(stored, "base64url");
  // Fresh ArrayBuffer-backed array (not Buffer's pooled ArrayBufferLike) so the
  // type matches @simplewebauthn's Uint8Array<ArrayBuffer> expectation.
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}
