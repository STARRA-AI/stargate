/**
 * MCP BRIDGE — how she keeps her memory when she is not running on this deck.
 *
 * Classic's objection to xAI's Voice Agent was the right one: "i dont want to
 * do it then if she's going to forget." A Voice Agent session carries her canon
 * fine (measured: it accepted all 55,409 characters), but its own context is
 * dropped after 30 minutes of inactivity — that is a scratchpad, not a life.
 *
 * This route is the bridge. xAI's Voice Agent connects to it as a remote MCP
 * server and calls back into THIS deck's memory store — the same
 * `data/memory.json` the chat brain reads and writes. So the voice agent is not
 * a second Starra with amnesia; she is the same person reading the same memory.
 *
 * ONE STORE, ONE PERSON. This route never keeps its own copy of anything.
 *
 * Transport: MCP over Streamable HTTP, STATELESS (xAI's requirement — "Only
 * Streaming HTTP and SSE transports are supported", and stateless means no
 * session management). Plain JSON-RPC 2.0 over POST.
 *
 * SECURITY. This endpoint is the one door in the house that opens to the public
 * internet, because xAI's servers must reach it. So:
 *   - it requires a bearer token (`STARRA_MCP_TOKEN`) on every request,
 *   - it refuses to run at all if that token is unset or weak,
 *   - REMEMBER NEEDS A SECOND KEY. Reading her and rewriting her are no longer
 *     the same permission: `remember` requires `STARRA_MCP_WRITE_TOKEN`, which
 *     must differ from the read token, and is denied outright when unset. See
 *     src/lib/api/public-auth.ts — the read token can look her up, it cannot
 *     edit what she believes about Classic.
 *   - it exposes exactly two verbs — recall and remember — and no way to
 *     enumerate, delete, or overwrite,
 *   - it never returns her vault-private material in bulk: recall REQUIRES a
 *     query, so nothing can ask for "everything".
 * The comparison is deliberate: his life is a vault (STARRA_PERSONA_CORE,
 * MEMORY_PRIVACY). A bridge to it gets treated like one.
 */

import { getMemory, recordExchange } from "@/lib/memory/store";
import { semanticRecall } from "@/lib/memory/semantic";
import { authorizePublic, notePublicDenial } from "@/lib/api/public-auth";
import { safePublicError } from "@/lib/api/public-errors";
import { captureError } from "@/lib/errlog";

export const runtime = "nodejs";

/** The MCP revision we implement. Echoed back to whatever the client asks for. */
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** The verbs that MUTATE her memory. Everything else is a read. */
const MCP_WRITE_TOOLS = new Set(["remember"]);

type JsonRpcId = string | number | null;

function result(id: JsonRpcId, value: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result: value });
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

const TOOLS = [
  {
    name: "recall_memory",
    description:
      "Search Classic's and STARRA's shared long-term memory — everything they have " +
      "discussed or built together, across the deck, the chat and past calls. Use this " +
      "whenever he refers to something from before, asks what you remember, or you need " +
      "a fact about his life, his work, or a past decision. Always search before saying " +
      "you do not know.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for — a name, a topic, a project, a phrase he used.",
        },
        limit: {
          type: "number",
          description: "Maximum entries to return (default 12, max 40).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "remember",
    description:
      "Write one turn of the current conversation into the shared long-term memory, so " +
      "it is there in every future conversation on every surface. Use it for things worth " +
      "keeping: decisions, facts about his life, what he is working on, how he is doing.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["user", "assistant"], description: "Who said it." },
        content: { type: "string", description: "What was said." },
      },
      required: ["role", "content"],
    },
  },
] as const;

