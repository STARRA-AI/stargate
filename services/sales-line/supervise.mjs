/**
 * THE SUPERVISOR — keeps the sales line up without anyone watching it.
 *
 * WHY. `tunnel.mjs` already restarts cloudflared and re-points Twilio, but
 * NOTHING was restarting the bridge itself. That gap matters more than it looks:
 * Twilio's VoiceFallbackUrl is served BY the bridge, so a dead bridge takes the
 * fallback down with it and a lead calling back hears a carrier error tone
 * rather than a sentence. Both children are therefore supervised here.
 *
 * Restart policy is deliberately dumb and bounded: exponential backoff to 60s,
 * reset once a child has stayed up 30s. No health probes, no cleverness — the
 * failure this guards against is a crash, and a crash is visible in the exit.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILDREN = [
  { name: "bridge", script: "server.mjs" },
  { name: "tunnel", script: "tunnel.mjs" },
];

let stopping = false;
const procs = new Map();

function start(spec, backoff = 1000) {
  if (stopping) return;
  const startedAt = Date.now();
  const p = spawn(process.execPath, [path.join(HERE, spec.script)], {
    cwd: HERE,
    stdio: ["ignore", "inherit", "inherit"],
  });
  procs.set(spec.name, p);
  p.on("exit", (code, sig) => {
    procs.delete(spec.name);
    if (stopping) return;
    // A child that stayed up is healthy; only a fast crash-loop should back off.
    const next = Date.now() - startedAt > 30000 ? 1000 : Math.min(backoff * 2, 60000);
    console.error(
      `[supervise] ${spec.name} exited (code=${code} sig=${sig}) — restarting in ${next}ms`,
    );
    setTimeout(() => start(spec, next), next);
  });
  p.on("error", (e) => console.error(`[supervise] ${spec.name} failed to spawn: ${e.message}`));
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    console.log(`\n[supervise] ${sig} — stopping children`);
    for (const p of procs.values()) p.kill("SIGTERM");
    setTimeout(() => process.exit(0), 500);
  });
}

console.log("[supervise] starting bridge + tunnel");
for (const spec of CHILDREN) start(spec);
