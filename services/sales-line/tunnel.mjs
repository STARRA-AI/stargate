/**
 * THE TUNNEL SUPERVISOR — why a rotating hostname stopped being a blocker.
 *
 * Twilio has to reach this machine from the internet. The stable answer is a
 * Tailscale Funnel hostname, which needs Classic's browser login. Without him,
 * the free option is a cloudflared QUICK tunnel: no account, no cost, and a
 * hostname that CHANGES every single restart.
 *
 * A rotating hostname has already broken her voice tools repeatedly, so the
 * instinct is to treat it as a blocker. It is not one here, because Twilio's
 * `VoiceUrl` is settable over the API. When the hostname moves, we move the
 * webhook with it — automatically, within seconds, without anyone awake.
 *
 * This process therefore does three things forever:
 *   1. keeps a cloudflared quick tunnel pointed at the bridge,
 *   2. records the current hostname where the running bridge reads it, and
 *   3. re-points the Twilio number at the new hostname on every rotation.
 *
 * The moment SALES_PUBLIC_ORIGIN is pinned to a real Funnel hostname, this
 * whole file becomes unnecessary — origin.mjs prefers the pinned value, and
 * this supervisor refuses to fight it (see the guard below).
 */
import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV } from "./env.mjs";
import { writeOrigin, currentOrigin } from "./origin.mjs";
import { setVoiceWebhook } from "./twilio-admin.mjs";
import { edgeIsUp } from "./tunnel-policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(HERE, "logs", "cloudflared.log");
const BRIDGE_PORT = Number(process.env.PORT || 8790);
const HOST_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * Tail the cloudflared log for the hostname it prints. Polling a file is
 * deliberately unglamorous; see the stdio note in start() for why pipes are
 * not an option here.
 */
let logOffset = 0;
let logTimer = null;
function watchLogForHostname() {
  clearInterval(logTimer);
  logTimer = setInterval(() => {
    if (!existsSync(LOG_FILE)) return;
    let size;
    try {
      size = statSync(LOG_FILE).size;
    } catch {
      return;
    }
    if (size <= logOffset) return;
    let chunk = "";
    try {
      chunk = readFileSync(LOG_FILE, "utf8").slice(logOffset);
    } catch {
      return;
    }
    logOffset = size;
    const m = HOST_RE.exec(chunk);
    if (m && m[0] !== announced) {
      announced = m[0];
      void onHostname(m[0], child);
    }
  }, 1000);
}

let child = null;
let backoff = 1000;
let announced = "";
/** Consecutive hostnames that were issued but never served. */
let deadHostnames = 0;

/**
 * Wait for the bridge to answer locally before asking Cloudflare for a hostname.
 *
 * The supervisor starts the bridge and the tunnel at the same moment, so
 * without this the tunnel comes up first and its very first probe hits a bridge
 * that is still booting. Requesting a hostname we are not yet ready to serve is
 * how the churn loop started; waiting a couple of seconds costs nothing.
 */
async function waitForBridge(attempts = 30, gapMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`http://localhost:${BRIDGE_PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return true;
    } catch {
      /* still booting */
    }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  console.error("[tunnel] bridge never answered locally — starting the tunnel anyway");
  return false;
}

async function start() {
  await waitForBridge();
  console.log(`[tunnel] starting cloudflared quick tunnel -> http://localhost:${BRIDGE_PORT}`);
  // --protocol http2 IS THE FIX, and it is a root cause, not a workaround.
  // cloudflared defaults to QUIC (UDP). On Classic's connection QUIC registers
  // the tunnel and then dies immediately, every time:
  //   ERR failed to serve tunnel connection
  //       error="accept stream listener encountered a failure while serving"
  // — so a hostname is issued and NEVER serves. Measured 2026-08-22: five
  // consecutive QUIC tunnels issued hostnames that returned HTTP 000 forever,
  // while an http2 tunnel started seconds later answered 200 on the first probe
  // with ZERO errors in its log. His network has form here (the AT&T range
  // already blocks other services).
  // STDIO GOES TO A FILE, NOT PIPES — and that is load-bearing, not tidiness.
  // Measured 2026-08-22: cloudflared spawned with piped stdio kept losing its
  // edge connection and exiting on its own ("Connection terminated" / "no more
  // connections active and exiting"), so its hostname never served. The exact
  // same command writing to a FILE served HTTP 200 on the first probe with zero
  // errors, every time. So we mirror the configuration that works and read the
  // hostname by tailing the log.
  const fd = openSync(LOG_FILE, "a");
  child = spawn(
    "cloudflared",
    ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://localhost:${BRIDGE_PORT}`],
    { stdio: ["ignore", fd, fd] },
  );
  closeSync(fd);
  watchLogForHostname();

  child.on("exit", (code, sig) => {
    console.error(`[tunnel] cloudflared exited (code=${code} sig=${sig}) — restarting in ${backoff}ms`);
    announced = "";
    child = null;
    setTimeout(() => void start(), backoff);
    backoff = Math.min(backoff * 2, 60000);
  });
}

