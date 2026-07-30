import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  collectSecretValues,
  readEngineConfig,
  resolveSecret,
  type EngineConfig,
} from "@/lib/engine/config";
import { evaluateProvider } from "@/lib/engine/router";
import { safeErrorMessage } from "@/lib/engine/redact";

export const runtime = "nodejs";

// Replicate hosts the talking-head model on THEIR GPU (Charles's Mac has no
// NVIDIA GPU, and this needs one) — no Colab, no notebook. The token stays
// server-side (like the xAI key).
//
// THIS IS A LABELED, OFF-BY-DEFAULT FALLBACK, NOT THE PRODUCT DEFAULT. The
// free default is A1's native-resolution mouth-patch renderer (see
// src/lib/voice/lipsync.ts header). NEXT_PUBLIC_LIPSYNC stays "0"
// (Charter §0/§4: no spend until STARRA/STARGATE has revenue).
//
// VERIFIED COST (re-fetched live 2026-07-28, two independent sources that agree):
//   1) https://replicate.com/cjwbw/sadtalker — "This model costs approximately
//      $0.086 to run on Replicate, or 11 runs per $1." · "Predictions typically
//      complete within 62 seconds." · "This model runs on Nvidia A100 (80GB) GPU
//      hardware."
//   2) https://replicate.com/pricing — Nvidia A100 (80GB) GPU: "$0.001400/sec
//      $5.04/hr". Cross-check: 62s x $0.0014/s = $0.0868/run ≈ $0.086. Consistent.
//      That pricing page shows NO free tier and NO free credits.
// The OLD comment here said "~$0.03/run" — that was WRONG, understating the
// real bill by ~2.9x. Corrected to the verified $0.086/run above.
//
// COST PER CONVERSATION (arithmetic, not vibes):
//   - 1 billed prediction PER SPOKEN TURN — POST here creates one every call (see
//     the handler below); each is a full Replicate run at ~$0.086.
//   - PLUS 1 extra billed prediction PER CALL from the warm-up: opening a call
//     POSTs { warm: true } (useVoiceCall.ts:616-623); this handler still CREATES
//     A REAL PREDICTION for that (below) and only returns early — returning
//     early does NOT stop Replicate from billing the run it already created.
//     So opening a call costs ~$0.086 before she says one word.
//   - At ~3 spoken turns/min: 3 x $0.086 = ~$0.258/min ≈ ~$15.5/hr.
//   - A 20-min call ≈ 60 turns ≈ 60 x $0.086 = ~$5.16, + the ~$0.086 warm-up
//     ≈ ~$5.25 for one 20-minute call.
//
// Default model = cjwbw/sadtalker; override REPLICATE_LIPSYNC_MODEL to change it
// (e.g. bytedance/omni-human) — note doing so changes the real per-run price;
// the figures above are for the default model only, verify again before relying
// on them for a different model.
// ---- THE PAID GATE (engine-authoritative) ---------------------------------
// This route USED to gate on nothing but "does a token exist" — and
// REPLICATE_API_TOKEN IS set in .env.local, so every POST billed a real run.
// A key is not consent to spend. The credential and the permission now both
// come from the engine (src/lib/engine), which owns the no-spend invariant:
//   * evaluateProvider()'s FIRST branch (src/lib/engine/router.ts:110-117)
//     refuses any provider marked paid:true unless the operator set
//     enabled:true for it explicitly in data/engine.json.
//   * replicate is paid:true / defaultEnabled:false in the registry
//     (src/lib/engine/providers.ts:222-234) and the registry refuses to even
//     load if a paid provider ever defaults to on (providers.ts:246-252).
//   * the credential is resolved ONLY through resolveSecret()
//     (src/lib/engine/config.ts:356-366): engine.json keyOverride -> env.
// So: replicate disabled (the shipped default, and the state of data/engine.json
// today) => this route returns { mode: "off" } and makes ZERO outbound calls.
// NEXT_PUBLIC_LIPSYNC stays "0" on top of that — two independent brakes.
const MODEL = process.env.REPLICATE_LIPSYNC_MODEL || "cjwbw/sadtalker";

/** The one harmless refusal. lipsync.ts:45 reads it as "no clip" and falls back. */
const off = () => NextResponse.json({ mode: "off" });

/**
 * Credentials that must never survive into a response body. Built on FAILURE
 * paths only, and it can never throw — redaction must not become the reason she
 * breaks. `resolved` is included explicitly so the key actually on the wire is
 * scrubbed even if it came from somewhere collectSecretValues does not scan.
 */
function liveSecrets(cfg: EngineConfig, resolved?: string): string[] {
  const out = resolved ? [resolved] : [];
  try {
    out.push(...collectSecretValues(cfg));
  } catch {
    /* never let the scrubber be the failure */
  }
  return out;
}

