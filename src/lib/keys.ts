import { promises as fs } from "fs";
import path from "path";
// engine/redact.ts is PURE — no imports, no fs, no env, no assertServerOnly
// (asserted by tests/keys-unify-client-safety.test.ts). It is therefore the one
// engine module this file may reach statically, since /app/settings pulls
// @/lib/keys into a client component.
import { maskKey } from "./engine/redact";

/**
 * Operator API key vault — stored server-side in data/keys.json (gitignored).
 * Each slot powers a HUD panel; unlinked slots surface a LINK cue in the UI.
 *
 * `group` is a display-only organizer for the Settings KeyVault UI — it does
 * not change storage, validation, or env fallback behavior.
 *
 * ── THE ONE RESOLUTION PATH ────────────────────────────────────────────────
 * getKey() is AUTHORITATIVE for the whole deck. Order:
 *
 *     data/engine.json keyOverride  →  data/keys.json  →  process.env
 *
 * WHY: the Options panel writes the key Classic pastes to data/engine.json
 * (providers.<id>.keyOverride, via /api/engine/providers). VOICE (api/tts),
 * REALTIME (api/realtime) and BRAIN (lib/llm/hosted) all resolve through
 * getKey(). Before this, getKey() read only data/keys.json → process.env, so the
 * panel was a NO-OP for her voice: it said "saved" and she kept the old key.
 * Fixing it HERE means every existing call site inherits it with no edit.
 */

export const KEY_GROUP_LABELS: Record<string, string> = {
  brain: "Brain — Think Tank + daily driver",
  dragontradar: "Dragon Tradar",
  multica: "Multica",
  openalice: "OpenAlice",
  future: "Future links — dormant",
};

export const KEY_SLOTS = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    hint: "sk-ant-…",
    powers: "Think Tank vote · premium brain",
    group: "brain",
  },
  {
    id: "openai",
    label: "OpenAI (GPT)",
    hint: "sk-…",
    powers: "Think Tank vote",
    group: "brain",
  },
  {
    id: "gemini",
    label: "Google (Gemini)",
    hint: "AIza…",
    powers: "Think Tank vote",
    group: "brain",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    hint: "xai-…",
    powers: "Think Tank vote",
    group: "brain",
  },
  {
    id: "groq",
    label: "Groq (Kimi K2)",
    hint: "gsk_…",
    powers: "Kimi/Groq daily-driver brain chat",
    group: "brain",
  },
  {
    id: "kalshi_key_id",
    label: "Kalshi API key ID",
    hint: "UUID from kalshi.com account settings",
    powers: "Dragon Tradar balance + real positions",
    group: "dragontradar",
  },
  {
    id: "kalshi_private_key",
    label: "Kalshi RSA private key",
    hint: "-----BEGIN RSA PRIVATE KEY----- …",
    powers: "Dragon Tradar balance + real positions",
    group: "dragontradar",
  },
  {
    id: "dragontradar_url",
    label: "Dragon Tradar stats URL",
    hint: "https://dragontradar.com/api/stats",
    powers: "Site Telemetry bots/users/trades",
    group: "dragontradar",
  },
  {
    id: "dragontradar_token",
    label: "Dragon Tradar stats token",
    hint: "Bearer token if the stats endpoint needs one",
    powers: "Site Telemetry bots/users/trades",
    group: "dragontradar",
  },
  {
    id: "multica_token",
    label: "Multica PAT",
    hint: "mul_… (Settings → Tokens on multica.ai)",
    powers: "Multica workspaces · issues · agent teammates",
    group: "multica",
  },
  {
    id: "multica_base_url",
    label: "Multica API base URL",
    hint: "https://api.multica.ai (optional; self-host override)",
    powers: "Multica cloud or self-hosted server",
    group: "multica",
  },
  {
    id: "github_token",
    label: "GitHub token",
    hint: "ghp_… or fine-grained GitHub PAT",
    powers: "Future repo-level funding lookup",
    group: "future",
  },
  {
    id: "open_collective_api_key",
    label: "Open Collective API key",
    hint: "Open Collective API key",
    powers: "Future funder-finder enrichment",
    group: "future",
  },
  {
    id: "aiassist_api_key",
    label: "AiAssist API key",
    hint: "aai_…",
    powers: "Future angel-agent investor scans",
    group: "future",
  },
  {
    id: "openalice_base_url",
    label: "OpenAlice runtime URL",
    hint: "http://127.0.0.1:47331",
    powers: "Alice market intel · issues · inbox readout",
    group: "openalice",
  },
  {
    id: "openalice_alpaca_key_id",
    label: "OpenAlice Alpaca key ID",
    hint: "Alpaca paper or live key ID",
    powers: "Broker gate unlock in OpenAlice bridge (dormant until linked)",
    group: "openalice",
  },
  {
    id: "openalice_alpaca_secret_key",
    label: "OpenAlice Alpaca secret key",
    hint: "Alpaca secret — configure in OpenAlice directly preferred",
    powers: "Broker gate unlock in OpenAlice bridge (dormant until linked)",
    group: "openalice",
  },
] as const;

