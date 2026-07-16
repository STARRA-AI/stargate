import { pushFeed, readFeed } from "@/lib/feed";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ feed: readFeed() });
}

export async function POST(req: Request) {
  const body = (await req.json()) as { tag?: string; text?: string };
  if (body.text) {
    pushFeed((body.tag || "SYS").replace(/[[\]]/g, ""), body.text.slice(0, 160));
  }
  return Response.json({ ok: true });
}
