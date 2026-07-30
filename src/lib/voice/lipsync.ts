/**
 * Client seam for the PAID Replicate lip-sync fallback — NOT the free default.
 *
 * WHAT THE CODE ACTUALLY DOES TODAY (verified from source, 2026-07-28 — every
 * claim this header used to make about "Colab Pro / MuseTalk" was FALSE):
 *   - The server route (src/app/api/lipsync/route.ts:1-12) calls REPLICATE,
 *     model cjwbw/sadtalker. There is no Colab Pro GPU, no MuseTalk, and no
 *     notebook anywhere in this path.
 *   - `COLAB_LIPSYNC_URL` is EMPTY in .env.local (verified: grep shows
 *     `COLAB_LIPSYNC_URL=` with no value) and is not even read by route.ts —
 *     it's a dead reference from an earlier plan that was never built.
 *   - SadTalker animates a SINGLE STILL PORTRAIT (route.ts:portraitDataURI(),
 *     sent as `source_image` at route.ts:~102-103) — it does not touch her
 *     idle/talking video clips at all.
 *   - The output is a 256x256 crop, verified via
 *     `ffprobe /Users/work/Desktop/starra_talking_test.mp4` → `256,256`. That
 *     IS the "pasted mouth box" this header used to claim it was not — a small
 *     square animated head, not her whole face at native resolution.
 *   - Cost is real and non-trivial: ~$0.086 per rendered turn, PLUS one more
 *     per call for the warm-up ping. Full arithmetic + both verified sources
 *     are in route.ts's header. NEXT_PUBLIC_LIPSYNC stays "0" (Charter §0/§4:
 *     no spend until STARRA/STARGATE has revenue) — this path never runs
 *     unless Classic flips that flag on himself.
 *
 * THE FREE DEFAULT IS A1'S NATIVE-RESOLUTION MOUTH-PATCH RENDERER (driven by
 * the live output-audio analyser, see viseme-sync.ts / StarraClipFace.tsx) —
 * that is what actually plays for every call today; this Replicate path is a
 * labeled, off-by-default fallback that stays off.
 *
 * SAME interface, SAME xAI regardless of which renderer is behind the flag:
 * her voice is still the live xAI Realtime stream; lip-sync only ever adds a
 * face on top of it.
 *
 * KNOWN DEFECT — WHY THIS FLAG STAYS 0 (not just "cost"): the "falls back so
 * the call never breaks" claim this header used to make is ALSO false while
 * the flag is on. useVoiceCall.ts BUFFERS her audio instead of playing it live
 * whenever LIPSYNC_ENABLED (useVoiceCall.ts:681-691), waiting for the whole-turn
 * clip to render before she's heard at all. If that render fails, her audio is
 * simply dropped — useVoiceCall.ts's own comment at :731-733 says it plainly:
 * "render failed; she's silent this turn". So turning this on does not degrade
 * to today's reactive face on failure, it makes her SILENT that turn, and even
 * on success it delays her voice by the full ~62s render. (useVoiceCall.ts is
 * A1's file — reported here as an integration note, not edited by this file.)
 *
 * Enable with NEXT_PUBLIC_LIPSYNC=1 (client) + REPLICATE_API_TOKEN (server,
 * held by /api/lipsync so the token never reaches the browser).
 */

export const LIPSYNC_ENABLED =
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_LIPSYNC === "1";

export interface LipSyncResponse {
  mode: "live" | "off" | "error";
  video?: string;
  message?: string;
}

/**
 * Render her spoken turn to a lip-synced clip via the server proxy (Replicate
 * cjwbw/sadtalker, see route.ts). Returns the clip URL, or null on any failure,
 * on a non-"live" mode (including the spend-ceiling "off"), or on a
 * network/abort error. THIS FUNCTION never throws to its caller — but see the
 * KNOWN DEFECT note above: the caller (useVoiceCall.ts, not owned by this
 * file) does not simply fall back to the reactive face on a null result while
 * LIPSYNC_ENABLED — it renders that turn silent. Turn-based: the clip comes
 * back only after the whole turn renders (62s typical), so success still means
 * her voice lands a beat after she "would have" spoken.
 */
export async function renderLipSync(
  wavBase64: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetch("/api/lipsync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wav: wavBase64 }),
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as LipSyncResponse;
    return data.mode === "live" && data.video ? data.video : null;
  } catch {
    return null; // network/abort — fall back to the reactive face
  }
}
