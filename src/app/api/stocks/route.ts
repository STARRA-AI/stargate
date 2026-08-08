/**
 * GET /api/stocks — STARRA ENGINE ROOM uplink (stocks+crypto paper engine).
 *
 * Proxies the loopback engine API (127.0.0.1:47401) server-side: the deck is
 * HTTPS and the engine is plain http on loopback, so the browser never calls
 * it directly (mixed-content block) — this route does, with the bearer token
 * read from the engine's own .env at request time. Reading the file instead of
 * process env means token rotation needs no deck restart and no duplicated
 * config. NOTE: /api/engine/* in this repo is the LLM-provider engine — an
 * unrelated namespace; the trading engine lives here under /api/stocks.
 * Degrade, never throw: engine down → { linked: false }, HTTP 200.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENGINE_BASE = "http://127.0.0.1:47401";
const ENGINE_ENV = join(homedir(), "Desktop", "STARGATE", "engine", ".env");

function engineToken(): string | null {
  try {
    const m = readFileSync(ENGINE_ENV, "utf8").match(/^ENGINE_TOKEN=(\S+)$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function engineGet(path: string, token: string | null): Promise<unknown> {
  try {
    const r = await fetch(`${ENGINE_BASE}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function GET() {
  const health = (await engineGet("/health", null)) as {
    ok?: boolean;
    halted?: boolean;
    paper_only?: boolean;
  } | null;
  if (!health?.ok) {
    return Response.json({ linked: false });
  }
  const token = engineToken();
  const today = new Date().toISOString().slice(0, 10);
  const [decisions, approvals] = await Promise.all([
    engineGet(`/decisions?date=${today}`, token),
    engineGet("/approvals", token),
  ]);
  return Response.json({
    linked: true,
    halted: health.halted === true,
    paperOnly: health.paper_only !== false,
    decisions: Array.isArray(decisions) ? decisions : [],
    pendingApprovals: Array.isArray(approvals) ? approvals : [],
  });
}
