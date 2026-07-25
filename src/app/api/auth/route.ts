import { NextResponse } from "next/server";
import {
  authPassword,
  authCookieName,
  checkPassword,
  makeToken,
} from "@/lib/auth";

// @/lib/auth uses cookies + crypto (HMAC token signing) — force the Node.js
// runtime so this never gets bundled for the Edge runtime (no node:crypto there).
export const runtime = "nodejs";

const MAX_AGE = 30 * 24 * 60 * 60; // 30 days, seconds

/** Status — is a password configured on the server? (drives the login copy) */
export async function GET() {
  return NextResponse.json({ configured: Boolean(authPassword()) });
}

/** Login — verify the password, set the signed session cookie. */
export async function POST(req: Request) {
  if (!authPassword()) {
    return NextResponse.json(
      { ok: false, error: "No password is set on the server (STARRA_PASSWORD)." },
      { status: 400 },
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
    return NextResponse.json({ ok: false, error: "Wrong password." }, { status: 401 });
  }

  const token = await makeToken();
  if (!token) {
    return NextResponse.json({ ok: false, error: "Auth unavailable." }, { status: 500 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(authCookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
    // no `secure` flag → works over plain HTTP on localhost/LAN too
  });
  return res;
}

/** Logout — clear the cookie. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(authCookieName(), "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
