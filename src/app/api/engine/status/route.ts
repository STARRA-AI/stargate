/**
 * GET /api/engine/status — one read that answers "what is she actually running,
 * and what is broken right now".
 *
 * Behind src/middleware.ts (everything except /login and /api/auth is gated),
 * so an unauthenticated call gets a 401 before this handler runs.
 *
 * TWO DEPTHS, on purpose:
 *   default      cheap. readEngineConfig() is one stat + an mtime-cached parse
 *                (src/lib/engine/config.ts:282), then pure resolution. No
 *                network, so the panel can poll it without hammering upstreams.
 *   ?probe=1     deep. diagnostics() runs probeAll() — a real, timeout-bounded
 *                request per provider (health.ts, DEFAULT_PROBE_TIMEOUT_MS 3500).
 *                The panel uses this on open and on RECHECK, never on the poll.
 *
 * Nothing in here can block or delay audio: it is a separate request the deck
 * never awaits, and the panel only calls it while it is open.
 */

import {
  describeProviders,
  diagnostics,
  readEngineConfig,
  resolveAllCapabilities,
} from "@/lib/engine";
import {
  deriveFaults,
  faultBody,
  json,
  toProviderViews,
  toResolutionView,
} from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const deep = new URL(req.url).searchParams.get("probe") === "1";
    const cfg = await readEngineConfig();

    // Masked views only. toProviderViews is an allowlist projection, so no key
    // material can reach this response even if the registry ever carried it.
    if (deep) {
      const d = await diagnostics(cfg);
      const providers = toProviderViews(d.providers);
      const resolutions = Object.values(d.capabilities).map(toResolutionView);
      const broken = deriveFaults(providers, resolutions, d.broken);
      return json({
        ok: broken.every((f) => f.severity !== "error"),
        probed: true,
        checkedAt: new Date(d.at).toISOString(),
        capabilities: resolutions,
        providers,
        broken,
      });
    }

    const providers = toProviderViews(describeProviders(cfg));
    const resolutions = Object.values(resolveAllCapabilities(cfg)).map(toResolutionView);
    const broken = deriveFaults(providers, resolutions);
    return json({
      ok: broken.every((f) => f.severity !== "error"),
      probed: false,
      checkedAt: new Date().toISOString(),
      capabilities: resolutions,
      providers,
      broken,
    });
  } catch (err) {
    return json(faultBody(err), 500);
  }
}
