import {
  getMontageStatus,
  queueMontageJob,
  silentShadowTemplate,
} from "@/lib/tools/openmontage";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(await getMontageStatus());
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    brief?: string;
    topic?: string;
    pipeline?: string;
  };

  const brief =
    body.brief?.trim() ||
    (body.topic ? silentShadowTemplate(body.topic) : "");

  if (!brief) {
    return Response.json(
      { error: "brief or topic required" },
      { status: 400 },
    );
  }

  const job = await queueMontageJob({
    brief,
    pipeline: body.pipeline,
  });
  return Response.json(job);
}
