/**
 * THE PUBLIC ORIGIN — and why it is a file rather than a constant.
 *
 * Twilio has to reach this machine from the internet, so the bridge needs a
 * public https origin. The stable answer is a Tailscale Funnel hostname, which
 * needs Classic's browser login. The answer available without him is a
 * cloudflared QUICK tunnel — free, no account, and its hostname ROTATES on every
 * restart.
 *
 * A rotating hostname baked into a constant at boot is exactly what has been
 * breaking her voice tools: the tunnel restarts, the hostname moves, and every
 * call fails against an address nothing answers on any more.
 *
 * So the origin lives in a FILE that `tunnel.mjs` rewrites whenever the tunnel
 * comes up, and the server reads it per request. The tunnel may rotate as often
 * as it likes; the supervisor re-points Twilio's webhook at the new hostname
 * over the API, and the running bridge picks it up without a restart.
 *
 * Precedence: SALES_PUBLIC_ORIGIN in the environment always wins. Set that once
 * a Funnel hostname exists and this whole mechanism becomes inert.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ORIGIN_FILE = path.join(HERE, "runtime", "origin.json");

const clean = (o) => String(o || "").trim().replace(/\/+$/, "");

/** The origin Twilio should use right now, or "" if there is none. */
export function currentOrigin(env = process.env) {
  const pinned = clean(env.SALES_PUBLIC_ORIGIN);
  if (pinned) return pinned;
  try {
    const j = JSON.parse(readFileSync(ORIGIN_FILE, "utf8"));
    return clean(j.origin);
  } catch {
    return "";
  }
}

/** True when the origin came from a rotating tunnel rather than a pinned host. */
export function originIsEphemeral(env = process.env) {
  return !clean(env.SALES_PUBLIC_ORIGIN) && Boolean(currentOrigin(env));
}

export function writeOrigin(origin) {
  const o = clean(origin);
  if (!/^https:\/\/[^\s/]+$/.test(o)) {
    throw new Error(`sales-line: refusing to record a non-https origin: ${origin}`);
  }
  mkdirSync(path.dirname(ORIGIN_FILE), { recursive: true });
  writeFileSync(ORIGIN_FILE, JSON.stringify({ origin: o, at: new Date().toISOString() }, null, 2));
  return o;
}

export function clearOrigin() {
  if (existsSync(ORIGIN_FILE)) writeFileSync(ORIGIN_FILE, JSON.stringify({ origin: "", at: new Date().toISOString() }, null, 2));
}
