import {
  buildResearchPlan,
  getOpenAliceCapabilities,
  getOpenAliceStatus,
  listOpenAliceInbox,
  listOpenAliceIssues,
  submitTradeIntent,
} from "@/lib/tools/openalice";
import { pushFeed } from "@/lib/feed";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "status";

  if (action === "status") {
    return Response.json(await getOpenAliceStatus());
  }

  if (action === "capabilities") {
    return Response.json({ capabilities: getOpenAliceCapabilities() });
  }

  if (action === "issues") {
    const result = await listOpenAliceIssues();
    if (!result.ok) {
      return Response.json(
        { error: result.error },
        { status: result.status && result.status < 500 ? result.status : 502 },
      );
    }
    return Response.json(result.data);
  }

  if (action === "inbox") {
    const result = await listOpenAliceInbox();
    if (!result.ok) {
      return Response.json(
        { error: result.error },
        { status: result.status && result.status < 500 ? result.status : 502 },
      );
    }
    return Response.json(result.data);
  }

  if (action === "plan") {
    const query = url.searchParams.get("q") ?? "";
    return Response.json(buildResearchPlan(query));
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    mode?: "plan" | "trade-intent";
    query?: string;
    action?: string;
    confirmToken?: string;
  };

  if (body.mode === "plan" || (!body.mode && body.query)) {
    return Response.json(buildResearchPlan(body.query ?? ""));
  }

  if (body.mode === "trade-intent" || body.action) {
    const result = await submitTradeIntent({
      action: body.action ?? "",
      confirmToken: body.confirmToken,
    });
    if (!result.ok) {
      return Response.json(
        { error: result.message, token: result.token },
        { status: result.token ? 428 : 400 },
      );
    }
    pushFeed("EXEC", `OpenAlice intent · ${result.action.slice(0, 60)}`);
    return Response.json(result);
  }

  return Response.json({ error: "unknown mode" }, { status: 400 });
}
