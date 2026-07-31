import { getFunding, setLeadStatus, type FundingStatus } from "@/lib/funding/store";

/**
 * FUNDING pipeline — backyard-banks leads as live state, behind the default
 * /api/* auth gate. GET → the store (self-seeds from the playbook doc on
 * first read). PATCH {id, status} → move a lead through
 * lead → prequal → applied → funded | dead.
 */

export const runtime = "nodejs";

export async function GET() {
  return Response.json(await getFunding());
}

const VALID = new Set(["lead", "prequal", "applied", "funded", "dead"]);

export async function PATCH(req: Request) {
  let body: { id?: unknown; status?: unknown };
  try {
    body = (await req.json()) as { id?: unknown; status?: unknown };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.id !== "string" || !VALID.has(String(body.status))) {
    return Response.json(
      { error: "need id + status in lead|prequal|applied|funded|dead" },
      { status: 400 },
    );
  }
  const store = await setLeadStatus(
    body.id,
    body.status as FundingStatus,
    new Date().toISOString(),
  );
  if (!store) return Response.json({ error: "unknown id" }, { status: 404 });
  return Response.json(store);
}
