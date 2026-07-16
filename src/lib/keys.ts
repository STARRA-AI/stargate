import { promises as fs } from "fs";
import path from "path";

/**
 * Operator API key vault — stored server-side in data/keys.json (gitignored).
 * Each slot powers a HUD panel; unlinked slots surface a LINK cue in the UI.
 */

export const KEY_SLOTS = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    hint: "sk-ant-…",
    powers: "Think Tank vote · premium brain",
  },
  {
    id: "openai",
    label: "OpenAI (GPT)",
    hint: "sk-…",
    powers: "Think Tank vote",
  },
  {
    id: "gemini",
    label: "Google (Gemini)",
    hint: "AIza…",
    powers: "Think Tank vote",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    hint: "xai-…",
    powers: "Think Tank vote",
  },
  {
    id: "kalshi_key_id",
    label: "Kalshi API key ID",
    hint: "UUID from kalshi.com account settings",
    powers: "Dragon Tradar balance + real positions",
  },
  {
    id: "kalshi_private_key",
    label: "Kalshi RSA private key",
    hint: "-----BEGIN RSA PRIVATE KEY----- …",
    powers: "Dragon Tradar balance + real positions",
  },
  {
    id: "dragontradar_url",
    label: "Dragon Tradar stats URL",
    hint: "https://dragontradar.com/api/stats",
    powers: "Site Telemetry bots/users/trades",
  },
  {
    id: "dragontradar_token",
    label: "Dragon Tradar stats token",
    hint: "Bearer token if the stats endpoint needs one",
    powers: "Site Telemetry bots/users/trades",
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
