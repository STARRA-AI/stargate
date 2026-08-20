/**
 * DRAGON TRADAR — her read of Classic's own Kalshi bot (dragontradar.com).
 *
 * Separate from `lib/kalshi.ts`. That module talks to Kalshi DIRECTLY with his
 * RSA key and answers "what do the markets look like". This one talks to HIS
 * APP and answers "what is the bot doing with my money" — connected state,
 * cash balance, open positions. Both are true; they are not the same question.
 *
 * CONTRACT — verified live against the deployed app 2026-08-20:
 *   base : https://dragontradar.com/api/agent/v1   (shown in Settings → AI Trading Agent)
 *   auth : Authorization: Bearer <agent token>
 *   GET /stats -> 200 {"connected":true,"balanceCents":5475,"positions":[]}
 * Auth is checked BEFORE routing, so every unknown path also answers 401 with a
 * token missing — route existence cannot be probed. Only /stats is confirmed;
 * the order-placing route is deliberately NOT guessed at here.
 *
 * ── THE LANDMINE: NEVER RETRY A REJECTED TOKEN ───────────────────────────────
 * Measured, not assumed: ONE request with a bad token flips the API to
 *   429 {"error":"temporarily_blocked"}
 * A retry loop on a bad or rotated token therefore locks CLASSIC out of his own
 * trading bot. So: one attempt, no retry, and 429 is reported as its own state
 * rather than folded into a generic error — he needs to see the difference
 * between "the token is wrong" and "I got throttled for asking".
 *
 * Fails CLOSED and QUIET: no token configured is the normal resting state, not
 * an error worth shouting about, because the deck ships without one.
 */
import { getKey } from "@/lib/keys";

export const DRAGON_TRADAR_AGENT_BASE = "https://dragontradar.com/api/agent/v1";

export type AgentPosition = Record<string, unknown>;

export type AgentStats = {
  connected: boolean;
  balanceCents: number;
  positions: AgentPosition[];
};

/** Every outcome is named. Nothing is silently swallowed into `null`. */
export type AgentResult<T> =
  | { state: "off" }
  | { state: "ok"; stats: T }
  | { state: "blocked" }
  | { state: "rejected"; code?: string }
  | { state: "error"; status: number; code?: string };

/** readAgent()'s original shape — AgentResult specialized to /stats. */
export type AgentRead = AgentResult<AgentStats>;

export type AgentOrder = Record<string, unknown>;

/** GET /bot/state — Task A1 contract; field values are best-effort, unverified live. */
export type AgentBotState = {
  running: boolean;
  category: string;
  mode: string;
  lastScanAt: string | null;
  config: Record<string, unknown>;
};

/** GET /performance — Task A1 contract, verbatim field list. */
export type AgentPerformance = {
  realizedPnlCents: number;
  unrealizedPnlCents: number;
  winRate: number;
  tradeCount: number;
  since: string;
};

export type AgentDeps = {
  /** null/"" = not configured. undefined = resolve via getKey(). */
  token?: string | null;
  fetchImpl?: typeof fetch;
  base?: string;
  timeoutMs?: number;
};

function coerceStats(raw: unknown): AgentStats {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    connected: o.connected === true,
    balanceCents: typeof o.balanceCents === "number" ? o.balanceCents : 0,
    positions: Array.isArray(o.positions) ? (o.positions as AgentPosition[]) : [],
  };
}

/** Parses `{"error": "..."}` out of a non-OK JSON body. Never throws. */
async function extractErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object") {
      const err = (body as Record<string, unknown>).error;
      if (typeof err === "string") return err;
    }
  } catch {
    // not JSON, or no body — no code to report
  }
  return undefined;
}

type AgentMethod = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * One request to `${base}${path}`. One attempt. No retry — see the landmine
 * note above. This is the only place in the module that talks HTTP; every read
 * AND every write below routes through here, so no later writer path can
 * quietly reintroduce a retry.
 *
 * A body is JSON-encoded, and only a request that carries one sends
 * Content-Type — a GET goes out exactly as it always did: Authorization alone.
 */
