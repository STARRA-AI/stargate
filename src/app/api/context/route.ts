import { getTier1, saveTier1, Tier1Schema } from "@/lib/context/tier1";
import { getMemory, memoryCounts } from "@/lib/memory/store";

export const runtime = "nodejs";

export async function GET() {
  const [tier1, memory] = await Promise.all([getTier1(), getMemory()]);
  const counts = memoryCounts(memory);
  const tasksDue = tier1.tasks.filter((t) => !t.done).length;
  const pipelineOpen = tier1.projects.filter((p) => p.status === "active").length;
  return Response.json({
    tier1,
    snap: {
      mrrLabel: tier1.mrrLabel,
      tasksDue,
      pipelineOpen,
      working: counts.working,
      summaries: counts.summaries,
      archival: counts.archival,
    },
  });
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = Tier1Schema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid tier1 payload" }, { status: 400 });
  }
  const saved = await saveTier1(parsed.data);
  return Response.json(saved);
}
