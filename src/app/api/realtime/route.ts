import { getKey } from "@/lib/keys";

export const runtime = "nodejs";

const XAI_REALTIME_WS = "wss://api.x.ai/v1/realtime";

/**
 * Mint a short-lived xAI Realtime client secret so the browser can open the
 * full-duplex voice-call WebSocket directly (voice "ara") WITHOUT the raw
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
      body: JSON.stringify({ model, voice: "ara" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const err = await res.text();
      return Response.json(
        { mode: "error", message: err.slice(0, 200) },
        { status: 502 },
      );
    }
    const data = (await res.json()) as {
      value?: string;
      expires_at?: number;
    };
    return Response.json({
      mode: "live",
      value: data.value, // ephemeral client secret — safe to hand to the browser
      expires_at: data.expires_at,
      model,
      voice: "ara",
      url: XAI_REALTIME_WS,
    });
  } catch (e) {
    return Response.json(
      {
        mode: "error",
        message: e instanceof Error ? e.message : "realtime failed",
      },
      { status: 502 },
    );
  }
}
