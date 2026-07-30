/**
 * /api/keys — the operator's credential vault (data/keys.json).
 *
 * GET  → one row per slot: label/hint/powers, whether it is linked, a masked
 *        last-4, WHICH store the live value came from, and whether an Options
 *        override is standing over it. Never a key, and there is no reveal path.
 * POST → { slotId: value } → written to the vault, with the shadowed slot ids
 *        echoed back so "KEYS STORED" can never mislead.
 *
 * THE SHADOWING THIS ROUTE MAKES VISIBLE: getKey() resolves engine.json
 * keyOverride → data/keys.json → process.env (src/lib/keys.ts:16-27). This route
 * writes the MIDDLE store, so a key pasted here is outranked whenever the Options
 * panel already holds one for the same slot. The order is correct and unchanged;
 * what changed is that the operator is now TOLD.
 */

import { KEY_SLOTS, describeKeySlots, setKeys, type KeySlotId } from "@/lib/keys";

export const runtime = "nodejs";

const SLOT_META = new Map(KEY_SLOTS.map((s) => [s.id as string, s]));
const VALID_IDS = new Set<string>(KEY_SLOTS.map((s) => s.id));

export async function GET() {
  // Provenance resolves each slot through the same order the app actually uses,
  // so a key provided via .env (not just the vault file) still shows as linked.
  const slots = (await describeKeySlots()).map((st) => {
    const meta = SLOT_META.get(st.id);
    return {
      id: st.id,
      label: meta?.label ?? st.id,
      hint: meta?.hint ?? "",
      powers: meta?.powers ?? "",
      linked: st.source !== null,
      masked: st.masked,
      /** "engine" = the Options panel · "vault" = this page · "env" = .env.local */
      source: st.source,
      /** A key saved HERE for this slot will not take effect while this is true. */
      shadowedByEngine: st.shadowedByEngine,
    };
  });
  return Response.json({ slots });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "body must be an object" }, { status: 400 });
  }
  for (const value of Object.values(body as Record<string, unknown>)) {
    if (typeof value !== "string") {
      return Response.json(
        { error: "all key values must be strings" },
        { status: 400 },
      );
    }
  }
  const patch = body as Record<string, string>;
  await setKeys(patch);

  // Which of the slots he just saved are outranked by an Options override. Ids
  // only — the caller already knows the labels, and an id is not a secret.
  const touched = new Set(Object.keys(patch).filter((id) => VALID_IDS.has(id)));
  const shadowed = (await describeKeySlots())
    .filter((st) => touched.has(st.id) && st.shadowedByEngine)
    .map((st) => st.id as KeySlotId);

  return Response.json({ ok: true, shadowed });
}