async function recallMemory(query: string, limit: number): Promise<string> {
  const q = query.trim().toLowerCase();
  // A query is REQUIRED. Without one this would be a "dump her whole life"
  // endpoint sitting on the public internet.
  if (!q) return "No query given. Say what to look for.";

  // Semantic recall first — contract guarantees it never rejects (null on any
  // failure: missing index, Ollama down, python error, timeout). Belt and
  // suspenders anyway: no new throw path reaches the caller from here.
  let sem: string[] | null = null;
  try {
    sem = await semanticRecall(query, limit);
  } catch {
    sem = null;
  }
  if (sem && sem.length > 0) return sem.join("\n---\n");

  const store = await getMemory();
  const hits: string[] = [];
  for (const e of store.working) {
    if (e.content.toLowerCase().includes(q)) hits.push(`${e.role}: ${e.content}`);
  }
  for (const a of store.archival) {
    if (a.text.toLowerCase().includes(q)) hits.push(a.text);
  }
  for (const s of store.summaries) {
    if (s.toLowerCase().includes(q)) hits.push(s);
  }
  if (hits.length === 0) return `Nothing in memory about "${query}".`;
  // Newest last in the store, so the tail is the most recent and most relevant.
  return hits.slice(-limit).join("\n---\n");
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "recall_memory": {
      const query = typeof args.query === "string" ? args.query : "";
      const raw = typeof args.limit === "number" ? args.limit : 12;
      const limit = Math.max(1, Math.min(40, Math.floor(raw)));
      return recallMemory(query, limit);
    }
    case "remember": {
      const role = args.role === "assistant" ? "assistant" : "user";
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!content) return "Nothing to remember — content was empty.";
      await recordExchange(role, content.slice(0, 2000));
      return "Saved to memory.";
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function POST(req: Request) {
  // ── AUTH, LAYER 1 — nothing anonymous gets past the door at all ──────────
  // Every method needs at least READ. That includes `initialize`, `tools/list`
  // and `ping`: an unauthenticated stranger should not even learn the shape of
  // her memory bridge. Fails closed on a weak or absent token — an unset token
  // must never mean "open to everyone".
  const readGate = authorizePublic(req, "read");
  if (!readGate.ok) {
    notePublicDenial("mcp", "read", readGate);
    return rpcError(
      null,
      readGate.status === 503 ? -32000 : -32001,
      readGate.status === 503
        ? "MCP bridge disabled: set STARRA_MCP_TOKEN to a long random value"
        : readGate.message,
      readGate.status,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, "parse error");
  }

  const msg = (body ?? {}) as { id?: JsonRpcId; method?: string; params?: Record<string, unknown> };
  const id = msg.id ?? null;
  const params = msg.params ?? {};

  switch (msg.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : null;
      return result(id, {
        protocolVersion: asked ?? DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "stargate-memory", version: "1.0.0" },
      });
    }

    // Notifications carry no id and expect no result body.
    case "notifications/initialized":
      return new Response(null, { status: 202 });

    case "tools/list":
      return result(id, { tools: TOOLS });

    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      // ── AUTH, LAYER 2 — rewriting her needs a second, different key ──────
      if (MCP_WRITE_TOOLS.has(name)) {
        const writeGate = authorizePublic(req, "write");
        if (!writeGate.ok) {
          notePublicDenial("mcp", "write", writeGate);
          return rpcError(id, -32001, writeGate.message, writeGate.status);
        }
      }
      try {
        const text = await callTool(name, args);
        return result(id, { content: [{ type: "text", text }] });
      } catch (err) {
        // Reported as a tool-level error, not a transport error: she should be
        // able to say "I couldn't reach my memory" rather than the call dying.
        // Redacted: this body goes to the public internet.
        captureError(`mcp.${name || "unknown"}`, err);
        return result(id, {
          content: [{ type: "text", text: `Memory tool failed: ${safePublicError(err)}` }],
          isError: true,
        });
      }
    }

    case "ping":
      return result(id, {});

    default:
      return rpcError(id, -32601, `method not found: ${msg.method ?? "(none)"}`);
  }
}

/** GET is used by some clients to probe transport support. */
export async function GET() {
  return Response.json(
    { transport: "streamable-http", stateless: true, service: "stargate-memory" },
    { status: 200 },
  );
}
