/**
 * POST /api/dragon/control — engage, disengage, or reconfigure his bot.
 *
 * This route STARTS AND STOPS REAL TRADING. Three things follow from that:
 *
 *  1. It is deck-session gated by `src/middleware.ts` like every other
 *     non-public route — nothing on his LAN can reach it without his cookie.
 *     `/api/dragon/control` is deliberately NOT in PUBLIC_PREFIXES.
 *  2. Every attempt is written to the ops feed WITH its outcome, so a control
 *     action can never happen without a line he can see afterwards.
 *  3. A malformed request is refused here, before `lib/dragon-tradar.ts` is
 *     even called — and that module refuses again. Neither layer trusts the
 *     other, because the caller is a language model reading her tool schema.
 *
 * The three server-side brakes (the "Agent trading enabled" toggle, the
 * per-order cap, AGENT_LIVE_TRADING_ENABLED) live in HIS app and are not
 * touched, read, or spoken for here.
 */
import { pushFeed } from "@/lib/feed";
import {
  engageBot,
  disengageBot,
  patchConfig,
  isDragonCategory,
  type AgentAck,
  type AgentResult,
  type DragonCategory,
} from "@/lib/dragon-tradar";

export const runtime = "nodejs";

export type ControlCommand =
  | { action: "engage"; category: DragonCategory }
  | { action: "disengage" }
  | { action: "config"; config: Record<string, unknown> };

type ParseRejection =
  | "unknown_action"
  | "unknown_category"
  | "category_required"
  | "config_required";

/**
 * The request body, checked into a command or a named refusal. Pure, and
 * exported, so the shape of "what she is allowed to ask for" is pinned by a
 * test rather than by the route being hit with real money on the line.
 */
export function parseControlRequest(
  raw: unknown,
): { ok: true; cmd: ControlCommand } | { ok: false; code: ParseRejection } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const action = body.action;

  if (action === "disengage") return { ok: true, cmd: { action: "disengage" } };

  if (action === "engage") {
    if (body.category === undefined || body.category === null) {
      return { ok: false, code: "category_required" };
    }
    if (!isDragonCategory(body.category)) return { ok: false, code: "unknown_category" };
    return { ok: true, cmd: { action: "engage", category: body.category } };
  }

  if (action === "config") {
    const cfg = body.config;
    if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
      return { ok: false, code: "config_required" };
    }
    return { ok: true, cmd: { action: "config", config: cfg as Record<string, unknown> } };
  }

  return { ok: false, code: "unknown_action" };
}

/** What he reads in the feed afterwards. Names the outcome, never just the attempt. */
export function controlFeedLine(cmd: ControlCommand, result: AgentResult<AgentAck>): string {
  const what =
    cmd.action === "engage"
      ? `ENGAGE ${cmd.category}`
      : cmd.action === "disengage"
        ? "DISENGAGE"
        : `CONFIG ${Object.keys(cmd.config).join(",") || "(empty)"}`;

  switch (result.state) {
    case "ok":
      return `Dragon Tradar ${what} — accepted`;
    case "off":
      return `Dragon Tradar ${what} — no agent token configured, nothing sent`;
    case "blocked":
      return `Dragon Tradar ${what} — throttled (429), backing off, not retrying`;
    case "rejected":
      return `Dragon Tradar ${what} — token rejected, regenerate it in Settings → AI Trading Agent`;
    default:
      return `Dragon Tradar ${what} — refused (${result.status}${result.code ? ` ${result.code}` : ""})`;
  }
}

/** ALERT for anything he has to act on; SYS for a clean accept. */
export function controlFeedTag(result: AgentResult<AgentAck>): string {
  return result.state === "ok" ? "SYS" : "ALERT";
}

export async function POST(req: Request) {
  let raw: unknown = null;
  try {
    raw = await req.json();
  } catch {
    // no body / not JSON — falls through to unknown_action below
  }

  const parsed = parseControlRequest(raw);
  if (!parsed.ok) {
    // 400 here, not a 200 carrying an error state: this one never reached his
    // app, and a caller must be able to tell that apart from his app saying no.
    pushFeed("ALERT", `Dragon Tradar control refused locally — ${parsed.code}`);
    return Response.json({ state: "error", status: 0, code: parsed.code }, { status: 400 });
  }

  const cmd = parsed.cmd;
  const result =
    cmd.action === "engage"
      ? await engageBot(cmd.category)
      : cmd.action === "disengage"
        ? await disengageBot()
        : await patchConfig(cmd.config);

  pushFeed(controlFeedTag(result), controlFeedLine(cmd, result));

  // 200 with the named state in the body, matching /api/dragon: the request
  // DID reach his app, and `state` is the answer it gave.
  return Response.json(result);
}
