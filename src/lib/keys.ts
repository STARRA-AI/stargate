import { promises as fs } from "fs";
import path from "path";

/**
 * Operator API key vault — stored server-side in data/keys.json (gitignored).
 * Each slot powers a HUD panel; unlinked slots surface a LINK cue in the UI.
 *
 * `group` is a display-only organizer for the Settings KeyVault UI — it does
 * not change storage, validation, or env fallback behavior.
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

const KEYS_PATH = path.join(process.cwd(), "data", "keys.json");

export async function getKeys(): Promise<KeyStore> {
  try {
    const raw = await fs.readFile(KEYS_PATH, "utf8");
    return JSON.parse(raw) as KeyStore;
  } catch {
    return {};
  }
}

export async function getKey(id: KeySlotId): Promise<string | undefined> {
  const store = await getKeys();
  const v = store[id]?.trim();
  if (v) return v;
  // env fallback e.g. ANTHROPIC_API_KEY
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
  await fs.mkdir(path.dirname(KEYS_PATH), { recursive: true });
  await fs.writeFile(KEYS_PATH, JSON.stringify(store, null, 2), "utf8");
}

export function mask(value: string): string {
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
