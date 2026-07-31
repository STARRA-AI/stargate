import { callMcpTool, listMcpServers } from "@/lib/mcp/client";

/**
 * MCP BRIDGE — her hands on Playwright + Composio, behind the default /api/*
 * auth gate, CALL-INDEPENDENT by construction: this route answers the same
 * whether or not the voice overlay is open, and each configured server holds
 * its own connection, so both run at the same time.
 *
 *   GET                              → server statuses + tool lists
 *   POST {server, tool, args}        → tools/call result text
 */
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ servers: await listMcpServers() });
}

export async function POST(req: Request) {
  let body: { server?: unknown; tool?: unknown; args?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.server !== "string" || typeof body.tool !== "string") {
    return Response.json({ error: "need server + tool" }, { status: 400 });
  }
  const args =
    body.args && typeof body.args === "object" && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>)
      : {};
  const result = await callMcpTool(body.server, body.tool, args);
  return Response.json(result, { status: result.ok ? 200 : 502 });
}
