import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getKey } from "@/lib/keys";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const VENDOR = path.join(ROOT, "vendor", "multica");
export const DEFAULT_MULTICA_BASE_URL = "https://api.multica.ai";

export type MulticaWorkspace = {
  id: string;
  name: string;
  slug: string;
};

export type MulticaIssueStub = {
  id?: string;
  identifier?: string;
  title?: string;
  status?: string;
  priority?: string;
};

export type MulticaStatus = {
  vendorPresent: boolean;
  vendorPath: string;
  cliPresent: boolean;
  cliVersion: string | null;
  tokenLinked: boolean;
  baseUrl: string;
  guide: string;
};

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectCli(): Promise<{ present: boolean; version: string | null }> {
  try {
    const { stdout } = await execFileAsync("multica", ["version"], {
      timeout: 4000,
      env: process.env,
    });
    const version = stdout.trim().split("\n")[0] || null;
    return { present: true, version };
  } catch {
    return { present: false, version: null };
  }
}

export async function resolveBaseUrl(): Promise<string> {
  const override = (await getKey("multica_base_url"))?.replace(/\/+$/, "");
  return override || DEFAULT_MULTICA_BASE_URL;
}

export async function getMulticaStatus(): Promise<MulticaStatus> {
  const vendorPresent = await exists(path.join(VENDOR, "README.md"));
  const cli = await detectCli();
  const token = await getKey("multica_token");
  const baseUrl = await resolveBaseUrl();
  return {
    vendorPresent,
    vendorPath: path.relative(ROOT, VENDOR),
    cliPresent: cli.present,
    cliVersion: cli.version,
    tokenLinked: Boolean(token),
    baseUrl,
    guide: token
      ? "Token linked. List workspaces/issues from Tools or create an issue stub."
      : vendorPresent
        ? "Link multica_token in Settings → LINK APIS. Optional: brew install multica-ai/tap/multica"
        : "Run: bash scripts/bootstrap-multica.sh — then link multica_token in Settings.",
  };
}

type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

