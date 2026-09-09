/**
 * Engine settings routes — shared pure layer.
 *
 * DESIGN RULE: this file imports NOTHING from `@/lib/engine`. It holds only
 * pure functions + zod schemas over plain data. Two reasons:
 *   1. SECRET DISCIPLINE. Every response body the /api/engine/* routes emit is
 *      built by an explicit allowlist projection in here (`toProviderView`).
 *      Even if the engine hands back a record that still carries `keyOverride`
 *      or a raw key, the projection drops it — the routes can only serialize
 *      fields named here. This is the chokepoint an adversarial reviewer should
 *      audit, and tests/engine-api-shared.test.ts hammers it directly.
 *   2. TESTABILITY. The engine core lands in parallel; these helpers are unit
 *      testable without it, so the security invariants are proven now.
 *
 * Structural typing is deliberate: `status` / `capability` are typed `string`
 * here, not engine literal unions, so the engine's stricter types flow in
 * without this file importing them. The routes import engine FUNCTIONS by name
 * only — that is the entire integration surface.
 */

import { z } from "zod";
import { redact } from "@/lib/security/redact";

/* ────────────────────────────── view shapes ───────────────────────────── */

/**
 * The ONLY provider fields that may ever cross the wire. No key. No
 * keyOverride. No reveal field. `last4` is the maximum disclosure.
 */
export type ProviderView = {
  id: string;
  label: string;
  capabilities: string[];
  paid: boolean;
  /** Runs on this machine (Ollama, Piper, the viseme bank) — free by definition. */
  local: boolean;
  enabled: boolean;
  status: string;
  hasKey: boolean;
  last4: string | null;
  /** Env var NAMES that back this provider. Names only, never values —
   *  src/lib/engine/router.ts:67 documents the same guarantee. */
  envKeys: string[];
  detail: string;
  notes: string;
};

/** One rung of a capability's fallback chain, as shown in CAPABILITY ROUTING. */
export type ChainLinkView = {
  id: string;
  eligible: boolean;
  status: string;
  why: string;
};

/** A capability resolution as rendered by the panel. */
export type ResolutionView = {
  capability: string;
  providerId: string | null;
  why: string;
  chain: ChainLinkView[];
};

/** A single entry in DIAGNOSTICS' "what is broken right now" list. */
export type Fault = {
  severity: "error" | "warn";
  what: string;
  fix: string;
  capability?: string;
  providerId?: string;
};

/* Loose input shapes: what we accept FROM the engine. Every field optional so a
 * partially-built engine cannot crash a route — the projection fills defaults. */
type ProviderLike = {
  id?: unknown;
  label?: unknown;
  capabilities?: unknown;
  paid?: unknown;
  local?: unknown;
  enabled?: unknown;
  status?: unknown;
  hasKey?: unknown;
  last4?: unknown;
  envKeys?: unknown;
  detail?: unknown;
  notes?: unknown;
};

type ResolutionLike = {
  capability?: unknown;
  providerId?: unknown;
  why?: unknown;
  /** src/lib/engine/router.ts:49 — every candidate in chain order. */
  considered?: unknown;
  chain?: unknown;
};

