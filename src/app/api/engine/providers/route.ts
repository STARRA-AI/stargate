/**
 * /api/engine/providers — the credential surface.
 *
 * GET  → masked provider list. id, label, capabilities, paid, local, enabled,
 *        status, hasKey, last4, envKeys (NAMES only), detail, notes. NEVER a key.
 *        There is deliberately NO reveal endpoint anywhere in this tree; once a
 *        key is stored it can be replaced or cleared, never read back. The engine
 *        makes the same promise at its own boundary (router.ts:53).
 * POST → { id, key?, enabled?, confirmPaid? } → persist, respond masked only.
 *
 * SPEND GATE: enabling a provider marked paid:true is refused with 409 unless the
 * body carries confirmPaid:true. That is Classic's no-spend rule enforced at the
 * route boundary — a second, independent lock alongside the engine router's own
 * paid invariant. Turning a paid provider OFF never needs confirmation.
 *
 * CLEAR: `key: ""` drops the override. deepMergeConfig writes the empty string
 * and sanitizeEngineConfig then discards it (config.ts:192), so resolution falls
 * back to process.env. .env.local is never rewritten by this route.
 */

import {
  describeProviders,
  isProviderId,
  readEngineConfig,
  writeEngineConfig,
} from "@/lib/engine";
import {
  errorBody,
  faultBody,
  json,
  maskFromLast4,
  providerPatchSchema,
  toProviderView,
  toProviderViews,
  zodMessage,
} from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cfg = await readEngineConfig();
    return json({ providers: toProviderViews(describeProviders(cfg)) });
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

    // Valid ids come from the live registry, so an unknown id is rejected
    // instead of writing a config entry the router will never understand.
    const cfg = await readEngineConfig();
    const registry = toProviderViews(describeProviders(cfg));
    // Only providers that DECLARE a credential (non-empty envKeys) may be sent a
    // key. Anything else would store a secret resolveSecret can never read.
    const parsed = providerPatchSchema(
      registry.map((p) => p.id),
      registry.filter((p) => p.envKeys.length > 0).map((p) => p.id),
    ).safeParse(raw);
    if (!parsed.success) {
      return json(errorBody(zodMessage(parsed.error.issues)), 400);
    }
    const { id, key, enabled, confirmPaid } = parsed.data;

    const current = registry.find((p) => p.id === id);
    // Narrow to the engine's ProviderId union from its own guard — never a cast.
    if (!current || !isProviderId(id)) {
      return json(errorBody("Rejected — unknown provider id."), 400);
    }

    if (current.paid && enabled === true && confirmPaid !== true) {
      return json(
        errorBody(
          `${current.label} is a PAID provider. Enabling it will cost money. Re-send with confirmPaid to proceed.`,
        ),
        409,
      );
    }

    // Narrowest possible patch. An empty-string key is the explicit CLEAR gesture.
    const providerPatch: { enabled?: boolean; keyOverride?: string } = {};
    if (enabled !== undefined) providerPatch.enabled = enabled;
    if (key !== undefined) providerPatch.keyOverride = key.trim();

    const nextCfg = await writeEngineConfig({ providers: { [id]: providerPatch } });
    const after = describeProviders(nextCfg).find((p) => p.id === id);
    const afterView = after ? toProviderView(after) : null;

    return json({
      ok: true,
      // Masked echo of what is NOW IN FORCE, computed from POST-write state only.
      // It used to read `current.last4` — the PRE-write snapshot — so clearing an
      // override echoed the last 4 of the key just deleted and read as a failed
      // clear. Post-write, a cleared slot correctly shows the env-backed value's
      // last 4, or null when nothing is left.
      masked: afterView ? maskFromLast4(afterView.last4, afterView.hasKey) : null,
      provider: afterView,
    });
  } catch (err) {
    return json(faultBody(err), 500);
  }
}
