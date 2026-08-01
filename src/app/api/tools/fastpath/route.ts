import { maybeLiveInfoReply, maybeToolReply } from "@/lib/tools/fastpath";

/**
 * POST {text} -> {handled, reply} — thin HTTP wrapper around the shared
 * keyword/MCP tool fast-path (src/lib/tools/fastpath.ts) so client code
 * (e.g. useVoiceCall) can reach it without importing server-only tool
 * modules into the client bundle.
 *
 * AUTH: no in-route check here — matching /api/chat/route.ts, which also has
 * none (verified: no auth/token/header check anywhere in that file). Both
 * routes rely on the global session-cookie gate in src/middleware.ts, which
 * runs on every request whose path is not excluded by its matcher
 * (src/middleware.ts:28-30 excludes only /login, /api/auth, _next/, brand/,
 * favicon, manifest, and static asset extensions — /api/tools/fastpath is
 * not excluded) and 401s any unauthenticated `/api/*` request
 * (src/middleware.ts:65-71).
 */
export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { text?: unknown };
  try {
    body = (await req.json()) as { text?: unknown };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text : "";
  // The ONE shared keyword/MCP fast-path first (identical to what /api/chat
  // runs), then the call-only live-info lookups that the Deck already performs
  // inline as prompt context. Wire shape is unchanged either way.
  const reply = (await maybeToolReply(text)) ?? (await maybeLiveInfoReply(text));
  return Response.json({ handled: reply !== null, reply });
}
