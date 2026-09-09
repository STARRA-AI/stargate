/**
 * TUNNEL POLICY — the one decision that cost a full night of debugging.
 *
 * "Is the tunnel serving?" and "is the bridge healthy?" are DIFFERENT QUESTIONS
 * and they have different answers. Collapsing them into a single boolean is the
 * bug, and it is subtle enough to be worth its own module and its own tests.
 *
 * The supervisor starts the bridge and the tunnel at the same instant, so the
 * tunnel's first probe routinely lands while the bridge is still booting and
 * gets a 502. A 502 is Cloudflare telling us the EDGE IS UP and the origin did
 * not answer — the tunnel is working perfectly. The first version required
 * `res.ok`, read that 502 as "tunnel dead", killed a healthy tunnel and asked
 * for another. That loop burned ~15 quick tunnels in an hour, tripped
 * trycloudflare's per-IP creation limit, and the resulting connection failures
 * looked exactly like an outage on Cloudflare's side. It was self-inflicted.
 */

/**
 * Did the Cloudflare edge answer at all?
 *
 * @param outcome `{ status: number }` for any http response, or `null` when the
 *   fetch threw (nothing answered).
 * @returns true when the TUNNEL is serving, whatever the origin said.
 */
export function edgeIsUp(outcome) {
  return outcome !== null && outcome !== undefined && Number.isFinite(outcome.status);
}

/** Is the bridge behind the tunnel actually healthy? A stricter, separate question. */
export function originIsHealthy(outcome) {
  return edgeIsUp(outcome) && outcome.status >= 200 && outcome.status < 300;
}

/**
 * What a probe result means, in words, for the operator.
 * Kept here so status.mjs and tunnel.mjs cannot drift on the interpretation.
 */
export function describe(outcome) {
  if (!edgeIsUp(outcome)) return "the tunnel is not serving";
  if (originIsHealthy(outcome)) return "tunnel and bridge both healthy";
  return `tunnel fine, bridge answered ${outcome.status}`;
}
