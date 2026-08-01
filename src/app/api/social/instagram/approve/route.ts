import { readStaged, writeStaged } from "@/lib/social/instagram-store";

export const runtime = "nodejs";

/**
 * Approve-and-publish (G9). THE ONLY route permitted to call
 * graph.facebook.com — and it refuses until Meta credentials are linked.
 * STUB SCOPE: unlinked publish path only; the Graph API call lands with the
 * integrations division's build. No fabricated publish results, ever.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as { id?: string };
  const staged = readStaged();
  const post = staged.find((p) => p.id === body.id && p.status === "staged");
  if (!post) {
    return Response.json({ ok: false, error: "no staged post with that id" }, { status: 404 });
  }
  return Response.json({
    ok: false,
    error:
      "Instagram is not linked yet — link a Meta developer app at Settings → Link APIs, then approve again. The post stays staged.",
  });
}

/** Reject a staged post (local bookkeeping only). */
export async function DELETE(req: Request) {
  const body = (await req.json()) as { id?: string };
  const staged = readStaged();
  const post = staged.find((p) => p.id === body.id);
  if (post) {
    post.status = "rejected";
    writeStaged(staged);
  }
  return Response.json({ ok: true });
}