// ---- Hard spend ceiling (defense-in-depth backstop; the real ceiling is the
// flag staying off — see above) --------------------------------------------
// Every prediction created below is a REAL BILLED RUN (~$0.086 for the default
// model, verified above). This counts predictions created by THIS SERVER
// PROCESS (resets on restart — it is a backstop, not a durable ledger) and,
// once a cap is hit, refuses to create another and returns { mode: "off" }
// instead — lipsync.ts:45 already treats "off" as "no clip", so the caller
// silently falls back to the reactive face (never a thrown error, never a
// broken call).
//
// Fails CLOSED on any doubt: an unset/blank/non-numeric/zero/negative override
// is IGNORED in favor of the low built-in default — it never means "unlimited".
//
// Override with LIPSYNC_MAX_PREDICTIONS (positive integer, predictions per
// process). NOT set in .env.local today (A2 does not own that file). INTEGRATION
// NOTE for Classic: if he ever wants a different ceiling, add
// `LIPSYNC_MAX_PREDICTIONS=<n>` to .env.local himself; this route never writes
// to it.
const DEFAULT_MAX_PREDICTIONS = 5; // ≈ $0.43/process at the verified $0.086/run
function maxPredictions(): number {
  const raw = process.env.LIPSYNC_MAX_PREDICTIONS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PREDICTIONS;
}
// Exported for tests only — a fresh module instance per test process, so this
// module-level counter starts at 0 there too (no reset needed for import-time
// isolation; tests import a copy of this module).
export let predictionsCreated = 0;

/** Her fixed portrait, sent as the lip-sync source, as a data URI. */
function portraitDataURI(): string {
  const p = path.join(process.cwd(), "public", "avatar", "starra-portrait.jpg");
  const b64 = fs.readFileSync(p).toString("base64");
  return `data:image/jpeg;base64,${b64}`;
}

/** A tiny (~0.2s) silent WAV, base64 — used only to warm the Replicate container. */
function tinySilentWavB64(): string {
  const sr = 16000;
  const n = Math.floor(sr * 0.2);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  return buf.toString("base64"); // data bytes already zero = silence
}

/**
 * Render her spoken-turn audio → a talking-head video with lips matched to the
 * words, via Replicate. Takes { wav: base64 } (her exact xAI turn audio); sends
 * her portrait + that audio to the hosted model; polls the prediction; returns
 * { mode:"live", video: url }. { mode:"off" } when no token is set, or when the
 * per-process spend ceiling (see DEFAULT_MAX_PREDICTIONS above) is hit — either
 * way the caller falls back to the reactive face. Turn-based: 62s typical render
 * on the host GPU (Replicate's own figure, verified above; varies with input).
 */
export async function POST(req: Request) {
  // THE PAID GATE, FIRST — before the body is even parsed, so there is no branch
  // in this handler that can reach the network (or reveal that it is armed)
  // while replicate is disabled. See the block comment above MODEL.
  const cfg = await readEngineConfig();
  const verdict = evaluateProvider(cfg, "replicate");
  if (!verdict.ok) return off();
  const key = resolveSecret(cfg, "replicate");
  if (!key) return off(); // belt-and-braces: evaluateProvider already covers this

  let wav: string | undefined;
  let warm = false;
  try {
    ({ wav, warm = false } = (await req.json()) as { wav?: string; warm?: boolean });
  } catch {
    return NextResponse.json({ mode: "error", message: "bad request" }, { status: 400 });
  }
  // warm=true (fired when the call opens) spins the Replicate container up with a
  // throwaway tiny clip and returns immediately — so the first real reply renders
  // WARM (~9s) instead of COLD (~55s). It doesn't wait for or use the result. It
  // is STILL A BILLED PREDICTION (see cost breakdown above) — it counts against
  // the spend ceiling exactly like a real turn.
  if (!wav && !warm) {
    return NextResponse.json({ mode: "error", message: "no audio" }, { status: 400 });
  }

  // Hard spend ceiling — checked BEFORE any network call, so hitting it costs
  // nothing and never touches Replicate. Fails CLOSED: off, not an error, so
  // the caller (lipsync.ts:45) treats it exactly like the flag being off.
  if (predictionsCreated >= maxPredictions()) {
    return NextResponse.json({ mode: "off" });
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

    // 1b) create the prediction with that version — THIS IS THE BILLED CALL
    // (~$0.086, verified above). Count it BEFORE sending, not after: once the
    // request leaves this process Replicate may bill it even if we never see
    // (or fail to parse) the response, so failing closed means counting on
    // send, not on confirmed success.
    predictionsCreated++;
    const create = await fetch(`https://api.replicate.com/v1/predictions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version,
        input: {
          source_image: portraitDataURI(),
          driven_audio: `data:audio/wav;base64,${wav || tinySilentWavB64()}`,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!create.ok) {
      // The upstream body is UNTRUSTED and can echo the token back. Scrub it
      // with the live secret set BEFORE it can leave the server.
      const detail = await create.text().catch(() => "");
      return NextResponse.json(
        {
          mode: "error",
          message: safeErrorMessage(
            `create ${create.status}: ${detail}`,
            liveSecrets(cfg, key),
          ).slice(0, 300),
        },
        { status: 502 },
      );
    }
    // Warm-up: the container is now spinning up — don't wait, don't use the
    // result. The next REAL reply lands on a warm model (~9s vs ~55s cold).
    if (warm) return NextResponse.json({ mode: "warming" });
    const pred = (await create.json()) as {
      id?: string;
      status?: string;
      output?: unknown;
      error?: string;
      urls?: { get?: string };
    };

    // 2) poll until terminal (sadtalker 62s typical per Replicate; cap ~4 min)
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
      // state.error is upstream text too — same scrub.
      return NextResponse.json(
        {
          mode: "error",
          message: safeErrorMessage(
            state.error || `status ${state.status || "timeout"}`,
            liveSecrets(cfg, key),
          ).slice(0, 300),
        },
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
    // Transport/abort errors quote the request they failed on — scrub these too.
    return NextResponse.json(
      { mode: "error", message: safeErrorMessage(e, liveSecrets(cfg, key)).slice(0, 300) },
      { status: 502 },
    );
  }
}
