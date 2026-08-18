import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { authCookieName, makeToken } from "@/lib/auth";
import {
  loadPasskeys,
  savePasskeys,
  rpFromRequest,
  passkeyBlocker,
  pubKeyFromStore,
  loginTransports,
} from "@/lib/webauthn";

export const runtime = "nodejs";

const CHALLENGE_COOKIE = "pk_login_chal";
const MAX_AGE = 30 * 24 * 60 * 60; // match the password session

/** GET → authentication options. 404 if no passkey is registered yet (client
 * then just shows the password form). */
export async function GET(req: Request) {
  const list = loadPasskeys();
  if (list.length === 0) {
    return NextResponse.json({ error: "no passkey registered" }, { status: 404 });
  }
  const { rpID } = rpFromRequest(req);
  const blocked = passkeyBlocker(rpID);
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 400 });
  }
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: list.map((p) => ({
      id: p.id,
      // NOT p.transports. A platform credential must never advertise hybrid,
      // or the browser offers the QR sheet before the fingerprint reader.
      transports: loginTransports(p) as AuthenticatorTransportFuture[] | undefined,
    })),
  });
  const res = NextResponse.json(options);
  res.cookies.set(CHALLENGE_COOKIE, options.challenge, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 300,
  });
  return res;
}

/** POST → verify the assertion; on success mint the SAME starra_auth cookie the
 * password flow uses, so the rest of the app is unchanged. */
export async function POST(req: Request) {
  const { rpID, origin } = rpFromRequest(req);
  const expectedChallenge = (await cookies()).get(CHALLENGE_COOKIE)?.value;
  if (!expectedChallenge) {
    return NextResponse.json({ ok: false, error: "no challenge" }, { status: 400 });
  }

  let body: AuthenticationResponseJSON;
  try {
    body = (await req.json()) as AuthenticationResponseJSON;
  } catch {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }

  const list = loadPasskeys();
  const stored = list.find((p) => p.id === body.id);
  if (!stored) {
    return NextResponse.json({ ok: false, error: "unknown passkey" }, { status: 400 });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: stored.id,
        publicKey: pubKeyFromStore(stored.publicKey),
        counter: stored.counter,
        transports: stored.transports as AuthenticatorTransportFuture[] | undefined,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "verify failed" },
      { status: 401 },
    );
  }

  if (!verification.verified) {
    return NextResponse.json({ ok: false, error: "not verified" }, { status: 401 });
  }

  // persist the replay counter
  stored.counter = verification.authenticationInfo.newCounter;
  savePasskeys(list);

  const token = await makeToken();
  if (!token) {
    return NextResponse.json({ ok: false, error: "auth unavailable" }, { status: 500 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(authCookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
  res.cookies.set(CHALLENGE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
