import { readStaged } from "@/lib/social/instagram-store";

export const runtime = "nodejs";

/**
 * INSTAGRAM (G9) — link/staged readout. Follows the Kalshi not-linked
 * discipline: HTTP 200 with { linked:false, reason } until Meta creds are
 * linked; never a thrown 500, never fabricated data.
 */
export async function GET() {
  return Response.json({
    linked: false,
    reason: "Link a Meta developer app (IG Content Publishing) at Settings → Link APIs",
    staged: readStaged(),
  });
}
