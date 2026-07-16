import { readVitals } from "@/lib/metrics";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(readVitals());
}
