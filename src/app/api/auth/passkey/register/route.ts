import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { RegistrationResponseJSON, AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { authCookieName, verifyToken } from "@/lib/auth";
import {
  loadPasskeys,
  savePasskeys,
  rpFromRequest,
  passkeyBlocker,
  pubKeyToStore,
  RP_NAME,
} from "@/lib/webauthn";

// crypto + fs → Node runtime.
export const runtime = "nodejs";

const CHALLENGE_COOKIE = "pk_reg_chal";

/** Registering a passkey requires an existing (password) session — only someone
 * already logged in can add Touch ID / Face ID. */
async function isAuthed(): Promise<boolean> {
  const token = (await cookies()).get(authCookieName())?.value;
  return verifyToken(token);
}

/** GET → registration options (challenge). */
export async function GET(req: Request) {
  if (!(await isAuthed())) {
    return NextResponse.json(
      { error: "Log in with your password first, then add a passkey." },
      { status: 401 },
    );
  }
  const { rpID } = rpFromRequest(req);
  const blocked = passkeyBlocker(rpID);
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 400 });
  }
  const existing = loadPasskeys();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: "classic",
    userDisplayName: "Classic",
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({
      id: p.id,
      transports: p.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
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

/** POST → verify the new passkey, store it. */
export async function POST(req: Request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { rpID, origin } = rpFromRequest(req);
  const expectedChallenge = (await cookies()).get(CHALLENGE_COOKIE)?.value;
  if (!expectedChallenge) {
    return NextResponse.json({ ok: false, error: "no challenge" }, { status: 400 });
  }

  let body: RegistrationResponseJSON;
  try {
    body = (await req.json()) as RegistrationResponseJSON;
  } catch {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "verify failed" },
      { status: 400 },
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json({ ok: false, error: "not verified" }, { status: 400 });
  }

  const cred = verification.registrationInfo.credential;
  const list = loadPasskeys();
  list.push({
    id: cred.id,
    publicKey: pubKeyToStore(cred.publicKey),
    counter: cred.counter,
    transports: cred.transports,
    label: `Passkey · ${new Date().toLocaleDateString()}`,
    createdAt: Date.now(),
  });
  savePasskeys(list);

  const res = NextResponse.json({ ok: true, count: list.length });
  res.cookies.set(CHALLENGE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
