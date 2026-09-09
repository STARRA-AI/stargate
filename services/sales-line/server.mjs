/**
 * THE SALES LINE — Twilio <-> xAI realtime bridge, both directions.
 *
 * Built 2026-08-22 for the Boomerang partnership. Calling starts Monday.
 *
 * WHAT THIS IS. A lead's phone call and an xAI realtime voice session, wired
 * together. Twilio owns the telephony (it is the only side that can place a
 * call — xAI documents inbound only, and its call control is just `refer` and
 * `hangup`). xAI owns the conversation.
 *
 * WHY IT IS SMALL. Verified against the live socket: xAI accepts `audio/pcmu`
 * — the same G.711 mu-law 8 kHz that Twilio Media Streams sends. So this is a
 * base64 relay, not a transcoder:
 *
 *     Twilio "media"  --payload-->  input_audio_buffer.append
 *     response.output_audio.delta  --delta-->  Twilio "media"
 *
 * ONE BRIDGE, BOTH DIRECTIONS. Outbound (we dial a lead) and inbound (a lead
 * calls the sales number back) land on the SAME TwiML and the SAME bridge, so a
 * callback gets the identical clean persona. That is deliberate: Classic asked
 * that leads be able to call the number back.
 *
 * WHAT THIS SERVICE MUST NEVER DO. Reach his personal agent. See isolation.mjs
 * — the socket is opened by model and the persona is screened before transmit.
 * Both fail closed.
 *
 * Run:  node server.mjs          (PORT env, default 8790)
 * Dial: POST /dial {"to":"+1918...","name":"Jane"}
 */

import { createServer } from "node:http";
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

import {
  SALES_MODEL,
  buildRealtimeUrl,
  buildSessionUpdate,
  assertCleanPersona,
} from "./isolation.mjs";
import { currentOrigin, originIsEphemeral } from "./origin.mjs";
import { ENV } from "./env.mjs";
import { toE164 } from "./phone.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8790);

// ── config ────────────────────────────────────────────────────────────────────

const XAI_API_KEY = ENV.XAI_API_KEY;

/**
 * TWILIO AUTH — two shapes, and the difference matters.
 *
 * Twilio accepts either the account's own Auth Token, or an API Key pair. They
 * are NOT interchangeable in the way they look: an API Key SID starts `SK` and
 * authenticates as the username, but the REST path still needs the ACCOUNT sid,
 * which starts `AC`. Pasting the `SK` sid into TWILIO_ACCOUNT_SID authenticates
 * fine and then 404s on every call, which reads like a broken number.
 *
 * So: TWILIO_ACCOUNT_SID is always the `AC` sid. Credentials are the API key
 * pair when present, else the account auth token.
 */
const TWILIO_ACCOUNT_SID = ENV.TWILIO_ACCOUNT_SID;
const TWILIO_API_KEY_SID = ENV.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = ENV.TWILIO_API_KEY_SECRET;
const TWILIO_AUTH_TOKEN = ENV.TWILIO_AUTH_TOKEN;

/** Whichever credential pair is configured, or null. */
const TWILIO_CREDS =
  TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET
    ? { user: TWILIO_API_KEY_SID, pass: TWILIO_API_KEY_SECRET, kind: "api-key" }
    : TWILIO_AUTH_TOKEN
      ? { user: TWILIO_ACCOUNT_SID, pass: TWILIO_AUTH_TOKEN, kind: "auth-token" }
      : null;

function twilioClient() {
  if (!TWILIO_CREDS) throw new Error("sales-line: no Twilio credentials configured");
  return TWILIO_CREDS.kind === "api-key"
    ? twilio(TWILIO_CREDS.user, TWILIO_CREDS.pass, { accountSid: TWILIO_ACCOUNT_SID })
    : twilio(TWILIO_CREDS.user, TWILIO_CREDS.pass);
}

const TWILIO_SALES_NUMBER = toE164(ENV.TWILIO_SALES_NUMBER);
/** Public https origin Twilio can reach, e.g. the Tailscale Funnel hostname. */
// Read per request, never cached at boot: a quick tunnel rotates its hostname
// and a constant captured at startup is how every call ends up pointed at an
// address nothing answers on. See origin.mjs.
const PUBLIC_ORIGIN = () => currentOrigin(ENV);

/**
 * The persona. Screened at STARTUP, not at call time — a bad persona must stop
 * the service, never surface mid-call with a lead on the line.
 */
const PERSONA = assertCleanPersona(
  readFileSync(path.join(HERE, "persona", "sales-persona.md"), "utf8"),
);

