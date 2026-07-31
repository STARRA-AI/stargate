import {
  extractTrustMrr,
  scoreCandidate,
  type FlipVerdict,
} from "@/lib/flipradar/scan";
import { getRadar, setStatus, upsertScan } from "@/lib/flipradar/store";

/**
 * FLIP RADAR — the clone-and-flip revenue hunter, behind the middleware's
 * default /api/* auth gate.
 *
 *   GET    → the radar store (entries + lastScanAt)
 *   POST   {action:"scan", force?} → fetch TrustMRR, fold new candidates in,
 *          score up to 6 fresh ones on the free driver. Once per 20h unless
 *          force (the deck panel's SCAN button forces).
 *   PATCH  {id, status} → operator verdict: approved | passed | building | new
 */

export const runtime = "nodejs";

const SCAN_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
const SCORE_BUDGET_PER_SCAN = 6; // bound the free-tier LLM calls per scan
const KEEP_TOP = 12; // radar takes the top listings per scan, not the firehose

export async function GET() {
  return Response.json(await getRadar());
}

export async function POST(req: Request) {
  let body: { action?: string; force?: boolean };
  try {
    body = (await req.json()) as { action?: string; force?: boolean };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (body.action !== "scan") {
    return Response.json({ error: "action must be 'scan'" }, { status: 400 });
  }

  const store = await getRadar();
  const now = new Date();
  if (
    !body.force &&
    store.lastScanAt &&
    now.getTime() - new Date(store.lastScanAt).getTime() < SCAN_MIN_INTERVAL_MS
  ) {
    return Response.json({ ...store, skipped: "scanned recently" });
  }

  let html = "";
  try {
    const res = await fetch("https://trustmrr.com", {
      headers: { "User-Agent": "Mozilla/5.0 (STARGATE deck; personal use)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) html = await res.text();
  } catch {
    /* source down → empty scan, radar unchanged below */
  }

  const candidates = extractTrustMrr(html).slice(0, KEEP_TOP);
  if (candidates.length === 0) {
    return Response.json({ ...store, skipped: "source unavailable" });
  }

  // Score only candidates the radar hasn't seen — sequentially, to stay polite
  // to the free tier. Failures leave verdict null; the listing still lands.
  const known = new Set(store.entries.map((e) => e.id));
  const fresh = candidates.filter((c) => !known.has(c.id));
  const verdicts = new Map<string, FlipVerdict | null>();
  for (const c of fresh.slice(0, SCORE_BUDGET_PER_SCAN)) {
    verdicts.set(c.id, await scoreCandidate(c));
  }

  const updated = await upsertScan(candidates, verdicts, now.toISOString());
  return Response.json({ ...updated, scanned: candidates.length, fresh: fresh.length });
}

const STATUSES = new Set(["new", "approved", "passed", "building"]);

export async function PATCH(req: Request) {
  let body: { id?: unknown; status?: unknown };
  try {
    body = (await req.json()) as { id?: unknown; status?: unknown };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.id !== "string" || !STATUSES.has(String(body.status))) {
    return Response.json(
      { error: "need id + status in new|approved|passed|building" },
      { status: 400 },
    );
  }
  const store = await setStatus(
    body.id,
    body.status as "new" | "approved" | "passed" | "building",
    new Date().toISOString(),
  );
  if (!store) return Response.json({ error: "unknown id" }, { status: 404 });
  return Response.json(store);
}
