import {
  briefForPipeline,
  getMontageStatus,
  markMontageJobDone,
  queueMontageJob,
} from "@/lib/tools/openmontage";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(await getMontageStatus());
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    action?: string;
    brief?: string;
    topic?: string;
    pipeline?: string;
    id?: string;
    outputPath?: string;
    error?: string;
  };

  if (body.action === "mark_done" || body.action === "mark_error") {
    if (!body.id?.trim()) {
      return Response.json({ error: "id required" }, { status: 400 });
    }
    const job = await markMontageJobDone({
      id: body.id.trim(),
      outputPath: body.outputPath,
      error: body.action === "mark_error" ? body.error || "render failed" : undefined,
    });
    if (!job) {
      return Response.json({ error: "job not found" }, { status: 404 });
    }
    return Response.json(job);
  }

  const pipeline = body.pipeline?.trim() || "silent-shadow-short";
  const brief =
    body.brief?.trim() ||
    (body.topic
      ? briefForPipeline(pipeline, body.topic)
      : "");

  if (!brief) {
    return Response.json(
      { error: "brief or topic required" },
      { status: 400 },
    );
  }

  const job = await queueMontageJob({
    brief,
    pipeline,
  });
  return Response.json(job);
}