/* ─────────────────────────── safe projections ──────────────────────────── */

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown): boolean {
  return v === true;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * `last4` is clamped to at most 4 characters. Even if the engine ever regressed
 * and put a whole key in this field, at most 4 trailing characters escape.
 */
function last4Of(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(-4);
}

/* ─────────────────────────── the masked echo ───────────────────────────── */

/**
 * Display mask rebuilt from a last-4 fragment — for the one case where the route
 * has the POST-WRITE state (which carries only `last4`) and not the plaintext.
 *
 * WHY IT EXISTS. The providers route used to echo `••••${current.last4}` from the
 * PRE-write snapshot, so the documented CLEAR gesture (`key: ""`) reported the
 * last 4 of the key just deleted — it read as "clear failed". It also hand-rolled
 * a 4-bullet run while the engine's maskKey uses 8, so the same credential got
 * two different widths depending on the code path.
 *
 * The width here MIRRORS src/lib/engine/redact.ts:18-19,77-83 (8 dots + last 4,
 * or 12 dots when the value is too short to reveal any of). Duplicated rather
 * than imported because this file imports nothing from @/lib/engine;
 * tests/engine-minors-provider-patch.test.ts asserts the two are byte-identical.
 */
const MASK_CHAR = "•";
const MASK_BODY = 8;

export function maskFromLast4(
  tail: string | null | undefined,
  /** True when a credential IS in force but is too short to reveal 4 of. */
  present = false,
): string | null {
  const t = typeof tail === "string" ? tail.trim() : "";
  if (t) return MASK_CHAR.repeat(MASK_BODY) + t.slice(-4);
  return present ? MASK_CHAR.repeat(MASK_BODY + 4) : null;
}

/** Scrub a field that is legitimately allowed to be empty. scrubMessage() is for
 *  ERROR text and substitutes "unspecified fault" for an empty input, which is
 *  wrong for a descriptive field — this keeps empty as empty. */
function scrubField(v: unknown, maxLen: number): string {
  const raw = str(v).trim();
  return raw ? scrubMessage(raw, maxLen) : "";
}

/** Allowlist projection — the secret chokepoint. Never spread the input. */
export function toProviderView(p: ProviderLike): ProviderView {
  return {
    id: str(p.id),
    label: str(p.label) || str(p.id),
    capabilities: strArray(p.capabilities),
    paid: bool(p.paid),
    enabled: bool(p.enabled),
    local: bool(p.local),
    status: str(p.status, "unknown"),
    hasKey: bool(p.hasKey),
    last4: last4Of(p.last4),
    envKeys: strArray(p.envKeys),
    detail: scrubField(p.detail, 200),
    notes: str(p.notes).slice(0, 200),
  };
}

export function toProviderViews(list: readonly ProviderLike[]): ProviderView[] {
  return list.map(toProviderView);
}

export function toResolutionView(r: ResolutionLike): ResolutionView {
  // The engine names the chain `considered` and the per-rung verdict `ok`/`reason`
  // (ProviderVerdict, router.ts:33). `chain`/`eligible`/`why` are accepted as
  // aliases so this projection survives a rename on either side.
  const rawChain = Array.isArray(r.considered)
    ? r.considered
    : Array.isArray(r.chain)
      ? r.chain
      : [];
  return {
    capability: str(r.capability),
    providerId: typeof r.providerId === "string" && r.providerId ? r.providerId : null,
    why: str(r.why),
    chain: rawChain.map((c) => {
      const link = (c ?? {}) as Record<string, unknown>;
      return {
        id: str(link.id),
        eligible: bool(link.ok) || bool(link.eligible),
        status: str(link.status, "unknown"),
        why: scrubField(str(link.reason) || str(link.why), 200),
      };
    }),
  };
}

/* ───────────────────────────── error voice ─────────────────────────────── */

/**
 * Scrub anything key-shaped out of a message before it reaches the client or a
 * log line. Layer 1 is the repo's own `redact()` (src/lib/security/redact.ts —
 * structural rules + literal values of known env secrets). Layer 2 covers key
 * prefixes redact() has no structural rule for (xAI `xai-`, HuggingFace `hf_`,
 * Replicate `r8_`) plus any long opaque token.
 *
 * No regex lookbehind anywhere (macOS 12 / WKWebView rule, held server-side too).
 */
export function scrubMessage(input: unknown, maxLen = 320): string {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof Error
        ? input.message
        : "unspecified fault";

  let out = redact(raw, maxLen * 4);
  out = out.replace(/\b(?:xai|hf|r8|gsk|sk|hf_?token|key|tok)[-_][A-Za-z0-9\-_]{8,}/gi, "[REDACTED_KEY]");
  out = out.replace(/\b[A-Za-z0-9\-_]{40,}\b/g, "[REDACTED_TOKEN]");
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > maxLen) out = `${out.slice(0, maxLen)}…`;
  return out || "unspecified fault";
}

/** Operator-voice error body. Never a stack, never a key. */
export function errorBody(message: string): { error: string } {
  return { error: scrubMessage(message) };
}

/** Standard 500 body for an unexpected throw. Scrubs the exception too. */
export function faultBody(err: unknown): { error: string } {
  return { error: `Engine fault. ${scrubMessage(err)}` };
}

/** Flatten a zod error into one operator-voice line, no internals. */
export function zodMessage(issues: readonly { path: readonly (string | number | symbol)[]; message: string }[]): string {
  const first = issues[0];
  if (!first) return "Rejected — malformed body.";
  const where = first.path.length ? first.path.map(String).join(".") : "body";
  return `Rejected — ${where}: ${first.message}`;
}

