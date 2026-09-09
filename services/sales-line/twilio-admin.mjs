/**
 * TWILIO ADMIN — the two calls that make a rotating tunnel survivable.
 *
 * Twilio decides where to send an incoming call by the number's `VoiceUrl`,
 * which is settable over the REST API. So a hostname that changes is not
 * actually a blocker: when it changes, we tell Twilio the new one. That is what
 * lets this ship tonight without waiting on a Tailscale login.
 *
 * Auth note that costs an hour if you miss it: an API Key SID (`SK…`) is the
 * USERNAME, but the REST path still needs the ACCOUNT SID (`AC…`). Authenticating
 * with the SK sid in the path returns 404s that look like a missing number.
 */
import { ENV } from "./env.mjs";

const API = "https://api.twilio.com/2010-04-01";

function creds(env = ENV) {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  if (!accountSid) throw new Error("TWILIO_ACCOUNT_SID missing");
  if (!accountSid.startsWith("AC")) {
    throw new Error(
      `TWILIO_ACCOUNT_SID must be the ACCOUNT sid (starts AC), got ${accountSid.slice(0, 2)}… — ` +
        "an SK sid is an API Key and belongs in TWILIO_API_KEY_SID",
    );
  }
  const user = env.TWILIO_API_KEY_SID || accountSid;
  const pass = env.TWILIO_API_KEY_SECRET || env.TWILIO_AUTH_TOKEN;
  if (!pass) throw new Error("no Twilio credential (TWILIO_API_KEY_SECRET or TWILIO_AUTH_TOKEN)");
  return { accountSid, auth: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") };
}

async function call(method, pathname, body, env = ENV) {
  const { accountSid, auth } = creds(env);
  const res = await fetch(`${API}/Accounts/${accountSid}${pathname}`, {
    method,
    headers: {
      authorization: auth,
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`twilio ${method} ${pathname} -> ${res.status}: ${json.message || JSON.stringify(json).slice(0, 200)}`);
  }
  return json;
}

/** The IncomingPhoneNumber record for the configured sales number. */
export async function findSalesNumber(env = ENV) {
  const want = String(env.TWILIO_SALES_NUMBER || "").replace(/\D/g, "");
  if (!want) throw new Error("TWILIO_SALES_NUMBER missing");
  const { incoming_phone_numbers: nums = [] } = await call(
    "GET", "/IncomingPhoneNumbers.json?PageSize=100", null, env,
  );
  const hit = nums.find((n) => n.phone_number.replace(/\D/g, "") === want);
  if (!hit) {
    throw new Error(
      `${env.TWILIO_SALES_NUMBER} is not on this account. Numbers present: ` +
        (nums.map((n) => n.phone_number).join(", ") || "(none)"),
    );
  }
  return hit;
}

/**
 * Point the sales number at this origin. Idempotent — returns {changed:false}
 * when Twilio already holds the right URL, so the supervisor can call it on
 * every tunnel event without churning the account.
 */
export async function setVoiceWebhook(origin, env = ENV) {
  const o = String(origin).replace(/\/+$/, "");
  if (!/^https:\/\//.test(o)) throw new Error(`refusing a non-https webhook origin: ${origin}`);
  const num = await findSalesNumber(env);
  const voiceUrl = `${o}/incoming`;
  if (num.voice_url === voiceUrl && num.voice_method === "POST") {
    return { changed: false, voiceUrl, sid: num.sid, number: num.phone_number };
  }
  await call("POST", `/IncomingPhoneNumbers/${num.sid}.json`, {
    VoiceUrl: voiceUrl,
    VoiceMethod: "POST",
    // A lead who calls back must never hear a Twilio error tone. If the bridge
    // is down, Twilio falls back to this and says something human instead.
    VoiceFallbackUrl: `${o}/fallback`,
    VoiceFallbackMethod: "POST",
  }, env);
  return { changed: true, voiceUrl, sid: num.sid, number: num.phone_number, was: num.voice_url };
}
