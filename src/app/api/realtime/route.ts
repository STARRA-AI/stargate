import { getKey } from "@/lib/keys";
import { collectSecretValues, readEngineConfig } from "@/lib/engine/config";
import { safeErrorMessage } from "@/lib/engine/redact";

export const runtime = "nodejs";

const XAI_REALTIME_WS = "wss://api.x.ai/v1/realtime";

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
  const model = process.env.XAI_REALTIME_MODEL || "grok-voice-latest";

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
      url: XAI_REALTIME_WS,
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
