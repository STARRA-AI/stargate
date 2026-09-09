/** Point the Twilio sales number at whatever origin is current. Idempotent. */
import { ENV } from "./env.mjs";
import { currentOrigin } from "./origin.mjs";
import { setVoiceWebhook } from "./twilio-admin.mjs";

const origin = currentOrigin(ENV);
if (!origin) {
  console.error("no origin: pin SALES_PUBLIC_ORIGIN in .env.local, or run `npm run tunnel`.");
  process.exit(1);
}
try {
  const r = await setVoiceWebhook(origin);
  console.log(`${r.number} -> ${r.voiceUrl}  ${r.changed ? "(updated)" : "(already correct)"}`);
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
}
