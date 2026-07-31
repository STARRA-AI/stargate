import { buildMorningBrief } from "@/lib/brief";

/** MORNING BRIEFING text — composed from every operational store, behind the
 *  default /api/* auth gate. The call leg appends it to her instructions when
 *  a briefing call is requested. */
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ brief: await buildMorningBrief() });
}
