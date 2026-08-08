import { NextResponse } from "next/server";
import {
  authPassword,
  authCookieName,
  checkPassword,
  makeToken,
} from "@/lib/auth";
import {
  checkLockout,
  clientKey,
  recordFailure,
  recordSuccess,
} from "@/lib/auth-lockout";
import { captureError } from "@/lib/errlog";

// @/lib/auth uses cookies + crypto (HMAC token signing) — force the Node.js
// runtime so this never gets bundled for the Edge runtime (no node:crypto there).
export const runtime = "nodejs";


/** Status — is a password configured on the server? (drives the login copy) */
export async function GET() {
  return NextResponse.json({ configured: Boolean(authPassword()) });
}

/** Login — verify the password, set the signed session cookie. */
export async function POST(req: Request) {
  if (!authPassword()) {
    captureError("auth.login", new Error("no password configured (STARRA_PASSWORD unset)"));
    return NextResponse.json(
      { ok: false, error: "No password is set on the server (STARRA_PASSWORD)." },
      { status: 400 },
    );
  }
  // Brute-force gate. The deck answers on the LAN (verified: 0.0.0.0 bind at
  // scripts/starra:69), and before this there was no attempt limit at all — an
  // unlimited-guess oracle for anyone on the Wi-Fi. Loopback is NEVER locked, so
  // this Mac always gets in; see src/lib/auth-lockout.ts for the three guarantees.
  const locked = checkLockout(req.headers);
  if (locked.locked) {
    captureError(
      "auth.login",
      new Error(`rejected: locked out, no password compared (${clientKey(req.headers)})`),
    );
    return NextResponse.json(
      {
        ok: false,
        error: "Too many wrong attempts from this network. Try again shortly.",
      },
      { status: 429, headers: { "Retry-After": String(locked.retryAfterSec) } },
    );
  }

  let password = "";
  try {
    const body = (await req.json()) as { password?: unknown };
    if (typeof body.password === "string") password = body.password;
  } catch {
    /* empty body → wrong password below */
  }

  if (!checkPassword(password)) {
    const tripped = recordFailure(req.headers);
    if (tripped.locked) {
      captureError(
        "auth.login",
        new Error(`locked out after repeated wrong passwords (${clientKey(req.headers)})`),
      );
      return NextResponse.json(
        {
          ok: false,
          error: "Too many wrong attempts from this network. Try again shortly.",
        },
        { status: 429, headers: { "Retry-After": String(tripped.retryAfterSec) } },
      );
    }
    captureError("auth.login", new Error(`wrong password (${clientKey(req.headers)})`));
    return NextResponse.json({ ok: false, error: "Wrong password." }, { status: 401 });
  }

  // Correct password clears this caller's failure record.
  recordSuccess(req.headers);

  const token = await makeToken();
  if (!token) {
    captureError("auth.login", new Error("token unavailable (auth misconfigured)"));
    return NextResponse.json({ ok: false, error: "Auth unavailable." }, { status: 500 });
  }
  const res = NextResponse.json({ ok: true });
  // SESSION cookie on purpose (no maxAge): the login wall comes back every
  // time the browser or dock app is reopened. The token's own 12h TTL
  // (lib/auth.ts) is the backstop for cookie stores that persist anyway.
  res.cookies.set(authCookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // `secure` is set ONLY when this request actually arrived over TLS. A hard
    // `secure: true` would break the default HTTP deck entirely (the browser
    // would refuse to store the cookie and login would silently never stick), so
    // it is conditional: turn on `STARRA_HTTPS=1` and the session cookie
    // immediately stops travelling in cleartext, with no other change needed.
    secure: isSecureRequest(req),
  });
  return res;
}

/**
 * Did this request arrive over TLS? Checks the URL scheme first, then the
 * forwarded header for the proxied case. Guarded so a malformed URL cannot throw
 * inside the login path — falling back to `false` keeps HTTP login working, which
 * is the safe direction to fail.
 */
function isSecureRequest(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto && proto.split(",")[0]?.trim().toLowerCase() === "https") return true;
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Logout — clear the cookie. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(authCookieName(), "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
