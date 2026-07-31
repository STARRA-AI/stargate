/**
 * STARGATE MCP BRIDGE — gives HER the same tool reach Classic's Claude Code
 * sessions have: Model Context Protocol servers, callable from any deck
 * surface at any time (a gated API route consumes this, so it works during a
 * live call exactly like outside one), with every configured server usable
 * CONCURRENTLY — each server holds its own independent connection.
 *
 * Servers (config, not code):
 *  - playwright — LOCAL stdio: `npx @playwright/mcp@latest` (free, verified
 *    from the official docs 2026-07-31). Spawned lazily, newline-delimited
 *    JSON-RPC per the MCP stdio transport, respawned on death.
 *  - composio  — HOSTED http: COMPOSIO_MCP_URL + COMPOSIO_API_KEY env (his
 *    account; the slot stays dark until the key exists — never a fake).
 *
 * DISCIPLINE: every call has a hard timeout; every failure returns an error
 *  string result (never throws into a route); failures are captured to the
 *  errors table via errlog.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { captureError } from "@/lib/errlog";

const CALL_TIMEOUT_MS = 30_000;
const LIST_CACHE_MS = 5 * 60_000;

export type McpTool = { name: string; description: string };
export type McpServerStatus = {
  name: string;
  transport: "stdio" | "http";
  configured: boolean;
  up: boolean;
  tools: McpTool[];
  error: string | null;
};
export type McpCallResult = { ok: boolean; text: string };

type ServerConfig =
  | { name: string; transport: "stdio"; command: string; args: string[] }
  | { name: string; transport: "http"; url: string; headers: Record<string, string> };

function servers(): ServerConfig[] {
  const out: ServerConfig[] = [
    {
      name: "playwright",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless"],
    },
  ];
  const url = process.env.COMPOSIO_MCP_URL;
  const key = process.env.COMPOSIO_API_KEY;
  if (url && key) {
    out.push({
      name: "composio",
      transport: "http",
      url,
      headers: { "x-api-key": key },
    });
  }
  return out;
}

/* ── stdio transport ─────────────────────────────────────────────────────── */

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class StdioConn {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private initialized: Promise<void> | null = null;

  constructor(private cfg: Extract<ServerConfig, { transport: "stdio" }>) {}

  private ensure(): Promise<void> {
    if (this.child && this.initialized) return this.initialized;
    const child = spawn(this.cfg.command, this.cfg.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    this.buffer = "";
    child.stdout.on("data", (d: Buffer) => this.onData(d));
    child.on("close", () => {
      // Fail everything in flight; next call respawns lazily.
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`${this.cfg.name} exited`));
      }
      this.pending.clear();
      this.child = null;
      this.initialized = null;
    });
    child.on("error", () => child.kill());
    this.initialized = (async () => {
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "stargate-bridge", version: "1.0.0" },
      });
      this.notify("notifications/initialized", {});
    })();
    return this.initialized;
  }

  private onData(d: Buffer): void {
    this.buffer += d.toString("utf8");
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (typeof msg.id === "number") {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
            else p.resolve(msg.result);
          }
        }
      } catch {
        /* non-JSON noise on stdout — ignore */
      }
    }
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.cfg.name} ${method} timed out`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    await this.ensure();
    return this.request(method, params);
  }
}

const stdioConns = new Map<string, StdioConn>();

/* ── http transport (Composio hosted) ────────────────────────────────────── */

async function httpRpc(
  cfg: Extract<ServerConfig, { transport: "http" }>,
  method: string,
  params: unknown,
): Promise<unknown> {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...cfg.headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${cfg.name} HTTP ${res.status}`);
  const text = await res.text();
  // Streamable-HTTP servers may answer as SSE — take the first data: payload.
  const raw = text.trimStart().startsWith("event:") || text.includes("\ndata:")
    ? (text.split(/\ndata:\s*/)[1] ?? "").split("\n")[0]
    : text;
  const msg = JSON.parse(raw) as { result?: unknown; error?: { message?: string } };
  if (msg.error) throw new Error(msg.error.message ?? "MCP error");
  return msg.result;
}

/* ── shared surface ──────────────────────────────────────────────────────── */

async function rpc(cfg: ServerConfig, method: string, params: unknown): Promise<unknown> {
  if (cfg.transport === "http") return httpRpc(cfg, method, params);
  let conn = stdioConns.get(cfg.name);
  if (!conn) {
    conn = new StdioConn(cfg);
    stdioConns.set(cfg.name, conn);
  }
  return conn.rpc(method, params);
}

const listCache = new Map<string, { at: number; tools: McpTool[] }>();

export async function listMcpServers(): Promise<McpServerStatus[]> {
  const composioConfigured = Boolean(
    process.env.COMPOSIO_MCP_URL && process.env.COMPOSIO_API_KEY,
  );
  const statuses: McpServerStatus[] = [];
  for (const cfg of servers()) {
    const cached = listCache.get(cfg.name);
    if (cached && Date.now() - cached.at < LIST_CACHE_MS) {
      statuses.push({
        name: cfg.name,
        transport: cfg.transport,
        configured: true,
        up: true,
        tools: cached.tools,
        error: null,
      });
      continue;
    }
    try {
      const result = (await rpc(cfg, "tools/list", {})) as {
        tools?: { name: string; description?: string }[];
      };
      const tools = (result.tools ?? []).map((t) => ({
        name: t.name,
        description: (t.description ?? "").slice(0, 140),
      }));
      listCache.set(cfg.name, { at: Date.now(), tools });
      statuses.push({
        name: cfg.name,
        transport: cfg.transport,
        configured: true,
        up: true,
        tools,
        error: null,
      });
    } catch (e) {
      captureError(`mcp:${cfg.name}:list`, e);
      statuses.push({
        name: cfg.name,
        transport: cfg.transport,
        configured: true,
        up: false,
        tools: [],
        error: e instanceof Error ? e.message.slice(0, 140) : "unreachable",
      });
    }
  }
  if (!composioConfigured) {
    statuses.push({
      name: "composio",
      transport: "http",
      configured: false,
      up: false,
      tools: [],
      error: "COMPOSIO_MCP_URL + COMPOSIO_API_KEY not set — see docs/MCP.md",
    });
  }
  return statuses;
}

export async function callMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const cfg = servers().find((s) => s.name === server);
  if (!cfg) return { ok: false, text: `unknown or unconfigured server: ${server}` };
  try {
    const result = (await rpc(cfg, "tools/call", {
      name: tool,
      arguments: args,
    })) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const text = (result.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
      .join("\n")
      .slice(0, 8000);
    return { ok: !result.isError, text: text || "(no text content)" };
  } catch (e) {
    captureError(`mcp:${server}:${tool}`, e);
    return {
      ok: false,
      text: e instanceof Error ? e.message.slice(0, 200) : "tool call failed",
    };
  }
}
