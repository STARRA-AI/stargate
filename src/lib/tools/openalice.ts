import { promises as fs } from "fs";
import path from "path";
import { getKey } from "@/lib/keys";
import {
  classifyTradeAction,
  confirmTrade,
  gateTradeAction,
} from "@/lib/security/trade-gate";

const ROOT = process.cwd();
const VENDOR = path.join(ROOT, "vendor", "openalice");
export const DEFAULT_OPENALICE_BASE_URL = "http://127.0.0.1:47331";

export type OpenAliceCapability = {
  id: string;
  surface: string;
  mode: "read" | "write_gated" | "external_runtime";
  summary: string;
};

export const OPENALICE_CAPABILITIES: OpenAliceCapability[] = [
  {
    id: "market_research",
    surface: "Market data · news · fundamentals · technicals",
    mode: "read",
    summary: "Equities, crypto, macro, symbol search — no broker account required.",
  },
  {
    id: "tracked_entities",
    surface: "Tracked entities · wikilinks",
    mode: "read",
    summary: "Durable graph for tickers, themes, sectors, theses, and people.",
  },
  {
    id: "issue_board",
    surface: "Issue board · scheduled research runs",
    mode: "read",
    summary: "Markdown-backed work items across workspaces; STARGATE lists, does not mutate.",
  },
  {
    id: "inbox",
    surface: "Inbox · agent reports",
    mode: "read",
    summary: "Finished research and scheduled run output — readout only in STARGATE.",
  },
  {
    id: "trading_as_git",
    surface: "Trading-as-Git · UTA brokers",
    mode: "write_gated",
    summary:
      "Alpaca, IBKR, Longbridge, CCXT — staged in OpenAlice; STARGATE never auto-pushes orders.",
  },
  {
    id: "workspaces",
    surface: "Workspaces · native agent CLIs",
    mode: "external_runtime",
    summary: "Full loop runs in OpenAlice runtime — not embedded in STARGATE HUD.",
  },
];

export type OpenAliceStatus = {
  vendorPresent: boolean;
  vendorPath: string;
  vendorVersion: string | null;
  runtimeUrl: string;
  runtimeReachable: boolean;
  runtimeVersion: string | null;
  tradingAvailable: boolean | null;
  tradingMode: string | null;
  executionGate: "locked" | "runtime_offline" | "keys_required" | "confirm_required";
  brokerKeysLinked: boolean;
  capabilities: OpenAliceCapability[];
  guide: string;
};

export type OpenAliceIssueStub = {
  wsId?: string;
  id?: string;
  title?: string;
  status?: string;
  priority?: string;
};

export type OpenAliceInboxStub = {
  id?: string;
  title?: string;
  workspaceId?: string;
  at?: number;
  preview?: string;
};

export type OpenAliceResearchPlan = {
  query: string;
  steps: string[];
  readout: string;
  executionNote: string;
};