async function multicaFetch(
  method: string,
  apiPath: string,
  opts?: { workspaceId?: string; body?: unknown },
): Promise<ApiResult<unknown>> {
  const token = await getKey("multica_token");
  if (!token) {
    return { ok: false, error: "multica_token not linked" };
  }
  const baseUrl = await resolveBaseUrl();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "X-Client-Platform": "stargate",
    "X-Client-Version": "0.1.0",
  };
  if (opts?.workspaceId) {
    headers["X-Workspace-ID"] = opts.workspaceId;
  }
  let body: string | undefined;
  if (opts?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  try {
    const res = await fetch(`${baseUrl}${apiPath}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(25000),
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
      const msg =
        typeof parsed === "object" &&
        parsed &&
        "error" in parsed &&
        typeof (parsed as { error: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : text.slice(0, 400) || `HTTP ${res.status}`;
      return { ok: false, error: msg, status: res.status };
    }
    return { ok: true, data: parsed };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Multica request failed",
    };
  }
}

function asWorkspaces(data: unknown): MulticaWorkspace[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((w) => {
      if (!w || typeof w !== "object") return null;
      const o = w as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : "";
      if (!id) return null;
      return {
        id,
        name: typeof o.name === "string" ? o.name : id,
        slug: typeof o.slug === "string" ? o.slug : "",
      };
    })
    .filter((w): w is MulticaWorkspace => Boolean(w));
}

function asIssues(data: unknown): MulticaIssueStub[] {
  const root =
    data && typeof data === "object" && "issues" in data
      ? (data as { issues: unknown }).issues
      : data;
  if (!Array.isArray(root)) return [];
  return root.slice(0, 25).map((item) => {
    const o = (item && typeof item === "object" ? item : {}) as Record<
      string,
      unknown
    >;
    return {
      id: typeof o.id === "string" ? o.id : undefined,
      identifier:
        typeof o.identifier === "string"
          ? o.identifier
          : typeof o.key === "string"
            ? o.key
            : undefined,
      title: typeof o.title === "string" ? o.title : undefined,
      status: typeof o.status === "string" ? o.status : undefined,
      priority: typeof o.priority === "string" ? o.priority : undefined,
    };
  });
}

export async function listWorkspaces(): Promise<ApiResult<MulticaWorkspace[]>> {
  const result = await multicaFetch("GET", "/api/workspaces");
  if (!result.ok) return result;
  return { ok: true, data: asWorkspaces(result.data) };
}

export async function listIssues(workspaceId?: string): Promise<
  ApiResult<{ workspaceId: string; issues: MulticaIssueStub[] }>
> {
  let wsId = workspaceId?.trim();
  if (!wsId) {
    const ws = await listWorkspaces();
    if (!ws.ok) return ws;
    if (!ws.data.length) {
      return { ok: false, error: "No Multica workspaces on this token" };
    }
    wsId = ws.data[0].id;
  }
  const result = await multicaFetch("GET", "/api/issues?limit=20", {
    workspaceId: wsId,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    data: { workspaceId: wsId, issues: asIssues(result.data) },
  };
}

async function resolveWorkspaceId(
  workspaceId?: string,
): Promise<ApiResult<string>> {
  const wsId = workspaceId?.trim();
  if (wsId) return { ok: true, data: wsId };
  const ws = await listWorkspaces();
  if (!ws.ok) return ws;
  if (!ws.data.length) {
    return { ok: false, error: "No Multica workspaces on this token" };
  }
  return { ok: true, data: ws.data[0].id };
}

export async function listAgents(workspaceId?: string): Promise<
  ApiResult<{ workspaceId: string; agents: { id: string; name: string }[] }>
> {
  const ws = await resolveWorkspaceId(workspaceId);
  if (!ws.ok) return ws;
  const result = await multicaFetch("GET", "/api/agents?limit=50", {
    workspaceId: ws.data,
  });
  if (!result.ok) return result;
  const root =
    result.data && typeof result.data === "object" && "agents" in result.data
      ? (result.data as { agents: unknown }).agents
      : result.data;
  const agents = Array.isArray(root)
    ? root
        .map((item) => {
          const o = (item && typeof item === "object"
            ? item
            : {}) as Record<string, unknown>;
          const id = typeof o.id === "string" ? o.id : "";
          if (!id) return null;
          const name =
            typeof o.name === "string"
              ? o.name
              : typeof o.display_name === "string"
                ? o.display_name
                : id;
          return { id, name };
        })
        .filter((a): a is { id: string; name: string } => Boolean(a))
    : [];
  return { ok: true, data: { workspaceId: ws.data, agents } };
}

export async function createIssueStub(input: {
  title: string;
  description?: string;
  workspaceId?: string;
  assigneeAgentId?: string;
}): Promise<ApiResult<MulticaIssueStub>> {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "title required" };

  const ws = await resolveWorkspaceId(input.workspaceId);
  if (!ws.ok) return ws;
  const wsId = ws.data;

  const body: Record<string, string> = {
    title,
    workspace_id: wsId,
  };
  if (input.description?.trim()) {
    body.description = input.description.trim();
  }
  if (input.assigneeAgentId?.trim()) {
    body.assignee_id = input.assigneeAgentId.trim();
  }

  // Prefer query workspace_id (Multica HTTP contract) + header for daemon parity.
  const result = await multicaFetch(
    "POST",
    `/api/issues?workspace_id=${encodeURIComponent(wsId)}`,
    { workspaceId: wsId, body },
  );
  if (!result.ok) return result;
  const o = (result.data && typeof result.data === "object"
    ? result.data
    : {}) as Record<string, unknown>;
  return {
    ok: true,
    data: {
      id: typeof o.id === "string" ? o.id : undefined,
      identifier:
        typeof o.identifier === "string" ? o.identifier : undefined,
      title: typeof o.title === "string" ? o.title : title,
      status: typeof o.status === "string" ? o.status : undefined,
      priority: typeof o.priority === "string" ? o.priority : undefined,
    },
  };
}

/** Quick-create: create issue + enqueue agent run in one shot. */
export async function quickCreateIssue(input: {
  prompt: string;
  workspaceId?: string;
  agentId?: string;
}): Promise<ApiResult<{ task_id?: string; raw: unknown }>> {
  const prompt = input.prompt.trim();
  if (!prompt) return { ok: false, error: "prompt required" };
  const ws = await resolveWorkspaceId(input.workspaceId);
  if (!ws.ok) return ws;
  const body: Record<string, string> = { prompt };
  if (input.agentId?.trim()) body.agent_id = input.agentId.trim();
  const result = await multicaFetch(
    "POST",
    `/api/issues/quick-create?workspace_id=${encodeURIComponent(ws.data)}`,
    { workspaceId: ws.data, body },
  );
  if (!result.ok) return result;
  const o = (result.data && typeof result.data === "object"
    ? result.data
    : {}) as Record<string, unknown>;
  return {
    ok: true,
    data: {
      task_id: typeof o.task_id === "string" ? o.task_id : undefined,
      raw: result.data,
    },
  };
}
