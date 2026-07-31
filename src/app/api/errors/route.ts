import { recentErrors } from "@/lib/errlog";

/** ERROR TRACKING readout — newest captured failures, behind the default
 *  /api/* auth gate. GET ?limit=n (max 200). */
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  return Response.json({ errors: recentErrors(Number.isFinite(limit) ? limit : 50) });
}
