import {
  createIssueStub,
  getMulticaStatus,
  listAgents,
  listIssues,
  listWorkspaces,
  quickCreateIssue,
} from "@/lib/tools/multica";
import { pushFeed } from "@/lib/feed";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "status";
  const workspaceId = url.searchParams.get("workspaceId") ?? undefined;

  if (action === "status") {
    return Response.json(await getMulticaStatus());
  }

  if (action === "workspaces") {
    const result = await listWorkspaces();
    if (!result.ok) {
      return Response.json(
        { error: result.error },
        { status: result.status && result.status < 500 ? result.status : 502 },
      );
    }
    return Response.json({ workspaces: result.data });
  }

  if (action === "issues") {
    const result = await listIssues(workspaceId);
    if (!result.ok) {
      return Response.json(
        { error: result.error },
        { status: result.status && result.status < 500 ? result.status : 502 },
      );
    }
    return Response.json(result.data);
  }

  if (action === "agents") {
    const result = await listAgents(workspaceId);
    if (!result.ok) {
      return Response.json(
        { error: result.error },
        { status: result.status && result.status < 500 ? result.status : 502 },
      );
    }
    return Response.json(result.data);
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}

export async function POST(req: Request) {
  let body: {
    mode?: "issue" | "quick";
    title?: string;
    description?: string;
    prompt?: string;
    workspaceId?: string;
    agentId?: string;
  };
  try {
    body = (await req.json()) as {
      mode?: "issue" | "quick";
      title?: string;
      description?: string;
      prompt?: string;
      workspaceId?: string;
      agentId?: string;
    };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (body.mode === "quick") {
    const prompt = body.prompt?.trim() || body.title?.trim();
    if (!prompt) {
      return Response.json({ error: "prompt required" }, { status: 400 });
    }
    const result = await quickCreateIssue({
      prompt,
      workspaceId: body.workspaceId,
      agentId: body.agentId,
    });
    if (!result.ok) {
      return Response.json(
        { error: result.error },
        { status: result.status && result.status < 500 ? result.status : 502 },
      );
    }
    pushFeed("EXEC", `Multica quick-create · ${result.data.task_id ?? "queued"}`);
    return Response.json(result.data);
  }

  const title = body.title?.trim();
  if (!title) {
    return Response.json({ error: "title required" }, { status: 400 });
  }

  const result = await createIssueStub({
    title,
    description: body.description,
    workspaceId: body.workspaceId,
    assigneeAgentId: body.agentId,
  });

  if (!result.ok) {
    return Response.json(
      { error: result.error },
      { status: result.status && result.status < 500 ? result.status : 502 },
    );
  }

  pushFeed(
    "EXEC",
    `Multica issue · ${result.data.identifier ?? result.data.id ?? title.slice(0, 40)}`,
  );
  return Response.json(result.data);
}