export type KeySlotId = (typeof KEY_SLOTS)[number]["id"];

type KeyStore = Partial<Record<KeySlotId, string>>;

/**
 * Path to the vault. STARRA_KEYS_PATH mirrors the engine's
 * STARRA_ENGINE_CONFIG_PATH so tests can point elsewhere; read server-side only.
 * Computed per call (not a module const) so the override is honoured after load.
 */
function keysPath(): string {
  const override = process.env.STARRA_KEYS_PATH?.trim();
  return override && override.length > 0
    ? override
    : path.join(process.cwd(), "data", "keys.json");
}

export async function getKeys(): Promise<KeyStore> {
  try {
    const raw = await fs.readFile(keysPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    // A JSON array/number/null is not a store. Never let a hand-edited file throw.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as KeyStore;
  } catch {
    return {};
  }
}

// ── the engine hop ─────────────────────────────────────────────────────────
/**
 * SYNC/ASYNC DECISION, stated out loud: getKey() was ALREADY async and ALREADY
 * awaited one file read (data/keys.json), so nothing here converts a sync path
 * into an async one. What the engine hop adds on a warm process is a single
 * fs.stat — readEngineConfig() is mtime-cached (config.ts:288-313) and reparses
 * only when the file actually changed — and it runs in PARALLEL with the
 * pre-existing vault read, on the same local directory. If that disk stalls, the
 * read that was always there stalls identically; no new blocking class reaches
 * her voice, and every failure mode short-circuits to undefined.
 *
 * WHY A DYNAMIC IMPORT, not a static one: @/lib/keys is in the CLIENT import
 * graph (src/app/settings/page.tsx:5, "use client"). engine/config.ts →
 * engine/providers.ts throws at module scope in a browser (providers.ts:22-31).
 * `typeof window === "undefined"` is substituted with a constant in the client
 * build, so this whole branch — and the import with it — is dead-code-eliminated
 * there. Do NOT convert it to a static import; that kills /app/settings.
 */
type EngineOverrideReader = (id: string) => Promise<string | undefined>;

let engineReader: Promise<EngineOverrideReader | null> | null = null;

function loadEngineReader(): Promise<EngineOverrideReader | null> {
  // The import lives INSIDE the positive guard so the client build's constant
  // fold ("object" === "undefined") makes the whole block unreachable, import
  // and all. VERIFIED against the emitted client chunk — see the test.
  if (typeof window === "undefined") {
    engineReader ??= import("./engine/config")
      .then((m) => m.resolveKeyOverrideById as EngineOverrideReader)
      .catch(() => null);
    return engineReader;
  }
  return Promise.resolve(null);
}

/** The operator's pasted override, or undefined. Never throws, never rejects. */
async function engineKeyOverride(id: string): Promise<string | undefined> {
  try {
    const read = await loadEngineReader();
    if (!read) return undefined;
    const v = await read(id);
    return v?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// Warm the engine module at load so the FIRST tts/realtime request of a process
// does not pay module-eval latency on her voice path. Fire-and-forget: the catch
// inside loadEngineReader already swallows failure.
if (typeof window === "undefined") void loadEngineReader();

/**
 * The .env fallback for a slot — the LAST rung of getKey()'s order. Extracted so
 * getKey() and describeKeySlot() can never disagree about what env would supply.
 * Reads process.env directly, which is a no-op in the client bundle (Next only
 * inlines NEXT_PUBLIC_*), exactly as this map already behaved inline.
 */
function envKeyValue(id: KeySlotId): string | undefined {
  const envMap: Partial<Record<KeySlotId, string>> = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    xai: process.env.XAI_API_KEY,
    groq: process.env.GROQ_API_KEY,
    multica_token: process.env.MULTICA_TOKEN,
    multica_base_url: process.env.MULTICA_SERVER_URL ?? process.env.MULTICA_BASE_URL,
    github_token: process.env.GITHUB_TOKEN,
    open_collective_api_key: process.env.OPEN_COLLECTIVE_API_KEY,
    aiassist_api_key: process.env.AIAS_API_KEY ?? process.env.AIASSIST_API_KEY,
    openalice_base_url: process.env.OPENALICE_BASE_URL,
    openalice_alpaca_key_id: process.env.OPENALICE_ALPACA_KEY_ID,
    openalice_alpaca_secret_key: process.env.OPENALICE_ALPACA_SECRET_KEY,
  };
  return envMap[id]?.trim() || undefined;
}

export async function getKey(id: KeySlotId): Promise<string | undefined> {
  // Both stores read in parallel — the engine hop adds no serial latency.
  const [override, store] = await Promise.all([engineKeyOverride(id), getKeys()]);
  if (override) return override;
  const v = store[id]?.trim();
  if (v) return v;
  // env fallback e.g. ANTHROPIC_API_KEY
  return envKeyValue(id);
}

// ── provenance: making the shadowing VISIBLE ───────────────────────────────
/**
 * WHY THIS EXISTS. getKey()'s order is engine.json → data/keys.json → env, and
 * that order is CORRECT: the Options panel has to reach her voice. But
 * /app/settings writes the MIDDLE store (setKeys). So once the Options panel
 * holds a key for a slot, pasting a different one in /settings is OUTRANKED — it
 * saves, the UI says "KEYS STORED", and nothing changes. Silently.
 *
 * The precedence is not the bug; the SILENCE is. These helpers report which store
 * the live value came from, and whether an Options override is standing over the
 * slot, so /settings can say so plainly instead of lying by omission.
 *
 * DISCLOSURE CEILING: the store NAME and a masked last-4. Never a value, never a
 * fragment beyond what mask() already permits.
 */
export type KeyStoreName = "engine" | "vault" | "env";

export interface KeySlotStatus {
  id: KeySlotId;
  /** Which store getKey() would take the value from. null = the slot is unset. */
  source: KeyStoreName | null;
  /** Masked EFFECTIVE value — fixed-width dots + last 4, or null when unset. */
  masked: string | null;
  /**
   * TRUE when data/engine.json holds a non-blank keyOverride for this slot, so
   * anything /settings writes into data/keys.json is outranked and will NOT take
   * effect. Deliberately true even when the vault is empty — the warning has to
   * arrive BEFORE he pastes, not after.
   */
  shadowedByEngine: boolean;
}

/** Shared by both describe* helpers so the vault is read once per sweep. */
async function statusFor(id: KeySlotId, store: KeyStore): Promise<KeySlotStatus> {
  const override = await engineKeyOverride(id);
  const vault = store[id]?.trim() || undefined;
  const env = envKeyValue(id);
  const effective = override ?? vault ?? env;
  const source: KeyStoreName | null = override
    ? "engine"
    : vault
      ? "vault"
      : env
        ? "env"
        : null;
  return {
    id,
    source,
    masked: effective ? mask(effective) : null,
    shadowedByEngine: Boolean(override),
  };
}

/** Provenance for one slot. Never throws — engineKeyOverride already swallows. */
export async function describeKeySlot(id: KeySlotId): Promise<KeySlotStatus> {
  return statusFor(id, await getKeys());
}

/** Provenance for every slot, in KEY_SLOTS order. One vault read for the sweep. */
export async function describeKeySlots(): Promise<KeySlotStatus[]> {
  const store = await getKeys();
  return Promise.all(KEY_SLOTS.map((s) => statusFor(s.id, store)));
}

export async function setKeys(patch: Record<string, string>): Promise<void> {
  const store = await getKeys();
  const validIds = new Set<string>(KEY_SLOTS.map((s) => s.id));
  for (const [id, value] of Object.entries(patch)) {
    if (!validIds.has(id)) continue;
    if (value.trim() === "") {
      delete store[id as KeySlotId];
    } else {
      store[id as KeySlotId] = value.trim();
    }
  }
  const file = keysPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    // `mode` only applies when writeFile CREATES the file, so an existing vault
    // written before this line keeps its old permissions. Same belt-and-braces
    // as writeEngineConfig (config.ts:328-332). A filesystem without chmod must
    // not fail the save.
    await fs.chmod(file, 0o600);
  } catch {
    /* ignore */
  }
}

/**
 * Display form of a credential. Delegates to the engine's maskKey so there is
 * ONE masking rule in the deck: a fixed-width run of dots plus the LAST 4 only.
 * The old version emitted first4 + last4 (8 characters) and varied its width
 * with the key's length — two extra disclosures for nothing.
 */
export function mask(value: string): string {
  return maskKey(value) ?? "";
}
