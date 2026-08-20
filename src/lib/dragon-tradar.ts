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
export type AgentRead =
  | { state: "off" }
  | { state: "ok"; stats: AgentStats }
  | { state: "blocked" }
  | { state: "rejected" }
  | { state: "error"; status: number };

type Deps = {
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

/**
 * One GET /stats. One attempt. No retry — see the landmine note above.
 */
export async function readAgent(deps: Deps = {}): Promise<AgentRead> {
  const token =
    deps.token !== undefined ? deps.token : await getKey("dragontradar_agent_token");
  if (!token) return { state: "off" };

  const doFetch = deps.fetchImpl ?? fetch;
  const base = deps.base ?? DRAGON_TRADAR_AGENT_BASE;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deps.timeoutMs ?? 10_000);

  try {
    const res = await doFetch(`${base}/stats`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    if (res.status === 429) return { state: "blocked" };
    if (res.status === 401 || res.status === 403) return { state: "rejected" };
    if (!res.ok) return { state: "error", status: res.status };
    return { state: "ok", stats: coerceStats(await res.json()) };
  } catch {
    // Network down / aborted. Status 0 says "never reached him", which is a
    // different fact from any HTTP code and must not read as a rejection.
    return { state: "error", status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Dollars, for anything that shows a human a number. */
export function balanceUsd(stats: AgentStats): number {
  return Math.round(stats.balanceCents) / 100;
}
