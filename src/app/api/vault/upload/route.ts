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
  const contentLengthHeader = req.headers.get("content-length");
  const contentLength =
    contentLengthHeader !== null ? Number(contentLengthHeader) : NaN;
  if (!Number.isFinite(contentLength) || contentLength > MAX_UPLOAD_BYTES) {
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