/* ──────────────────────────────── schemas ─────────────────────────────── */

/**
 * POST /api/engine/providers body.
 *
 * `validIds` comes from the engine's own provider registry at request time —
 * unknown ids are rejected rather than silently written, and this file never
 * hardcodes a provider list that could drift from the registry.
 *
 * `key: ""` is the explicit CLEAR gesture (drop the override, fall back to
 * process.env). `confirmPaid` is the machine-checked half of Classic's no-spend
 * rule: enabling a paid provider without it is refused at the route boundary,
 * independently of whatever the engine router does.
 *
 * `keyedIds` are the ids that HAVE a credential slot — the registry's providers
 * whose `envKeys` is non-empty (src/lib/engine/providers.ts:274-276 `needsKey`).
 * A key sent for anything else (Ollama, Piper, Web Speech, the viseme bank, local
 * memory — envKeys `[]`, e.g. providers.ts:171) is REFUSED: resolveSecret would
 * never read it, so it would be an unused secret sitting at rest on disk for no
 * reason, and that provider's hasKey/last4 would start reporting a credential
 * nothing uses. It defaults to `validIds` so an existing one-argument caller
 * keeps its previous behaviour rather than silently tightening.
 */
export function providerPatchSchema(
  validIds: readonly string[],
  keyedIds: readonly string[] = validIds,
) {
  const known = new Set(validIds);
  const keyed = new Set(keyedIds);
  return z
    .strictObject({
      id: z.string().trim().min(1).max(64),
      key: z.string().max(4096).optional(),
      enabled: z.boolean().optional(),
      confirmPaid: z.boolean().optional(),
    })
    .refine((b) => known.has(b.id), {
      message: "unknown provider id",
      path: ["id"],
    })
    .refine((b) => b.key !== undefined || b.enabled !== undefined, {
      message: "nothing to change — send key or enabled",
      path: ["body"],
    })
    .refine((b) => b.key === undefined || keyed.has(b.id), {
      message: "this provider needs no credential",
      path: ["key"],
    });
}

/** POST /api/engine/test body. */
export function providerIdSchema(validIds: readonly string[]) {
  const known = new Set(validIds);
  return z.strictObject({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((v) => known.has(v), { message: "unknown provider id" }),
  });
}

/* ─────────────────────────────── cosmetics ────────────────────────────── */

/**
 * Cosmetics contract owned by this surface (the panel writes it, the panel
 * reads it). Persisted through the engine's config store; the engine treats it
 * as opaque. Every value is bounded so a bad write cannot make the deck
 * unreadable — fontScale can't shrink text to nothing, glow can't white out the
 * HUD, and idlePool entries are constrained to safe clip-id characters.
 */
export const COSMETIC_IDLE_CLIPS = ["idle_a1", "idle_c1", "idle_a2"] as const;

/**
 * THE ONE COSMETICS RANGE — the narrow, UI-safe set. MIRROR of the store's
 * src/lib/engine/config.ts COSMETIC_BOUNDS; the two are asserted equal by
 * tests/engine-minors-cosmetics-bounds.test.ts, the same way the two
 * DEFAULT_COSMETICS are. Duplicated rather than imported because this file
 * imports NOTHING from @/lib/engine (see the header) — the store is server-only.
 *
 * The store used to be WIDER than this (glowIntensity max 3, fontScale 0.5-2),
 * which is exactly how a glowIntensity of 2.0 in a hand-edited data/engine.json
 * could pass sanitize and then blow away every cosmetic here. It no longer is.
 */
export const COSMETIC_BOUNDS = {
  accentHue: [0, 360],
  glowIntensity: [0, 1.6],
  fontScale: [0.85, 1.35],
} as const;

/** Clip-id shape. Bounded quantifier, no lookbehind (macOS 12 / WKWebView). */
const IDLE_CLIP_ID = /^[a-z0-9_]{1,32}$/;
const IDLE_POOL_MAX = 8;

