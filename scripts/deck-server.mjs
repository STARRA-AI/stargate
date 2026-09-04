/**
 * Production HTTPS server for the deck.
 *
 * WHY THIS EXISTS: `next start` has NO TLS options at all (checked:
 * `next start --help` lists only --port, --hostname, --keepAliveTimeout).
 * `--experimental-https` is a `next dev` flag. So serving a PRODUCTION build
 * over the same trusted origin needs a custom server — this one.
 *
 * What it deliberately preserves, because breaking any of them breaks the deck:
 *
 *  - The SAME mkcert pair (certs/deck-cert.pem + deck-key.pem) that `scripts/
 *    starra` uses in dev, so the browser sees an already-trusted origin and
 *    shows no warning.
 *  - The SAME port (3000) and the name `localhost`. WebAuthn forbids a bare IP
 *    as an rpID, so Touch ID works at https://localhost:3000 and nowhere else.
 *  - A DUAL-STACK bind (`::`), which is what makes `localhost` resolve for both
 *    IPv6 and IPv4 clients. Binding 0.0.0.0 alone breaks Touch ID.
 *
 * Dev is untouched: `npm run dev` and `scripts/starra` still run next dev with
 * HMR. This is the fast read-only lane.
 */
import { createServer } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { parse } from "node:url";
import path from "node:path";
import next from "next";

const PROJ = process.cwd();
const PORT = Number(process.env.STARRA_PORT || 3000);
// `::` is dual-stack on macOS: it accepts IPv6 AND IPv4-mapped connections, so
// `localhost` resolves either way. See the Touch ID note above.
const HOST = process.env.STARRA_HOST || "::";

const CERT = path.join(PROJ, "certs", "deck-cert.pem");
const KEY = path.join(PROJ, "certs", "deck-key.pem");

if (!existsSync(CERT) || !existsSync(KEY)) {
  console.error(
    `No mkcert pair at certs/deck-cert.pem + deck-key.pem.\n` +
      `Dev falls back to http when they are missing, but this server is HTTPS-only ` +
      `on purpose — a production deck on http would break Touch ID and the phone link.`,
  );
  process.exit(1);
}

const app = next({ dev: false, dir: PROJ, hostname: "localhost", port: PORT });
const handle = app.getRequestHandler();

await app.prepare();

createServer({ key: readFileSync(KEY), cert: readFileSync(CERT) }, (req, res) => {
  handle(req, res, parse(req.url, true)).catch((err) => {
    // Never let one bad request take the deck down — he uses this all day.
    console.error("request failed:", req.url, err);
    res.statusCode = 500;
    res.end("internal error");
  });
}).listen(PORT, HOST, () => {
  console.log(`● STARGATE (production build) on https://localhost:${PORT}`);
});
