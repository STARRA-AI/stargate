/**
 * /api/engine/cosmetics — look-and-feel, persisted server-side so it survives a
 * reload without a rebuild. The panel applies these as CSS custom properties on
 * the root element, so nothing here needs a restart.
 *
 * GET  → the current, normalized cosmetics (defaults filled in).
 * POST → a partial patch, merged over what is stored, bounded by the schema.
 *
 * Every field is range-clamped in _shared.ts, so a bad write cannot render the
 * deck unreadable. `mouthSync` is the only field with any bearing on the voice
 * path and it gates the MOUTH, never the AUDIO.
 *
 * The store is the engine's data/engine.json (0600, gitignored via /data/*.json).
 * .env.local is never touched.
 */

import { readEngineConfig, writeEngineConfig } from "@/lib/engine";
import {
  cosmeticsPatchSchema,
  errorBody,
  faultBody,
  json,
  normalizeCosmetics,
  zodMessage,
} from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cfg = await readEngineConfig();
    return json({ cosmetics: normalizeCosmetics(cfg.cosmetics) });
  } catch (err) {
    return json(faultBody(err), 500);
  }
}

export async function POST(req: Request) {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json(errorBody("Rejected — body was not valid JSON."), 400);
    }

    const parsed = cosmeticsPatchSchema.safeParse(raw);
    if (!parsed.success) {
      return json(errorBody(zodMessage(parsed.error.issues)), 400);
    }

    // Merge over what is already stored so a one-field change never resets the rest.
    const cfg = await readEngineConfig();
    const next = normalizeCosmetics({
      ...normalizeCosmetics(cfg.cosmetics),
      ...parsed.data,
    });

    const written = await writeEngineConfig({ cosmetics: next });
    return json({ ok: true, cosmetics: normalizeCosmetics(written.cosmetics) });
  } catch (err) {
    return json(faultBody(err), 500);
  }
}