type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readVendorVersion(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(VENDOR, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export async function resolveBaseUrl(): Promise<string> {
  const override = (await getKey("openalice_base_url"))?.replace(/\/+$/, "");
  return override || DEFAULT_OPENALICE_BASE_URL;
}

async function brokerKeysLinked(): Promise<boolean> {
  const [alpacaKey, alpacaSecret] = await Promise.all([
    getKey("openalice_alpaca_key_id"),
    getKey("openalice_alpaca_secret_key"),
  ]);
  return Boolean(alpacaKey && alpacaSecret);
}

function resolveExecutionGate(input: {
  runtimeReachable: boolean;
  brokerKeysLinked: boolean;
}): OpenAliceStatus["executionGate"] {
  if (!input.runtimeReachable) return "runtime_offline";
  if (!input.brokerKeysLinked) return "keys_required";
  return "confirm_required";
}

export async function getOpenAliceStatus(): Promise<OpenAliceStatus> {
  const vendorPresent = await exists(path.join(VENDOR, "README.md"));
  const vendorVersion = vendorPresent ? await readVendorVersion() : null;
  const runtimeUrl = await resolveBaseUrl();
  const keysLinked = await brokerKeysLinked();

  let runtimeReachable = false;
  let runtimeVersion: string | null = null;
  let tradingAvailable: boolean | null = null;
  let tradingMode: string | null = null;

  const versionProbe = await openAliceFetch("/api/version");
  if (versionProbe.ok) {
    runtimeReachable = true;
    const v = versionProbe.data as Record<string, unknown>;
    runtimeVersion =
      typeof v.version === "string"
        ? v.version
        : typeof v.current === "string"
          ? v.current
          : null;
  }

  if (runtimeReachable) {
    const tradingProbe = await openAliceFetch("/api/trading/status");
    if (tradingProbe.ok) {
      const t = tradingProbe.data as Record<string, unknown>;
      tradingAvailable = t.available === true;
      tradingMode =
        typeof t.mode === "string"
          ? t.mode
          : typeof t.state === "string"
            ? t.state
            : null;
    }
  }

  const executionGate = resolveExecutionGate({
    runtimeReachable,
    brokerKeysLinked: keysLinked,
  });

  let guide: string;
  if (!vendorPresent) {
    guide =
      "Run: bash scripts/bootstrap-openalice.sh — then start OpenAlice runtime separately.";
  } else if (!runtimeReachable) {
    guide =
      "Vendor present. Start runtime: cd vendor/openalice && pnpm install && pnpm dev — or openalice server start. Link openalice_base_url if non-default.";
  } else if (!keysLinked) {
    guide =
      "Runtime online. Research + inbox available. Link Alpaca keys in Settings only if you intend broker-backed flows in OpenAlice.";
  } else {
    guide =
      "Runtime online · broker keys linked. STARGATE readout only — trade intents require operator confirm; execution finishes in OpenAlice.";
  }

  return {
    vendorPresent,
    vendorPath: path.relative(ROOT, VENDOR),
    vendorVersion,
    runtimeUrl,
    runtimeReachable,
    runtimeVersion,
    tradingAvailable,
    tradingMode,
    executionGate,
    brokerKeysLinked: keysLinked,
    capabilities: OPENALICE_CAPABILITIES,
    guide,
  };
}

async function openAliceFetch(apiPath: string): Promise<ApiResult<unknown>> {
  const baseUrl = await resolveBaseUrl();
  try {
    const res = await fetch(`${baseUrl}${apiPath}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      return {
        ok: false,
        error: text.slice(0, 400) || `HTTP ${res.status}`,
        status: res.status,
      };
    }
    return { ok: true, data: parsed };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "OpenAlice request failed",
    };
  }
}

function flattenIssues(data: unknown): OpenAliceIssueStub[] {
  const root =
    data && typeof data === "object" && "workspaces" in data
      ? (data as { workspaces: unknown }).workspaces
      : data;
  if (!Array.isArray(root)) return [];
  const out: OpenAliceIssueStub[] = [];
  for (const ws of root) {
    if (!ws || typeof ws !== "object") continue;
    const w = ws as Record<string, unknown>;
    const wsId = typeof w.wsId === "string" ? w.wsId : undefined;
    const issues = Array.isArray(w.issues) ? w.issues : [];
    for (const item of issues.slice(0, 12)) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      out.push({
        wsId,
        id: typeof o.id === "string" ? o.id : undefined,
        title: typeof o.title === "string" ? o.title : undefined,
        status: typeof o.status === "string" ? o.status : undefined,
        priority: typeof o.priority === "string" ? o.priority : undefined,
      });
    }
  }
  return out.slice(0, 25);
}

function flattenInbox(data: unknown): OpenAliceInboxStub[] {
  const entries =
    data && typeof data === "object" && "entries" in data
      ? (data as { entries: unknown }).entries
      : data;
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, 25).map((item) => {
    const o = (item && typeof item === "object" ? item : {}) as Record<
      string,
      unknown
    >;
    const body =
      typeof o.body === "string"
        ? o.body
        : typeof o.summary === "string"
          ? o.summary
          : "";
    return {
      id: typeof o.id === "string" ? o.id : undefined,
      title: typeof o.title === "string" ? o.title : undefined,
      workspaceId:
        typeof o.workspaceId === "string"
          ? o.workspaceId
          : typeof o.workspace_id === "string"
            ? o.workspace_id
            : undefined,
      at: typeof o.at === "number" ? o.at : undefined,
      preview: body ? body.slice(0, 160) : undefined,
    };
  });
}

export async function listOpenAliceIssues(): Promise<
  ApiResult<{ issues: OpenAliceIssueStub[] }>
> {
  const status = await getOpenAliceStatus();
  if (!status.runtimeReachable) {
    return { ok: false, error: "OpenAlice runtime offline" };
  }
  const result = await openAliceFetch("/api/issues");
  if (!result.ok) return result;
  return { ok: true, data: { issues: flattenIssues(result.data) } };
}

export async function listOpenAliceInbox(): Promise<
  ApiResult<{ entries: OpenAliceInboxStub[] }>
> {
  const status = await getOpenAliceStatus();
  if (!status.runtimeReachable) {
    return { ok: false, error: "OpenAlice runtime offline" };
  }
  const result = await openAliceFetch("/api/inbox/history?limit=20");
  if (!result.ok) return result;
  return { ok: true, data: { entries: flattenInbox(result.data) } };
}

export function buildResearchPlan(query: string): OpenAliceResearchPlan {
  const q = query.trim() || "sector scan";
  return {
    query: q,
    steps: [
      `Ask Alice: ${q}`,
      "Track durable entities (tickers, themes, risks) as wikilinks",
      "File an issue if the work should recur or run headless",
      "Read agent output in Inbox — surface here as READOUT only",
      "Any trade idea stays staged in OpenAlice Trading-as-Git until Charles pushes",
    ],
    readout:
      "Plan only — no live quotes or portfolio numbers invented by STARGATE.",
    executionNote:
      "Broker execution disabled from STARGATE. Operator confirms intents; OpenAlice owns venue writes.",
  };
}

export type TradeIntentResult =
  | { ok: true; logged: true; action: string; message: string }
  | { ok: false; message: string; token?: string };

export async function submitTradeIntent(input: {
  action: string;
  confirmToken?: string;
}): Promise<TradeIntentResult> {
  const action = input.action.trim();
  if (!action) {
    return { ok: false, message: "action required" };
  }

  if (classifyTradeAction(action) === "read") {
    return {
      ok: false,
      message: "Not a trade execution action — use status/issues/inbox/plan instead.",
    };
  }

  const status = await getOpenAliceStatus();
  if (!status.runtimeReachable) {
    return { ok: false, message: "OpenAlice runtime offline — cannot log trade intent." };
  }
  if (!status.brokerKeysLinked) {
    return {
      ok: false,
      message:
        "Broker keys not linked in Settings. STARGATE will not stage trades without openalice_alpaca_key_id + openalice_alpaca_secret_key.",
    };
  }

  if (input.confirmToken) {
    const approved = confirmTrade(input.confirmToken);
    if (!approved || approved !== action) {
      return { ok: false, message: "Invalid or expired confirm token." };
    }
    return {
      ok: true,
      logged: true,
      action,
      message:
        `Intent logged: ${action}. Complete staging/commit/push in OpenAlice Trading-as-Git — STARGATE does not relay orders.`,
    };
  }

  const gated = gateTradeAction(action);
  if (gated.ok) {
    return {
      ok: true,
      logged: true,
      action,
      message: "Intent logged — complete in OpenAlice.",
    };
  }
  return { ok: false, message: gated.message, token: gated.token };
}

export function getOpenAliceCapabilities(): OpenAliceCapability[] {
  return OPENALICE_CAPABILITIES;
}
