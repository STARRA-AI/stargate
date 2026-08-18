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

/**
 * Resolved per call, not at module load, so a test can redirect the whole store
 * with STARRA_DATA_DIR and never touch the real data/passkeys.json — which holds
 * the one credential that logs Classic in. Same convention the Dragon ticket
 * store uses.
 */
function storePath(): string {
  const dir = process.env.STARRA_DATA_DIR || path.join(process.cwd(), "data");
  return path.join(dir, "passkeys.json");
}

export const RP_NAME = "STARGATE";

export interface StoredPasskey {
  id: string; // base64url credential id
  publicKey: string; // base64url-encoded COSE public key
  counter: number;
  transports?: string[];
  /**
   * What the browser reported at registration. "platform" is Touch ID — the
   * authenticator built into this Mac. Absent on records written before
   * 2026-08-18, which is why loginTransports leaves those alone.
   */
  attachment?: "platform" | "cross-platform";
  label: string;
  createdAt: number;
}

export function loadPasskeys(): StoredPasskey[] {
  try {
    const raw = fs.readFileSync(storePath(), "utf8");
    const list = JSON.parse(raw) as StoredPasskey[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function savePasskeys(list: StoredPasskey[]): void {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(list, null, 2));
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
    (req.headers.get("host")
      ? `${new URL(req.url).protocol}//${req.headers.get("host")}`
      : "https://localhost:3000");
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
    return "Touch ID can't bind to an IP address. Open the deck at https://localhost:3000 — same deck, same login — and set it up there.";
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

/** The one sentence shown wherever a non-Touch-ID authenticator is refused. */
export const PLATFORM_ONLY_REASON =
  "That wasn't Touch ID — it was a phone or a security key. Pick \"This device\" on the sheet so the fingerprint reader on this Mac is what gets registered.";

/**
 * Transports that are safe to put in `allowCredentials` for this credential.
 *
 * `hybrid` means cross-device: the browser reads it as "this may live on a
 * phone" and offers the QR sheet. A credential we KNOW is platform-bound must
 * never carry it, or the Touch ID sheet is never the first thing he sees.
 *
 * A record with no recorded `attachment` predates this rule and is returned
 * unchanged — narrowing a credential we cannot vouch for could lock him out.
 */
const ROAMING_TRANSPORTS = new Set(["hybrid", "ble", "nfc", "usb", "cable"]);

export function loginTransports(p: StoredPasskey): string[] | undefined {
  if (p.attachment !== "platform" || !p.transports) return p.transports;
  const kept = p.transports.filter((t) => !ROAMING_TRANSPORTS.has(t));
  // An EMPTY array is a hint that nothing works; omitting the field lets the
  // browser decide. Never send [].
  return kept.length > 0 ? kept : undefined;
}

/**
 * THE THREE FIELDS THAT DECIDE WHICH SHEET APPEARS.
 *
 * Without `authenticatorAttachment: "platform"` the browser is free to offer
 * roaming authenticators — iCloud Keychain sync, phone-via-QR, a security key
 * — which is exactly the sheet Classic kept getting instead of Touch ID.
 * MDN: "platform" means "the authenticator is part of the device WebAuthn is
 * running on … a public key credential bound to a platform authenticator is
 * called a platform credential."
 *
 * `userVerification: "required"` makes the fingerprint mandatory; "preferred"
 * "will not fail if user verification cannot be performed" (MDN), i.e. a
 * passkey with no biometric, which is not the thing he asked for.
 */
export const PLATFORM_AUTHENTICATOR_SELECTION = {
  authenticatorAttachment: "platform",
  residentKey: "required",
  userVerification: "required",
} as const;

/** Remove one credential by id. Returns whether anything was actually removed. */
export function removePasskey(id: string): boolean {
  const list = loadPasskeys();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return false;
  savePasskeys(next);
  return true;
}
