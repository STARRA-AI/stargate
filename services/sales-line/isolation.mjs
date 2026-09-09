/**
 * ISOLATION — the whole reason this service is separate from the deck.
 *
 * Classic's order, 2026-08-22: "I do not want for any reason for anyone who has
 * access to the outbound sales person to have out information about me or any
 * of the spicy stuff or any of that stuff like all my personal stuff should be
 * completely separate from the outbound dialer."
 *
 * His personal STARRA lives on xAI agent `agent_hrwPHGMoaouaLMB0`, which carries
 * 205,582 characters of canon plus tools that reach his deck, his memory and his
 * funding board. A stranger on a sales call must never touch any of it.
 *
 * ISOLATION HERE IS STRUCTURAL, NOT A PROMISE. Two mechanisms, both fail-closed:
 *
 *   1. The socket is opened by MODEL, never by agent. `buildRealtimeUrl` refuses
 *      to emit an `agent_id` parameter at all — there is no code path from this
 *      service to his agent, so no prompt, jailbreak or misconfiguration can
 *      reach one.
 *   2. The persona this service sends is screened before it is ever transmitted.
 *      `assertCleanPersona` throws on any marker of his private material. A
 *      service that cannot prove its persona is clean does not start.
 *
 * Both are pinned by test/isolation.test.mjs. If you are changing this file,
 * you are changing the safety story — run that suite.
 */

/** The one model the sales line speaks to. Pinned, never an alias. */
export const SALES_MODEL = "grok-voice-think-fast-2.0";

/** His voice, deliberately. See the note in buildSessionUpdate below. */
export const SALES_VOICE = "ara";

/**
 * Markers of Classic's private world. If any appears in a persona file, this
 * service refuses to run rather than risk speaking it to a lead.
 *
 * Deliberately blunt and case-insensitive. A false positive costs a rename; a
 * false negative costs him the thing he explicitly asked me to protect.
 */
export const FORBIDDEN_MARKERS = [
  "spicy",
  "classic williams",
  "stargate",
  "the canon",
  "starra llc",
  "agent_hrwphgmoaoualmb0",
  "ppt615",
  "539-379-0772",
  "5393790772",
];

/**
 * Build the xAI realtime URL for a SALES call.
 *
 * Takes no agent parameter and accepts none — the isolation guarantee is that
 * this function is the only way this service reaches xAI, and it cannot express
 * an agent connection.
 */
export function buildRealtimeUrl(model = SALES_MODEL) {
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("sales-line: model is required");
  }
  if (/agent[_-]?id/i.test(model) || model.startsWith("agent_")) {
    throw new Error(
      "sales-line: refusing to connect by agent — the sales line is model-only " +
        "so it can never reach Classic's personal agent",
    );
  }
  return `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model)}`;
}

/**
 * Screen a persona string. Throws on anything from his private world.
 * Returns the persona unchanged so callers can inline it.
 */
export function assertCleanPersona(persona) {
  if (typeof persona !== "string" || !persona.trim()) {
    throw new Error("sales-line: persona is empty — refusing to start");
  }
  const hay = persona.toLowerCase();
  const hits = FORBIDDEN_MARKERS.filter((m) => hay.includes(m));
  if (hits.length) {
    throw new Error(
      `sales-line: persona contains private markers [${hits.join(", ")}] — ` +
        "refusing to start. The sales persona must contain none of Classic's " +
        "personal material.",
    );
  }
  // A canon-sized persona is a smell on this line no matter what it says.
  if (persona.length > 20000) {
    throw new Error(
      `sales-line: persona is ${persona.length} chars — that is canon-sized. ` +
        "The sales persona is a business script, not her life. Refusing to start.",
    );
  }
  return persona;
}

/**
 * The session.update payload for a sales call.
 *
 * AUDIO FORMAT — the thing that makes this service small. Verified against the
 * live socket 2026-08-22: xAI accepts `audio/pcmu` (G.711 mu-law) for BOTH
 * input and output. Twilio Media Streams speaks mu-law 8 kHz base64. So the
 * bridge relays base64 straight through in both directions with no resampling
 * and no DSP. Do not "improve" this to PCM16 — that would add a transcoder for
 * nothing.
 *
 * VOICE — Ara, and that is deliberate (Classic, 2026-08-22: "the outbound voice
 * can and should be Ara"). His private STARRA is Eve. Two voices on purpose:
 * the business line is not her. Do NOT "fix" this back to Eve.
 */
export function buildSessionUpdate(persona) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: assertCleanPersona(persona),
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          turn_detection: { type: "server_vad" },
        },
        output: { format: { type: "audio/pcmu" }, voice: SALES_VOICE },
      },
    },
  };
}
