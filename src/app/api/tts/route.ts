import { getKey } from "@/lib/keys";

export const runtime = "nodejs";

/**
 * xAI TTS proxy — voice "ara". Keeps the xAI key server-side (never in the
 * browser bundle). Returns audio bytes when keyed and successful; otherwise a
 * bodyless non-2xx so the client falls back to Piper → Web Speech.
 *
 * Verified live 2026-07-18: POST https://api.x.ai/v1/tts, body
 * { text, language, voice_id }, returns raw audio bytes (no `model` field).
 */
export async function POST(req: Request) {
  const key = await getKey("xai");
  if (!key) return new Response(null, { status: 204 }); // no key → Piper fallback

  let text = "";
  try {
    const body = (await req.json()) as { text?: string };
    text = (body.text ?? "").slice(0, 15_000); // xAI hard cap
  } catch {
    /* ignore malformed body */
  }
  if (!text.trim()) return new Response(null, { status: 204 });

  // ONE VOICE (Classic's order, 2026-07-30): "eve" — the same voice as the
  // live call (api/realtime sends voice:"eve") — so typed replies and the call
  // are one person. XAI_TTS_VOICE still overrides for experiments.
  const voice = process.env.XAI_TTS_VOICE || "eve";
  try {
    const res = await fetch("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, language: "en", voice_id: voice }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok || !res.body) return new Response(null, { status: 502 });
    return new Response(res.body, {
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