/**
 * A hostname is a PROMISE, not a fact. cloudflared says so itself: "Your quick
 * Tunnel has been created! Visit it at (it may take some time to be reachable)".
 * So the hostname is probed before Twilio is pointed at it.
 *
 * WHAT COUNTS AS "SERVING", and getting this wrong cost a whole night.
 *
 * The probe asks whether the TUNNEL is up, NOT whether the bridge is healthy.
 * Those are different questions with different answers:
 *
 *   fetch throws        -> the Cloudflare edge did not answer. The tunnel is
 *                          genuinely not serving. Discard it.
 *   ANY http status     -> the edge answered, so the tunnel IS serving. A 502
 *                          just means the origin was not up at that instant —
 *                          which is normal, because the supervisor restarts the
 *                          bridge and the tunnel at the same moment.
 *
 * The first version required `res.ok`, so a 502 during the bridge's own startup
 * read as "tunnel dead". It then killed a perfectly good tunnel and requested
 * another, over and over — and that self-inflicted churn is what tripped
 * trycloudflare's per-IP creation limit, after which new hostnames stopped
 * resolving at all (HTTP 000). The tunnels were never the problem.
 */
async function probe(origin, attempts = 20, gapMs = 3000) {
  for (let i = 0; i < attempts; i++) {
    let outcome = null;
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(6000) });
      outcome = { status: res.status };
    } catch {
      outcome = null; // nothing answered
    }
    // edgeIsUp, NOT res.ok — see tunnel-policy.mjs for why that distinction is
    // the whole bug.
    if (edgeIsUp(outcome)) return true;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

async function onHostname(origin, owner) {
  backoff = 1000; // a hostname means cloudflared at least registered
  console.log(`[tunnel] hostname issued: ${origin} — probing before trusting it…`);
  const live = await probe(origin);
  if (!live) {
    console.error(`[tunnel] ${origin} never served. Discarding it and rolling a new tunnel.`);
    // Do NOT record it and do NOT point Twilio at it: a dead hostname on the
    // number is worse than the old one, which at least still answers.
    announced = "";
    // BACK OFF. Rolling a fresh quick tunnel immediately makes this worse —
    // trycloudflare degrades under repeated requests from one IP, which is
    // exactly how this failure mode was reached (six tunnels in a few minutes,
    // 2026-08-22). Give the free tier room rather than hammering it.
    deadHostnames += 1;
    // Gentle, and deliberately so. Measured 2026-08-22: a healthy quick tunnel
    // registers connIndex 0-3; while trycloudflare is capping this IP only
    // connIndex=0 registers and then drops after ~75s. Retrying hard makes that
    // worse and burns his connection all night for nothing, so this settles to
    // one attempt every five minutes and waits the cap out.
    const wait = Math.min(20000 * deadHostnames, 300000);
    console.error(`[tunnel] waiting ${Math.round(wait / 1000)}s before requesting another hostname`);
    await new Promise((r) => setTimeout(r, wait));
    // KILL THE PROCESS THAT ISSUED THIS HOSTNAME, not whatever `child` happens
    // to point at now. Across the await above, `child` may already have been
    // replaced by a fresh spawn — killing that one orphans the original, and
    // two cloudflared instances then race on the same tunnel. Observed as
    // exactly that: two live processes and a hostname that never served.
    if (owner && !owner.killed) owner.kill("SIGTERM");
    return;
  }
  deadHostnames = 0;
  const recorded = writeOrigin(origin);
  console.log(`[tunnel] up and SERVING: ${recorded}`);
  try {
    const r = await setVoiceWebhook(recorded);
    console.log(
      r.changed
        ? `[tunnel] Twilio ${r.number} now answers at ${r.voiceUrl}` +
          (r.was ? ` (was ${r.was})` : " (was unset)")
        : `[tunnel] Twilio ${r.number} already pointed at ${r.voiceUrl}`,
    );
  } catch (e) {
    // Loud, and it keeps running: the tunnel is still useful for outbound /dial
    // even when we could not update the inbound webhook.
    console.error(`[tunnel] COULD NOT re-point Twilio: ${e.message}`);
    console.error("[tunnel] inbound callbacks will still go to the OLD url until this is fixed.");
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n[tunnel] ${sig} — stopping cloudflared`);
    if (child) child.kill("SIGTERM");
    process.exit(0);
  });
}

process.on("exit", () => { if (child) child.kill("SIGTERM"); });

console.log(`[tunnel] current recorded origin: ${currentOrigin(ENV) || "(none yet)"}`);

if (ENV.SALES_PUBLIC_ORIGIN) {
  console.log(
    `[tunnel] SALES_PUBLIC_ORIGIN is pinned to ${ENV.SALES_PUBLIC_ORIGIN} — ` +
      "a quick tunnel would be ignored. Not starting one.",
  );
  console.log("[tunnel] pointing Twilio at the pinned origin instead…");
  setVoiceWebhook(ENV.SALES_PUBLIC_ORIGIN)
    .then((r) => console.log(`[tunnel] webhook ${r.changed ? "updated" : "already correct"}: ${r.voiceUrl}`))
    .catch((e) => console.error(`[tunnel] webhook FAILED: ${e.message}`));
} else {
  void start();
}
