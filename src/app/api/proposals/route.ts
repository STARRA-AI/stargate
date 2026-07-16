import { decideProposal, getDeck } from "@/lib/deck-store";

export const runtime = "nodejs";

export async function GET() {
  const deck = await getDeck();
  return Response.json({
    proposals: deck.proposals,
    ventures: deck.ventures,
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    id?: number;
    action?: "approve" | "later";
  };
  if (typeof body.id !== "number" || !body.action) {
    return Response.json({ error: "id and action required" }, { status: 400 });
  }
  const state = await decideProposal(body.id, body.action);
  return Response.json({
    proposals: state.proposals,
    ventures: state.ventures,
  });
}
