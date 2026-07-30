/**
 * POST /api/engine/test — { id } → run that provider's health probe.
 *
 * The probe lives in the engine (src/lib/engine/health.ts), which sends the
 * credential in a HEADER, never a URL or query string, under a bounded timeout.
 * This route validates the id, times the round trip, and scrubs the returned
 * text: a failing upstream loves to echo the Authorization header into its error
 * body, so `detail` goes through scrubMessage before it is allowed near the
 * client even though the engine already redacts it. Two locks, not one.
 *
 * ProviderHealth (providers.ts:280) is { id, status, reachable, detail, checkedAt }
 * — there is no `ok` and no `latencyMs`, so this route derives both: ok is
 * `reachable === true`, and latency is measured here.
 *
 * A probe that throws is reported as not-ok with a reason — never a 500, never a
 * stack. Degrade, never throw.
 */

import { describeProviders, probeProvider, readEngineConfig } from "@/lib/engine";
import {
  errorBody,
  faultBody,
  json,
  providerIdSchema,
  scrubMessage,
  toProviderViews,
  zodMessage,
} from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json(errorBody("Rejected — body was not valid JSON."), 400);
    }

    const cfg = await readEngineConfig();
    const registry = toProviderViews(describeProviders(cfg));
    const parsed = providerIdSchema(registry.map((p) => p.id)).safeParse(raw);
    if (!parsed.success) {
      return json(errorBody(zodMessage(parsed.error.issues)), 400);
    }
    const { id } = parsed.data;
    const label = registry.find((p) => p.id === id)?.label ?? id;

    const started = Date.now();
    try {
      const health = await probeProvider(id, cfg);
      const reachable = health.reachable;
      const detail = health.detail ? scrubMessage(health.detail, 200) : "";
      return json({
        id,
        label,
        ok: reachable === true,
        probed: reachable !== null,
        status: health.status,
        latencyMs: Date.now() - started,
        detail,
        // `error` is populated only on a real failure, so the panel can show a
        // clean "no probe available" instead of inventing a fault.
        error: reachable === false ? detail || "probe failed" : null,
      });
    } catch (err) {
      return json({
        id,
        label,
        ok: false,
        probed: true,
        status: "unreachable",
        latencyMs: Date.now() - started,
        detail: "",
        error: scrubMessage(err),
      });
    }
  } catch (err) {
    return json(faultBody(err), 500);
  }
}
