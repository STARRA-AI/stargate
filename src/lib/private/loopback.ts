/**
 * THE EGRESS GATE for the private lane — one definition, one file.
 *
 * It lives here rather than in a route because TWO routes need it
 * (`/api/chat`'s private branch and `/api/private-call/transcribe`), and the
 * import that used to satisfy the second one — `from "@/app/api/chat/route"` —
 * dragged the whole chat route (every hosted provider, the tool fast-paths,
 * the memory store) into the transcribe route's module graph for the sake of a
 * fifteen-line predicate. A security predicate should be the cheapest thing to
 * import in the codebase, not the most expensive.
 *
 * Privacy is the spec, so it is ENFORCED rather than assumed: a typo'd or
 * tampered PRIVATE_GPT_BASE / WHISPER_BASE pointing off-box would quietly turn
 * the private lane into an exfiltration channel.
 *
 * The rule is NUMERIC LOOPBACK LITERALS ONLY — dotted `127.x` (WHATWG URL
 * normalizes shorthand like `127.1` to `127.0.0.1` before this sees it) or
 * `::1`. Anything else is refused, and two refusals are deliberate:
 *
 *   - A PREFIX TEST ON A NAME is not a loopback test. The first cut used
 *     `/^127\./` on the host, which accepts `127.0.0.1.evil.example.com` and
 *     `127.attacker.example.com` — ordinary DNS-resolvable names that route
 *     straight off this Mac. Anchoring to digits closes that.
 *   - `localhost` IS DROPPED ON PURPOSE. A name is only ever what a resolver
 *     says it is (/etc/hosts, a search domain, a hijacked resolver), so it is
 *     not a guarantee of loopback. Nothing breaks: both routes' defaults are
 *     literal IPs, .env.local carries literal IPs, and the runbook
 *     (docs/PRIVATE_LANE.md) documents the literal IPs.
 *
 * `::ffff:127.0.0.1` (IPv4-mapped IPv6, which URL serializes as
 * `[::ffff:7f00:1]`) is refused too — it is loopback in practice, but
 * accepting one alternate spelling invites the rest for no gain here.
 *
 * tests/private-lane.test.ts pins this against a table of hostile inputs.
 */
export function isLoopbackBase(base: string): boolean {
  try {
    const u = new URL(base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // `hostname` keeps IPv6 bracketed; accept either spelling of ::1.
    const host = u.hostname.toLowerCase();
    if (host === "::1" || host === "[::1]") return true;
    return /^127(?:\.\d{1,3}){1,3}$/.test(host);
  } catch {
    return false;
  }
}
