import { getKey } from "@/lib/keys";
import { collectSecretValues, readEngineConfig } from "@/lib/engine/config";
import { safeErrorMessage } from "@/lib/engine/redact";

export const runtime = "nodejs";

const XAI_REALTIME_WS = "wss://api.x.ai/v1/realtime";

/**
 * The voice model this route ASKS FOR. It is not a guarantee.
 *
 * ★ MEASURED ON THE WIRE 2026-09-30 — THE PIN DOES NOT HOLD. The socket is
 * opened as `?model=grok-voice-think-fast-1.0` and xAI's own `session.created`
 * event comes back reporting model `grok-voice-think-fast-2.0`. The query
 * parameter is accepted and ignored. Two further facts from the same session,
 * because they are what makes this easy to get wrong twice:
 *   - a WS upgrade returns 101 Switching Protocols even for a DELIBERATELY
 *     BOGUS model name, so a successful upgrade proves nothing about the model;
 *   - therefore the ONLY source of truth for what is running is the
 *     `session.created` event, which useVoiceCall.ts now reads and reports on
 *     the ops feed.
 *
 * WHAT THIS DOCSTRING USED TO SAY, and why it is deleted rather than softened:
 * that `?model=` is "the ONLY thing that selects the model for the session" and
 * that the versioned pin therefore held the $0.05/min Think Fast 1.0 rate. Both
 * halves are false, and the second one kept the meter in
 * src/lib/voice/voiceCost.ts at the wrong number (now 0.08, the 2.0 rate).
 *
 * The param is KEPT: it is harmless, it is the documented way to ask, and it
 * starts working the day xAI honours it. What is gone is the belief that it
 * settles anything.
 *
 * Still true, and still the reason not to put `model` in the POST body: the
 * REST reference for POST /v1/realtime/client_secrets accepts `expires_after`
 * and `session` only, and the ephemeral-token guide states the endpoint "Does
 * not support 'session' or 'expires_after.anchor' fields".
 */
export const XAI_REALTIME_DEFAULT_MODEL = "grok-voice-think-fast-1.0";

/**
 * The realtime socket URL with the requested model as a query parameter.
 * It is a REQUEST, not a selection — see XAI_REALTIME_DEFAULT_MODEL.
 */
export function xaiRealtimeWsUrl(model: string): string {
  return `${XAI_REALTIME_WS}?model=${encodeURIComponent(model)}`;
}

/**
 * Credentials that must never survive into a response body.
 *
 * WHY THIS EXISTS: the upstream xAI error body used to be returned verbatim as
 * { mode:"error", message }, and that string is RENDERED, not just logged —
 * useVoiceCall.ts:927 handleFatalError(data.message) -> :681 setError() ->
 * VoiceCallOverlay.tsx:392. A rotated-key 401 or a burst 429 was enough to put
 * whatever xAI said on Classic's screen.
 *
 * FAILURE PATH ONLY. The happy path — her voice — awaits nothing new: this is
 * called after the request has already failed, never before it is sent. It also
 * cannot throw; redaction must never be the reason the voice link breaks.
 * `resolved` is passed explicitly so the key actually on the wire is scrubbed
 * even when it came from a store collectSecretValues does not scan.
 */
async function liveSecrets(resolved?: string): Promise<string[]> {
  const out = resolved ? [resolved] : [];
  try {
    out.push(...collectSecretValues(await readEngineConfig()));
  } catch {
    /* never let the scrubber be the failure */
  }
  return out;
}

/**
 * Mint a short-lived xAI Realtime client secret so the browser can open the
 * full-duplex voice-call WebSocket directly (voice "eve" — female, British) WITHOUT the raw
 * XAI_API_KEY ever reaching the client. STT + LLM + TTS all run in xAI's cloud,
 * so the local machine only streams audio in/out — light enough for the 8GB
 * laptop (no local Whisper/model). Returns { mode:"live", value, url, ... }.
 */
export async function POST() {
  const key = await getKey("xai");
  const model = process.env.XAI_REALTIME_MODEL || XAI_REALTIME_DEFAULT_MODEL;

  if (!key) {
    return Response.json({
      mode: "stub",
      message: "VOICE LINK UNAVAILABLE — link the xAI key in Settings → Link APIs.",
    });
  }

  try {
    const res = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, voice: "eve" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // UNTRUSTED upstream text — scrub with the live secret set, and scrub
      // BEFORE truncating (a key straddling the 200-char cut would otherwise
      // leak its head).
      const err = await res.text().catch(() => "");
      return Response.json(
        {
          mode: "error",
          message: safeErrorMessage(`xAI ${res.status}: ${err}`, await liveSecrets(key)).slice(
            0,
            200,
          ),
        },
        { status: 502 },
      );
    }
    const data = (await res.json()) as {
      value?: string;
      expires_at?: number;
    };
    // A 200 with no client secret is not a live link — don't hand the browser a
    // mode:"live" it can't use. Surface it as an error so the client shows the
    // "voice link unavailable" path instead of trying to open a WS with an
    // undefined subprotocol secret.
    if (!data.value) {
      return Response.json(
        { mode: "error", message: "xAI returned no client secret." },
        { status: 502 },
      );
    }
    return Response.json({
      mode: "live",
      value: data.value, // ephemeral client secret — safe to hand to the browser
      expires_at: data.expires_at,
      model,
      voice: "eve",
      // Carries ?model= — see XAI_REALTIME_DEFAULT_MODEL. A bare base URL here
      // would silently fall back to the grok-voice-latest alias on the socket.
      url: xaiRealtimeWsUrl(model),
      // HER BRAIN IS KIMI (Classic's order, 2026-08-04): which brain drives
      // the call. "kimi" (the default) = xAI is EARS + MOUTH only — the
      // session never auto-answers (turn_detection null); the deck brain
      // (/api/chat, LLM_PROVIDER) thinks and the session speaks its replies
      // verbatim via force_message. STARRA_CALL_BRAIN=grok is the one-line
      // rollback to the old bundled xAI brain+voice call.
      callBrain:
        (process.env.STARRA_CALL_BRAIN || "kimi").toLowerCase() === "grok"
          ? "grok"
          : "kimi",
    });
  } catch (e) {
    // Transport/abort errors quote the request they failed on — same scrub.
    return Response.json(
      {
        mode: "error",
        message: safeErrorMessage(e, await liveSecrets(key)).slice(0, 200),
      },
      { status: 502 },
    );
  }
}
