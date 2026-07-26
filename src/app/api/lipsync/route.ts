import { NextResponse } from "next/server";

export const runtime = "nodejs";

const colabUrl = () => (process.env.COLAB_LIPSYNC_URL || "").trim().replace(/\/$/, "");
// gradio api_name the Colab notebook exposes (proven pattern: "/render").
const RENDER_API = process.env.COLAB_LIPSYNC_API || "/render";

/**
 * Proxy her spoken-turn WAV to the Colab Pro / MuseTalk renderer and return the
 * talking-clip URL. Keeps COLAB_LIPSYNC_URL server-side — never reaches the
 * browser — exactly as /api/realtime keeps the xAI key server-side.
 *
 * Contract, grounded in the proven python `lipsync/colab_engine.py` which calls
 * gradio `predict(..., api_name="/render")`: the Colab notebook registers her
 * MuseTalk avatar once, then this endpoint sends only her turn AUDIO and gets
 * back a photoreal video whose whole face is locked to that audio. Set
 * COLAB_LIPSYNC_API if the notebook's api_name differs.
 *
 * NOTE: the gradio HTTP flow below (upload -> /call -> poll) matches gradio 4/5;
 * it is UNVERIFIED against a live endpoint — align once the Colab Pro URL is set.
 */
export async function POST(req: Request) {
  const base = colabUrl();
  if (!base) return NextResponse.json({ mode: "off" });

  let wav: string | undefined;
  try {
    ({ wav } = (await req.json()) as { wav?: string });
  } catch {
    return NextResponse.json({ mode: "error", message: "bad request" }, { status: 400 });
  }
  if (!wav) {
    return NextResponse.json({ mode: "error", message: "no audio" }, { status: 400 });
  }

  try {
    // 1) upload the WAV to gradio's file store
    const bytes = Buffer.from(wav, "base64");
    const form = new FormData();
    form.append("files", new Blob([bytes], { type: "audio/wav" }), "turn.wav");
    const up = await fetch(`${base}/upload`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!up.ok) throw new Error(`upload ${up.status}`);
    const uploaded = (await up.json()) as string[];
    const filePath = uploaded[0];
    if (!filePath) throw new Error("upload returned no path");

    // 2) invoke the render endpoint with the uploaded file ref
    const call = await fetch(`${base}/call${RENDER_API}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [{ path: filePath, meta: { _type: "gradio.FileData" } }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!call.ok) throw new Error(`call ${call.status}`);
    const { event_id: eventId } = (await call.json()) as { event_id?: string };
    if (!eventId) throw new Error("no event id");

    // 3) poll the SSE result stream for the completed video
    const stream = await fetch(`${base}/call${RENDER_API}/${eventId}`, {
      signal: AbortSignal.timeout(120_000),
    });
    const text = await stream.text();
    const dataLine = text
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("data:"));
    const payload = dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
    const first = Array.isArray(payload) ? payload[0] : payload;
    const url =
      typeof first === "string" ? first : first?.url ?? first?.video ?? first?.path;
    if (!url || typeof url !== "string") throw new Error("no video in result");

    return NextResponse.json({ mode: "live", video: url });
  } catch (e) {
    return NextResponse.json(
      { mode: "error", message: e instanceof Error ? e.message : "render failed" },
      { status: 502 },
    );
  }
}