export const cosmeticsSchema = z.strictObject({
  accentHue: z.number().int().min(COSMETIC_BOUNDS.accentHue[0]).max(COSMETIC_BOUNDS.accentHue[1]),
  glowIntensity: z
    .number()
    .min(COSMETIC_BOUNDS.glowIntensity[0])
    .max(COSMETIC_BOUNDS.glowIntensity[1]),
  reduceMotion: z.boolean(),
  idlePool: z.array(z.string().regex(IDLE_CLIP_ID)).min(1).max(IDLE_POOL_MAX),
  mouthSync: z.boolean(),
  fontScale: z.number().min(COSMETIC_BOUNDS.fontScale[0]).max(COSMETIC_BOUNDS.fontScale[1]),
  /** See EngineCosmetics.bodyMode — "still" is the shipped behaviour. */
  bodyMode: z.enum(["still", "alive"]),
});

export type Cosmetics = z.infer<typeof cosmeticsSchema>;

export const cosmeticsPatchSchema = cosmeticsSchema.partial().refine(
  (o) => Object.keys(o).length > 0,
  { message: "nothing to change", path: ["body"] },
);

/**
 * MIRROR of the engine's stored defaults (src/lib/engine/config.ts:86
 * DEFAULT_COSMETICS). The engine's config store is the single source of truth;
 * this copy exists so the projection layer stays engine-free and unit testable,
 * and tests/engine-api-cosmetics-parity.test.ts asserts the two never drift.
 *
 * mouthSync defaults ON because the proven failure this build fixes was a shut
 * mouth over live audio. Cosmetics NEVER gate audio — mouthSync gates the MOUTH.
 *
 * accentHue 271 is the MEASURED hue of the shipped `--purple` #a855f7
 * (globals.css:7 → hsl(271 91% 65%)), so opening Options cannot shift the deck's
 * colour. The engine division measured the same value independently
 * (src/lib/engine/config.ts:92) and a parity test asserts the two stay equal.
 */
export const DEFAULT_COSMETICS: Cosmetics = {
  accentHue: 271,
  glowIntensity: 1,
  reduceMotion: false,
  idlePool: [...COSMETIC_IDLE_CLIPS],
  mouthSync: true,
  fontScale: 1,
  bodyMode: "still",
};

/** A fresh copy of the defaults — never the module's own idlePool array. */
function defaultCosmetics(): Cosmetics {
  return { ...DEFAULT_COSMETICS, idlePool: [...DEFAULT_COSMETICS.idlePool] };
}

/** Out-of-range CLAMPS to the nearest legal value; a non-number falls back. */
function clampCosmetic(
  v: unknown,
  key: keyof typeof COSMETIC_BOUNDS,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const [lo, hi] = COSMETIC_BOUNDS[key];
  return v < lo ? lo : v > hi ? hi : v;
}

/** Keep only real clip ids; an unusable pool falls back to the vetted three. */
function normalizeIdlePool(v: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(v)) return [...fallback];
  const out = v
    .filter((x): x is string => typeof x === "string" && IDLE_CLIP_ID.test(x))
    .slice(0, IDLE_POOL_MAX);
  return out.length > 0 ? out : [...fallback];
}

/**
 * Merge a stored/partial blob over the defaults.
 *
 * PER-FIELD, DELIBERATELY. The old version merged then validated the whole
 * object, so ONE out-of-range number failed the schema and returned
 * `{...DEFAULT_COSMETICS}` — discarding every unrelated setting he had. Now each
 * field is repaired on its own: ranged numbers CLAMP to the nearest legal value,
 * a non-boolean toggle is dropped rather than coerced (`"off"` is truthy), and a
 * hostile idlePool entry is filtered out without touching anything else. The
 * final safeParse is belt-and-braces; it should never be the thing that fires.
 */
export function normalizeCosmetics(raw: unknown): Cosmetics {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaultCosmetics();
  }
  const src = raw as Record<string, unknown>;
  const d = DEFAULT_COSMETICS;
  const merged: Cosmetics = {
    accentHue: Math.round(clampCosmetic(src.accentHue, "accentHue", d.accentHue)),
    glowIntensity: clampCosmetic(src.glowIntensity, "glowIntensity", d.glowIntensity),
    reduceMotion: typeof src.reduceMotion === "boolean" ? src.reduceMotion : d.reduceMotion,
    idlePool: normalizeIdlePool(src.idlePool, d.idlePool),
    mouthSync: typeof src.mouthSync === "boolean" ? src.mouthSync : d.mouthSync,
    fontScale: clampCosmetic(src.fontScale, "fontScale", d.fontScale),
    // Anything that is not one of the two known modes falls back to the shipped
    // one. An unknown value must never strand her on the new path.
    bodyMode: src.bodyMode === "alive" || src.bodyMode === "still" ? src.bodyMode : d.bodyMode,
  };
  const parsed = cosmeticsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaultCosmetics();
}