async function agentRequest<T>(
  method: AgentMethod,
  path: string,
  deps: AgentDeps = {},
  body?: unknown,
): Promise<AgentResult<T>> {
  const token =
    deps.token !== undefined ? deps.token : await getKey("dragontradar_agent_token");
  if (!token) return { state: "off" };

  const doFetch = deps.fetchImpl ?? fetch;
  const base = deps.base ?? DRAGON_TRADAR_AGENT_BASE;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deps.timeoutMs ?? 10_000);

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  try {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: ac.signal,
    });
    if (res.status === 429) return { state: "blocked" };
    if (res.status === 401 || res.status === 403) {
      // Carry his app's own code through. 401/403 SHOULD only ever mean the
      // token, but if a business refusal ever comes back on a 403 it must not
      // read to him as "regenerate your token" with no further explanation.
      const code = await extractErrorCode(res);
      return code === undefined ? { state: "rejected" } : { state: "rejected", code };
    }
    if (!res.ok) {
      const code = await extractErrorCode(res);
      return code === undefined
        ? { state: "error", status: res.status }
        : { state: "error", status: res.status, code };
    }
    return { state: "ok", stats: (await res.json()) as T };
  } catch {
    // Network down / aborted. Status 0 says "never reached him", which is a
    // different fact from any HTTP code and must not read as a rejection.
    return { state: "error", status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** GET — the read half. One attempt, no retry. */
export async function agentGet<T>(path: string, deps: AgentDeps = {}): Promise<AgentResult<T>> {
  return agentRequest<T>("GET", path, deps);
}

/** POST with a JSON body — the write half. One attempt, no retry. */
export async function agentPost<T>(
  path: string,
  body: unknown,
  deps: AgentDeps = {},
): Promise<AgentResult<T>> {
  return agentRequest<T>("POST", path, deps, body);
}

/** PATCH with a JSON body. One attempt, no retry. */
export async function agentPatch<T>(
  path: string,
  body: unknown,
  deps: AgentDeps = {},
): Promise<AgentResult<T>> {
  return agentRequest<T>("PATCH", path, deps, body);
}

/** DELETE — no body. One attempt, no retry. */
export async function agentDelete<T>(
  path: string,
  deps: AgentDeps = {},
): Promise<AgentResult<T>> {
  return agentRequest<T>("DELETE", path, deps);
}

/** GET /stats, coerced so a garbage body can't crash a caller. */
export async function readAgent(deps: AgentDeps = {}): Promise<AgentRead> {
  const r = await agentGet<AgentStats>("/stats", deps);
  return r.state === "ok" ? { state: "ok", stats: coerceStats(r.stats) } : r;
}

/** GET /positions — open positions, full per-position detail (shape TBD: Half A). */
export async function readPositions(deps: AgentDeps = {}): Promise<AgentResult<AgentPosition[]>> {
  return agentGet<AgentPosition[]>("/positions", deps);
}

/**
 * GET /orders — resting orders by default (shape TBD: Half A).
 *
 * `status` is sent EXPLICITLY rather than left to his server's default: the
 * snapshot asks "what is resting right now", and silently receiving full
 * history instead would look like the same answer with more rows in it.
 */
export async function readOrders(
  deps: AgentDeps = {},
  status: "open" | "all" = "open",
): Promise<AgentResult<AgentOrder[]>> {
  return agentGet<AgentOrder[]>(`/orders?status=${status}`, deps);
}

/** GET /bot/state. */
export async function readBotState(deps: AgentDeps = {}): Promise<AgentResult<AgentBotState>> {
  return agentGet<AgentBotState>("/bot/state", deps);
}

/** GET /performance. */
export async function readPerformance(deps: AgentDeps = {}): Promise<AgentResult<AgentPerformance>> {
  return agentGet<AgentPerformance>("/performance", deps);
}

/** Dollars, for anything that shows a human a number. */
export function balanceUsd(stats: AgentStats): number {
  return Math.round(stats.balanceCents) / 100;
}

/* ── CONTROL ─────────────────────────────────────────────────────────────────
 * Engage / disengage / reconfigure his bot. These are the first calls in this
 * module that CHANGE something on his side, so everything that can be checked
 * locally is checked BEFORE the network: a mistyped category or a garbage
 * config value is refused here rather than being posted at a live trading app.
 * The server keeps its own brakes (the enable toggle, the per-order cap,
 * AGENT_LIVE_TRADING_ENABLED); nothing below tries to speak for them.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Dragon Mode categories — the literal union from the Task A1 contract. */
export const DRAGON_CATEGORIES = [
  "sports",
  "crypto",
  "politics",
  "economics",
  "parallel",
] as const;

export type DragonCategory = (typeof DRAGON_CATEGORIES)[number];

export function isDragonCategory(v: unknown): v is DragonCategory {
  return typeof v === "string" && (DRAGON_CATEGORIES as readonly string[]).includes(v);
}

/** PATCH /config — the Task A1 field list, verbatim. Every field optional. */
export type DragonConfigPatch = {
  minBetCents?: number;
  maxLegs?: number;
  minEdgePct?: number;
  minConfidencePct?: number;
  autoFire?: boolean;
  scanIntervalMin?: number;
  thinkTank?: boolean;
};

/** Whatever his app answers a write with. Never parsed into a decision here. */
export type AgentAck = Record<string, unknown>;

type ConfigRejection = "empty_config" | "unknown_config_key" | "bad_config_value";

function validNumber(key: string, v: unknown): boolean {
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  switch (key) {
    case "minBetCents":
      return Number.isInteger(v) && v >= 0;
    case "maxLegs":
    case "scanIntervalMin":
      return Number.isInteger(v) && v >= 1;
    default:
      // minEdgePct / minConfidencePct — percentages, not ratios.
      return v >= 0 && v <= 100;
  }
}

const CONFIG_NUMBER_KEYS = new Set([
  "minBetCents",
  "maxLegs",
  "minEdgePct",
  "minConfidencePct",
  "scanIntervalMin",
]);
const CONFIG_BOOLEAN_KEYS = new Set(["autoFire", "thinkTank"]);

/**
 * Local gate on a config patch. Rejects an empty patch too: a PATCH with no
 * fields is a no-op his app would answer 200 to, and a silent no-op reported
 * as success is how "I changed it" becomes a lie on a money surface.
 */
export function validateConfigPatch(
  patch: Record<string, unknown>,
): { ok: true; patch: DragonConfigPatch } | { ok: false; code: ConfigRejection } {
  const keys = Object.keys(patch);
  if (keys.length === 0) return { ok: false, code: "empty_config" };

  for (const k of keys) {
    if (CONFIG_NUMBER_KEYS.has(k)) {
      if (!validNumber(k, patch[k])) return { ok: false, code: "bad_config_value" };
    } else if (CONFIG_BOOLEAN_KEYS.has(k)) {
      if (typeof patch[k] !== "boolean") return { ok: false, code: "bad_config_value" };
    } else {
      return { ok: false, code: "unknown_config_key" };
    }
  }
  return { ok: true, patch: patch as DragonConfigPatch };
}

/** POST /bot/engage — starts REAL trading in one category. */
export async function engageBot(
  category: DragonCategory,
  deps: AgentDeps = {},
): Promise<AgentResult<AgentAck>> {
  // Runtime check despite the type: this value arrives from her tool call and
  // from HTTP, where TypeScript guarantees nothing.
  if (!isDragonCategory(category)) {
    return { state: "error", status: 0, code: "unknown_category" };
  }
  return agentPost<AgentAck>("/bot/engage", { category }, deps);
}

/** POST /bot/disengage — the stop. Always dispatched; never gated locally. */
export async function disengageBot(deps: AgentDeps = {}): Promise<AgentResult<AgentAck>> {
  return agentPost<AgentAck>("/bot/disengage", {}, deps);
}

/** PATCH /config, after the local gate above. */
export async function patchConfig(
  patch: Record<string, unknown>,
  deps: AgentDeps = {},
): Promise<AgentResult<AgentAck>> {
  const v = validateConfigPatch(patch);
  if (!v.ok) return { state: "error", status: 0, code: v.code };
  return agentPatch<AgentAck>("/config", v.patch, deps);
}
