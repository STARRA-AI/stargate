import { runRepomix, readLatestPackPreview } from "@/lib/tools/repomix";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  const preview = await readLatestPackPreview(2000);
  return Response.json({
    hasPack: Boolean(preview),
    preview,
    outputPath: "data/packs/stargate-repomix.xml",
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { target?: string };
  const result = await runRepomix(body.target);
  return Response.json(result, { status: result.ok ? 200 : 500 });
}
