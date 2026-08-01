/**
 * Client seam for the Colab Pro / MuseTalk lip-sync renderer.
 *
 * SAME interface, SAME xAI: her voice is still the live xAI Realtime stream. The
 * ONLY addition is her face — when lip-sync is enabled, her spoken-turn audio
 * (the exact xAI PCM, wrapped as a WAV — see wav.ts) is sent to a Colab Pro GPU
 * running MuseTalk, which returns a photoreal clip whose WHOLE face (mouth + jaw
 * + cheeks, not a pasted mouth box) is locked to that audio. The clip plays in
 * the existing FaceTime overlay; on any failure the caller falls back to the
 * current reactive face, so the call never breaks.
 *
 * Enable with NEXT_PUBLIC_LIPSYNC=1 (client) + COLAB_LIPSYNC_URL (server, held
 * by /api/lipsync so the Colab URL never reaches the browser).
 */

export const LIPSYNC_ENABLED =
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_LIPSYNC === "1";

export interface LipSyncResponse {
  mode: "live" | "off" | "error";
  video?: string;
  message?: string;
}

/**
 * Render her spoken turn to a lip-synced clip via the server proxy. Returns the
 * clip URL, or null on any failure / when lip-sync is off (caller falls back to
 * the reactive face). Photoreal synced lips are inherently TURN-BASED: the clip
 * comes back after the GPU renders the whole turn, so it plays a beat after she
 * "would have" spoken — the cost of her whole face matching her words.
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