const CALL_LOG = path.join(HERE, "logs", "calls.jsonl");
function logCall(row) {
  try {
    appendFileSync(CALL_LOG, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n");
  } catch {
    /* logging must never break a live call */
  }
}

// ── the bridge ────────────────────────────────────────────────────────────────
/**
 * Wire one Twilio Media Stream to one xAI realtime session.
 *
 * Lifetime is the call. Either side closing tears down the other, so a dropped
 * lead never leaves a paid xAI socket open.
 */
function bridge(twilioWs) {
  let streamSid = null;
  let callSid = null;
  let lead = {};
  let xai = null;
  let xaiReady = false;
  /** Frames that arrived before xAI finished handshaking. Bounded — see below. */
  const pending = [];
  let transcript = "";
  const startedAt = Date.now();

  const openXai = () => {
    xai = new WebSocket(buildRealtimeUrl(SALES_MODEL), {
      headers: { Authorization: `Bearer ${XAI_API_KEY}` },
    });

    xai.on("open", () => {
      xai.send(JSON.stringify(buildSessionUpdate(PERSONA)));
      // She speaks first — a lead who answers to silence hangs up.
      xai.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions:
              `Greet the person warmly and introduce yourself. ` +
              (lead.name ? `Their name is ${lead.name}. ` : "") +
              `Keep the greeting to one short sentence, then let them respond.`,
          },
        }),
      );
      xaiReady = true;
      for (const p of pending.splice(0)) {
        xai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: p }));
      }
    });

    xai.on("message", (raw) => {
      let e;
      try {
        e = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (e.type) {
        case "response.output_audio.delta":
          // The relay. Same base64, no conversion — see the header note.
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(
              JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: e.delta },
              }),
            );
          }
          break;

        case "input_audio_buffer.speech_started":
          // BARGE-IN. The lead started talking over her. Twilio has already
          // buffered whatever we sent, so telling xAI to stop is not enough —
          // "clear" drops the audio Twilio has not played yet. Without this she
          // keeps talking for seconds after being interrupted, which is the
          // single most robotic thing a voice agent can do.
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
          }
          break;

        case "response.output_audio_transcript.delta":
          transcript += e.delta || "";
          break;

        case "error":
          logCall({ callSid, kind: "xai_error", error: e.error ?? e });
          break;

        default:
          break; // ping, item lifecycle, etc.
      }
    });

    xai.on("close", () => {
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    });
    xai.on("error", (err) => {
      logCall({ callSid, kind: "xai_socket_error", error: String(err?.message || err) });
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    });
  };

  twilioWs.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (m.event) {
      case "start":
        streamSid = m.start?.streamSid ?? null;
        callSid = m.start?.callSid ?? null;
        lead = m.start?.customParameters ?? {};
        logCall({ callSid, kind: "start", direction: lead.direction || "unknown", to: lead.to });
        openXai();
        break;

      case "media":
        if (xaiReady && xai?.readyState === WebSocket.OPEN) {
          xai.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: m.media.payload,
            }),
          );
        } else if (pending.length < 250) {
          // ~5s of 20ms frames. Bounded so a stalled handshake cannot grow
          // unboundedly; dropping the oldest audio is better than dropping RAM.
          pending.push(m.media.payload);
        }
        break;

      case "stop":
        if (xai?.readyState === WebSocket.OPEN) xai.close();
        break;

      default:
        break; // "connected", "mark"
    }
  });

  const teardown = () => {
    if (xai && xai.readyState <= WebSocket.OPEN) xai.close();
    logCall({
      callSid,
      kind: "end",
      seconds: Math.round((Date.now() - startedAt) / 1000),
      lead,
      transcript: transcript.trim().slice(0, 4000),
    });
  };
  twilioWs.on("close", teardown);
  twilioWs.on("error", teardown);
}

// ── TwiML ─────────────────────────────────────────────────────────────────────
/**
 * The same document answers an outbound call the lead just picked up AND an
 * inbound callback. One persona, one bridge, either direction.
 */