/* ───────────────────────── "what is broken now" ───────────────────────── */

const CAP_FIX: Record<string, string> = {
  brain: "Enable Groq (free) or start local Ollama, then re-check.",
  voice: "Key xAI for Ara, or fall back to Piper / Web Speech.",
  realtime: "Realtime needs the xAI key. Chat + TTS still work without it.",
  lipsync: "The free local viseme bank covers this — enable it in COSMETICS.",
  memory: "Local store only. Check data/ is writable.",
  vision: "No vision provider configured. Optional surface.",
};

/**
 * Derive the DIAGNOSTICS list. Errors first, then warnings; each fault carries
 * a fix, never a bare complaint. A PAID provider left enabled is reported as a
 * SPEND warning every single time — that is the loudest thing on this deck.
 */
export function deriveFaults(
  providers: readonly ProviderView[],
  resolutions: readonly ResolutionView[],
  engineBroken?: readonly { capability?: unknown; providerId?: unknown; why?: unknown }[],
): Fault[] {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const faults: Fault[] = [];

  // When the engine supplies its own broken list (health.ts BrokenItem), it is
  // the authority on capability-level faults — it has probe results this layer
  // does not. We only add the severity + the fix, which it does not carry.
  const capsCoveredByEngine = new Set<string>();
  for (const item of engineBroken ?? []) {
    const cap = str(item.capability);
    const pid = typeof item.providerId === "string" ? item.providerId : undefined;
    capsCoveredByEngine.add(cap);
    faults.push({
      severity: "error",
      capability: cap,
      providerId: pid,
      what: `${cap.toUpperCase()} is down${scrubField(item.why, 160) ? ` — ${scrubField(item.why, 160)}` : "."}`,
      fix: CAP_FIX[cap] ?? "Enable a configured provider for this capability.",
    });
  }

  for (const r of resolutions) {
    if (capsCoveredByEngine.has(r.capability)) {
      // Already reported with better information. Still check the spend rule below.
      const chosenPaid = r.providerId ? byId.get(r.providerId)?.paid : false;
      if (!chosenPaid) continue;
    }
    if (!r.providerId) {
      faults.push({
        severity: "error",
        capability: r.capability,
        what: `${r.capability.toUpperCase()} has no live provider${r.why ? ` — ${r.why}` : "."}`,
        fix: CAP_FIX[r.capability] ?? "Enable a configured provider for this capability.",
      });
      continue;
    }
    const chosen = byId.get(r.providerId);
    if (chosen?.paid) {
      faults.push({
        severity: "error",
        capability: r.capability,
        providerId: chosen.id,
        what: `SPEND — ${r.capability.toUpperCase()} is routed to ${chosen.label}, which costs money.`,
        fix: `Disable ${chosen.label} to fall back to the free path.`,
      });
    }
  }

  for (const p of providers) {
    if (p.paid && p.enabled) {
      faults.push({
        severity: "warn",
        providerId: p.id,
        what: `SPEND — ${p.label} is PAID and currently enabled.`,
        fix: "Disable it unless you intend to spend.",
      });
    }
    // ONLY providers that actually need a credential. A local provider (Ollama,
    // Piper, Web Speech, the viseme bank, local memory) has no envKeys and needs
    // no key — warning about it would fill the one list Classic reads first with
    // five permanent false alarms, which trains him to ignore it. Caught live on
    // the running deck, not assumed.
    if (p.enabled && !p.hasKey && !p.local && p.envKeys.length > 0) {
      faults.push({
        severity: "warn",
        providerId: p.id,
        what: `${p.label} is enabled with no key linked.`,
        fix: `Paste ${p.envKeys[0]} under PROVIDERS AND KEYS, or disable it.`,
      });
    }
    if (p.status === "unreachable") {
      faults.push({
        severity: "warn",
        providerId: p.id,
        what: `${p.label} did not answer its health probe.`,
        fix: `Run TEST on ${p.label}; if it stays down the router skips it.`,
      });
    }
  }

  const rank = (f: Fault) => (f.severity === "error" ? 0 : 1);
  return faults.sort((a, b) => rank(a) - rank(b));
}

/** JSON response with caching disabled — settings must never be served stale. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
