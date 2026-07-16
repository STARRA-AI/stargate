import { getMemory } from "@/lib/memory/store";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const store = await getMemory();
  if (!q) return Response.json(store);
  return Response.json({
    working: store.working.filter((e) =>
      e.content.toLowerCase().includes(q),
    ),
    summaries: store.summaries.filter((s) => s.toLowerCase().includes(q)),
    archival: store.archival.filter((a) => a.text.toLowerCase().includes(q)),
  });
}
