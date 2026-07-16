import { getKey } from "@/lib/keys";

export const runtime = "nodejs";

/**
 * Site Telemetry — real uptime probe of dragontradar.com plus optional
 * operator-provided stats endpoint (LINK API in settings).
 */

type Probe = { up: boolean; ms: number; status: number };

const g = globalThis as unknown as {
  __telemetry?: { at: number; probe: Probe; history: boolean[] };
};

async function probeSite(url: string): Promise<Probe> {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    return { up: res.ok, ms: Date.now() - start, status: res.status };
  } catch {
    return { up: false, ms: Date.now() - start, status: 0 };
  }
}

export async function GET() {
  const now = Date.now();
  if (!g.__telemetry || now - g.__telemetry.at > 30_000) {
    const probe = await probeSite("https://dragontradar.com");
    const history = [...(g.__telemetry?.history ?? []), probe.up].slice(-100);
    g.__telemetry = { at: now, probe, history };
  }

  const { probe, history } = g.__telemetry;
  const upPct = history.length
    ? ((history.filter(Boolean).length / history.length) * 100).toFixed(2)
    : "0.00";

  // Optional real stats from operator's own endpoint
  let stats: Record<string, unknown> | null = null;
  const statsUrl = await getKey("dragontradar_url");
  if (statsUrl) {
    try {
      const token = await getKey("dragontradar_token");
      const res = await fetch(statsUrl, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      });
      if (res.ok) stats = (await res.json()) as Record<string, unknown>;
    } catch {
      /* stats endpoint unreachable */
    }
  }

  return Response.json({
    site: "dragontradar.com",
    up: probe.up,
    latencyMs: probe.ms,
    httpStatus: probe.status,
    uptimePct: upPct,
    samples: history.length,
    stats,
    statsLinked: Boolean(statsUrl),
  });
}
