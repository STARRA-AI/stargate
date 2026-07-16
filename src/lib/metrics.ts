import os from "os";

/**
 * Live process metrics for the HUD top bar. Token counts are estimated
 * (chars/4) and accumulated across chat calls for this server session.
 */

type Metrics = {
  startedAt: number;
  tokens: number;
  lastCpu: { idle: number; total: number } | null;
};

const g = globalThis as unknown as { __stargateMetrics?: Metrics };

function metrics(): Metrics {
  if (!g.__stargateMetrics) {
    g.__stargateMetrics = { startedAt: Date.now(), tokens: 0, lastCpu: null };
  }
  return g.__stargateMetrics;
}

export function addTokens(chars: number) {
  metrics().tokens += Math.max(1, Math.round(chars / 4));
}

function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
  }
  return { idle, total };
}

export function readVitals() {
  const m = metrics();
  const snap = cpuSnapshot();
  let cpuPct = 0;
  if (m.lastCpu) {
    const dIdle = snap.idle - m.lastCpu.idle;
    const dTotal = snap.total - m.lastCpu.total;
    cpuPct = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
  }
  m.lastCpu = snap;

  const memPct = Math.round((1 - os.freemem() / os.totalmem()) * 100);

  return {
    cpu: Math.min(100, Math.max(0, cpuPct)),
    mem: Math.min(100, Math.max(0, memPct)),
    tokens: m.tokens,
    uptime_seconds: Math.floor((Date.now() - m.startedAt) / 1000),
  };
}