function twiml(origin, params = {}) {
  const wsUrl = `${origin.replace(/^https:/, "wss:")}/stream`;
  const p = Object.entries(params)
    .filter(([, v]) => v != null && v !== "")
    .map(
      ([k, v]) =>
        `<Parameter name="${k}" value="${String(v).replace(/[<>&"]/g, "")}"/>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${wsUrl}">${p}</Stream></Connect></Response>`;
}

// ── http ──────────────────────────────────────────────────────────────────────
const readBody = (req) =>
  new Promise((res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => res(b));
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    const ready = Boolean(
      XAI_API_KEY && TWILIO_ACCOUNT_SID && TWILIO_CREDS && TWILIO_SALES_NUMBER,
    );
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        ok: true,
        dialReady: ready,
        model: SALES_MODEL,
        personaChars: PERSONA.length,
        publicOrigin: PUBLIC_ORIGIN() || null,
        originIsEphemeral: originIsEphemeral(ENV),
        missing: [
          !XAI_API_KEY && "XAI_API_KEY",
          !TWILIO_ACCOUNT_SID && "TWILIO_ACCOUNT_SID",
          !TWILIO_CREDS && "TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET (or TWILIO_AUTH_TOKEN)",
          !TWILIO_SALES_NUMBER && "TWILIO_SALES_NUMBER",
          !PUBLIC_ORIGIN() && "SALES_PUBLIC_ORIGIN (or a running tunnel — npm run tunnel)",
        ].filter(Boolean),
      }),
    );
  }

  // Twilio fetches this when an OUTBOUND call is answered, and when an INBOUND
  // call arrives on the sales number. Both get the same bridge.
  if (url.pathname === "/twiml" || url.pathname === "/incoming") {
    const body = await readBody(req);
    const form = new URLSearchParams(body);
    const params = {
      direction: url.pathname === "/incoming" ? "inbound" : "outbound",
      name: url.searchParams.get("name") || "",
      to: url.searchParams.get("to") || form.get("From") || "",
    };
    res.writeHead(200, { "content-type": "text/xml" });
    return res.end(twiml(PUBLIC_ORIGIN(), params));
  }

  // Twilio hits this when /incoming errors or the bridge is unreachable. A lead
  // calling the number back must hear a person-shaped sentence, never a carrier
  // error tone — the call is lost either way, but the brand is not.
  if (url.pathname === "/fallback") {
    res.writeHead(200, { "content-type": "text/xml" });
    return res.end(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">' +
        "Thanks for calling. We're not able to take your call right now, " +
        "but we've got your number and someone will get right back to you." +
        "</Say></Response>",
    );
  }

  if (url.pathname === "/dial" && req.method === "POST") {
    const missing = [];
    if (!TWILIO_ACCOUNT_SID) missing.push("TWILIO_ACCOUNT_SID");
    if (!TWILIO_CREDS) missing.push("TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET (or TWILIO_AUTH_TOKEN)");
    if (!TWILIO_SALES_NUMBER) missing.push("TWILIO_SALES_NUMBER");
    if (!PUBLIC_ORIGIN()) missing.push("SALES_PUBLIC_ORIGIN (or a running tunnel — npm run tunnel)");
    if (missing.length) {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          error: "not configured",
          missing,
          hint: "fill these in stargate/.env.local, then restart this service",
        }),
      );
    }
    let payload = {};
    try {
      payload = JSON.parse(await readBody(req) || "{}");
    } catch {
      /* fall through to validation */
    }
    const dialTo = toE164(payload.to);
    if (!dialTo) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          error: "to is required and must be a real number",
          got: payload.to ?? null,
          hint: "E.164 (+19185551234); bare 10-digit US numbers are accepted and normalised",
        }),
      );
    }
    // DRY RUN — resolve everything, ring nobody.
    //
    // This exists because its absence bit immediately: a `dryRun` flag was
    // passed to a `/dial` that did not implement one, the flag was ignored, and
    // a real call went out. It cost nothing and reached nobody (the number was
    // in the reserved 555-01xx fictional range) but the next such slip would be
    // a live lead's phone. Against a lead list, "show me what you WOULD do" has
    // to be a real mode, not a habit of typing carefully.
    if (payload.dryRun === true) {
      const q = new URLSearchParams({ name: payload.name || "", to: dialTo });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          ok: true,
          dryRun: true,
          wouldCall: dialTo,
          from: TWILIO_SALES_NUMBER,
          twimlUrl: `${PUBLIC_ORIGIN()}/twiml?${q}`,
          note: "no call was placed",
        }),
      );
    }

    try {
      const client = twilioClient();
      const q = new URLSearchParams({ name: payload.name || "", to: dialTo });
      const call = await client.calls.create({
        to: dialTo,
        from: TWILIO_SALES_NUMBER,
        url: `${PUBLIC_ORIGIN()}/twiml?${q}`,
        method: "POST",
      });
      logCall({ kind: "dial", to: dialTo, name: payload.name, callSid: call.sid });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, callSid: call.sid }));
    } catch (err) {
      logCall({ kind: "dial_failed", to: dialTo, error: String(err?.message || err) });
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const wss = new WebSocketServer({ server, path: "/stream" });
wss.on("connection", bridge);

server.listen(PORT, () => {
  console.log(`[sales-line] :${PORT}  model=${SALES_MODEL}  persona=${PERSONA.length} chars`);
  if (!PUBLIC_ORIGIN()) {
    console.log("[sales-line] SALES_PUBLIC_ORIGIN not set — /dial is disabled until it is");
  }
});
