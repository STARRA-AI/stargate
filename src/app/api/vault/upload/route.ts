import { getVault, ingestTextFile } from "@/lib/vault/store";

export const runtime = "nodejs";

// Vault ingestion reads text/markdown/csv/pdf into memory (see lib/vault/store)
// — cap uploads so a huge or malformed body can't buffer/crash the route.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB

export async function GET() {
  const vault = await getVault();
  return Response.json(vault);
}

export async function POST(req: Request) {
  // ★ A MISSING content-length IS NOT "TOO LARGE" (fixed 2026-09-22).
  // This used to read `Number(header)` and reject on `!Number.isFinite(...)`,
  // so an absent header — which parses to NaN — returned 413 "file too large"
  // for a 300-byte file. Measured: a `Request` built with a FormData body
  // carries NO content-length at all (undici sets it at dispatch, not on the
  // object), so every server-side and test-harness call of this route 413'd
  // regardless of size, and the console drop box would have failed on its
  // first file.
  //
  // The header is also client-supplied and therefore advisory. It stays as a
  // CHEAP PRE-PARSE REJECT for the case where it is present and already over
  // the cap — that avoids buffering a body we know we will refuse — and the
  // authoritative check remains `file.size` below, after the multipart parse,
  // which cannot be lied about.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "file too large" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "malformed upload" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "file required" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "file too large" }, { status: 413 });
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const doc = await ingestTextFile(
    file.name,
    file.type || "application/octet-stream",
    buf,
  );
  return Response.json(doc);
}
