/**
 * One command that answers "is the sales line actually ready to take a call?"
 * — and, when it is not, says which link is broken rather than that it failed.
 */
import { ENV } from "./env.mjs";
import { currentOrigin, originIsEphemeral } from "./origin.mjs";
import { findSalesNumber } from "./twilio-admin.mjs";

const PORT = Number(process.env.PORT || 8790);
const ok = (b) => (b ? "yes" : "NO");
const line = (k, v) => console.log(`  ${k.padEnd(22)} ${v}`);

console.log("\nSTARRA sales line\n");

line("xAI key", ok(Boolean(ENV.XAI_API_KEY)));
line("Twilio account", ENV.TWILIO_ACCOUNT_SID ? `${ENV.TWILIO_ACCOUNT_SID.slice(0, 8)}…` : "MISSING");
line("Twilio creds", ok(Boolean(ENV.TWILIO_API_KEY_SECRET || ENV.TWILIO_AUTH_TOKEN)));
line("sales number", ENV.TWILIO_SALES_NUMBER || "MISSING");

const origin = currentOrigin(ENV);
line("public origin", origin || "NONE — run `npm run tunnel`");
if (origin) line("origin kind", originIsEphemeral(ENV) ? "rotating quick tunnel (auto-repointed)" : "pinned");

let bridge = false;
try {
  const r = await fetch(`http://localhost:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
  bridge = r.ok;
} catch { /* not running */ }
line("bridge :" + PORT, ok(bridge) + (bridge ? "" : " — run `npm start`"));

if (origin) {
  // TWO questions, not one — collapsing them is what made a healthy tunnel look
  // dead all night. A 502 means the tunnel is fine and the bridge was not up.
  let edge = false, healthy = false, status = "no answer";
  try {
    const r = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(8000) });
    edge = true;
    healthy = r.ok;
    status = String(r.status);
  } catch { /* the edge itself did not answer */ }
  line("tunnel edge up", ok(edge) + (edge ? ` (HTTP ${status})` : " — the tunnel is not serving"));
  line("bridge behind it", ok(healthy) + (edge && !healthy ? " — tunnel fine, bridge not answering" : ""));
}

try {
  const num = await findSalesNumber(ENV);
  const want = origin ? `${origin}/incoming` : null;
  line("Twilio voice_url", num.voice_url || "UNSET — inbound calls go nowhere");
  if (want) line("webhook matches", ok(num.voice_url === want) + (num.voice_url === want ? "" : " — run `npm run wire`"));

  // THE DANGEROUS STATE, and the one every other row hides: Twilio holds a URL,
  // everything reads "configured", and that address is dead — so a lead calling
  // back gets a carrier error tone while this table looks healthy.
  if (num.voice_url) {
    let answers = false;
    try {
      const r = await fetch(num.voice_url.replace(/\/incoming$/, "/health"), {
        signal: AbortSignal.timeout(8000),
      });
      answers = r.ok;
    } catch { /* dead */ }
    line("that url ANSWERS", ok(answers));
    if (!answers) {
      console.log("");
      console.log("  *** Twilio is pointed at an address that does not answer.  ***");
      console.log("  *** A lead calling right now would hear an error tone.     ***");
      console.log("  Fix: leave `./up.sh` running until it reports a live hostname, or set");
      console.log("  SALES_PUBLIC_ORIGIN to a stable Tailscale Funnel host and `npm run wire`.");
    }
  }
} catch (e) {
  line("Twilio lookup", `FAILED: ${e.message}`);
}
console.log("");
