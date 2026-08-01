import { randomUUID } from "node:crypto";
import { readStaged, writeStaged, type StagedPost } from "@/lib/social/instagram-store";

export const runtime = "nodejs";

/** Stage a post for Classic's approval. Staging NEVER publishes. */
export async function POST(req: Request) {
  const body = (await req.json()) as { caption?: string; mediaPath?: string };
  const caption = (body.caption ?? "").trim();
  if (!caption) {
    return Response.json({ ok: false, error: "caption required" }, { status: 400 });
  }
  const post: StagedPost = {
    id: randomUUID(),
    caption: caption.slice(0, 2200),
    mediaPath: (body.mediaPath ?? "").trim(),
    stagedAt: new Date().toISOString(),
    status: "staged",
  };
  writeStaged([...readStaged(), post]);
  return Response.json({ ok: true, post });
}
