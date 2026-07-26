import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

// Replicate hosts the talking-head model on THEIR GPU (Charles's Mac has no
// NVIDIA GPU, and this needs one) — no Colab, no notebook. The token stays
// server-side (like the xAI key). Default model = cjwbw/sadtalker (~$0.03/run);
// override REPLICATE_LIPSYNC_MODEL to upgrade (e.g. bytedance/omni-human).
const token = () => (process.env.REPLICATE_API_TOKEN || "").trim();
const MODEL = process.env.REPLICATE_LIPSYNC_MODEL || "cjwbw/sadtalker";

/** Her fixed portrait, sent as the lip-sync source, as a data URI. */
function portraitDataURI(): string {
  const p = path.join(process.cwd(), "public", "avatar", "starra-portrait.jpg");
  const b64 = fs.readFileSync(p).toString("base64");
  return `data:image/jpeg;base64,${b64}`;
}

/**
 * Render her spoken-turn audio → a talking-head video with lips matched to the
 * words, via Replicate. Takes { wav: base64 } (her exact xAI turn audio); sends
 * her portrait + that audio to the hosted model; polls the prediction; returns
 * { mode:"live", video: url }. { mode:"off" } when no token is set (caller falls
 * back to the reactive face). Turn-based: ~30-60s render on the host GPU.
 */
export async function POST(req: Request) {
  const key = token();
  if (!key) return NextResponse.json({ mode: "off" });

  let wav: string | undefined;
  try {
    ({ wav } = (await req.json()) as { wav?: string });
  } catch {
    return NextResponse.json({ mode: "error", message: "bad request" }, { status: 400 });
  }
  if (!wav) {
    return NextResponse.json({ mode: "error", message: "no audio" }, { status: 400 });
  }

  // A real User-Agent is REQUIRED — Replicate sits behind Cloudflare, which
  // 403s (error 1010) a default/absent UA. Verified: the same call 403s without
  // this header and succeeds with it.
  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "User-Agent": "STARGATE/1.0",
  };

  try {
    // 1a) resolve the model's latest version (verified path; the bare model
    // endpoint 404'd behind Cloudflare).
    const modelRes = await fetch(`https://api.replicate.com/v1/models/${MODEL}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!modelRes.ok) {
      return NextResponse.json(
        { mode: "error", message: `model ${modelRes.status}` },
        { status: 502 },
      );
    }
    const model = (await modelRes.json()) as { latest_version?: { id?: string } };
    const version = model.latest_version?.id;
    if (!version) {
      return NextResponse.json({ mode: "error", message: "no model version" }, { status: 502 });
    }

    // 1b) create the prediction with that version
    const create = await fetch(`https://api.replicate.com/v1/predictions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version,
        input: {
          source_image: portraitDataURI(),
          driven_audio: `data:audio/wav;base64,${wav}`,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!create.ok) {
      const detail = await create.text();
      return NextResponse.json(
        { mode: "error", message: `create ${create.status}: ${detail.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const pred = (await create.json()) as {
      id?: string;
      status?: string;
      output?: unknown;
      error?: string;
      urls?: { get?: string };
    };

    // 2) poll until terminal (sadtalker ~30-60s; cap ~4 min)
    const getUrl = pred.urls?.get;
    let state = pred;
    const deadline = Date.now() + 240_000;
    while (
      getUrl &&
      (state.status === "starting" || state.status === "processing") &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 2500));
      const poll = await fetch(getUrl, { headers, signal: AbortSignal.timeout(30_000) });
      if (!poll.ok) break;
      state = (await poll.json()) as typeof pred;
    }

    if (state.status !== "succeeded") {
      return NextResponse.json(
        { mode: "error", message: state.error || `status ${state.status || "timeout"}` },
        { status: 502 },
      );
    }

    // 3) extract the video URL (sadtalker returns a string; other models an array/obj)
    const out = state.output;
    const url =
      typeof out === "string"
        ? out
        : Array.isArray(out)
          ? (out[out.length - 1] as string)
          : (out as { video?: string; url?: string })?.video ??
            (out as { url?: string })?.url;
    if (!url || typeof url !== "string") {
      return NextResponse.json({ mode: "error", message: "no video in result" }, { status: 502 });
    }

    return NextResponse.json({ mode: "live", video: url });
  } catch (e) {
    return NextResponse.json(
      { mode: "error", message: e instanceof Error ? e.message : "render failed" },
      { status: 502 },
    );
  }
}
