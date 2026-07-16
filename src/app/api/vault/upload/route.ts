import { getVault, ingestTextFile } from "@/lib/vault/store";

export const runtime = "nodejs";

export async function GET() {
  const vault = await getVault();
  return Response.json(vault);
}

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "file required" }, { status: 400 });
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const doc = await ingestTextFile(
    file.name,
    file.type || "application/octet-stream",
    buf,
  );
  return Response.json(doc);
}
