/**
 * PASSKEY MANAGEMENT — list and remove, behind the existing password session.
 *
 * This exists so Classic never has to hand-edit data/passkeys.json (mode 0700)
 * to get rid of a credential that summons the wrong sheet. Registration lives
 * next door in ./register; this file only reads and deletes.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { authCookieName, verifyToken } from "@/lib/auth";
import { loadPasskeys, removePasskey } from "@/lib/webauthn";

export const runtime = "nodejs";

async function isAuthed(): Promise<boolean> {
  const token = (await cookies()).get(authCookieName())?.value;
  return verifyToken(token);
}

/** GET → what is registered. Never returns the public key. */
export async function GET() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    passkeys: loadPasskeys().map((p) => ({
      id: p.id,
      label: p.label,
      attachment: p.attachment ?? null,
      transports: p.transports ?? [],
      createdAt: p.createdAt,
    })),
  });
}

/** DELETE ?id=<credentialId> → remove one. */
export async function DELETE(req: Request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) {
    return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  }
  const removed = removePasskey(id);
  return NextResponse.json({ ok: removed, count: loadPasskeys().length });
}
