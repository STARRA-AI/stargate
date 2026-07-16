import { promises as fs } from "fs";
import path from "path";

export type Exchange = {
  role: "user" | "assistant";
  content: string;
  at: string;
};

export type MemoryStore = {
  working: Exchange[];
  summaries: string[];
  archival: { id: string; text: string; at: string }[];
};

const DATA_PATH = path.join(process.cwd(), "data", "memory.json");

const EMPTY: MemoryStore = { working: [], summaries: [], archival: [] };

async function ensure() {
  try {
    await fs.access(DATA_PATH);
  } catch {
    await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
    await fs.writeFile(DATA_PATH, JSON.stringify(EMPTY, null, 2), "utf8");
  }
}

export async function getMemory(): Promise<MemoryStore> {
  await ensure();
  const raw = await fs.readFile(DATA_PATH, "utf8");
  return JSON.parse(raw) as MemoryStore;
}

export async function saveMemory(store: MemoryStore): Promise<MemoryStore> {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(store, null, 2), "utf8");
  return store;
}

export async function recordExchange(
  role: "user" | "assistant",
  content: string,
): Promise<MemoryStore> {
  const store = await getMemory();
  store.working.push({ role, content, at: new Date().toISOString() });

  // Keep last ~10 raw exchanges in working; roll older into summary every 30
  if (store.working.length > 10) {
    const overflow = store.working.splice(0, store.working.length - 10);
    const blob = overflow.map((e) => `${e.role}: ${e.content}`).join(" | ");
    store.archival.push({
      id: `arc-${Date.now()}`,
      text: blob.slice(0, 500),
      at: new Date().toISOString(),
    });
  }

  const totalMsgs =
    store.working.length + store.summaries.length * 30 + store.archival.length;
  if (totalMsgs > 0 && store.working.length === 10 && store.working.length % 2 === 0) {
    // Lightweight rolling summary without requiring LLM
    if (store.working.length >= 10 && store.summaries.length < Math.floor(store.archival.length / 3) + 1) {
      const para = store.working
        .map((e) => e.content)
        .join(" ")
        .slice(0, 400);
      if (para && !store.summaries.includes(para)) {
        store.summaries.push(para);
      }
    }
  }

  return saveMemory(store);
}

export function memoryForPrompt(store: MemoryStore, query: string): string {
  const q = query.toLowerCase();
  const hits = store.archival
    .filter((a) => a.text.toLowerCase().includes(q.slice(0, 24)) || q.length < 3)
    .slice(-5);
  return [
    "MEMORY TIERS",
    `Working (${store.working.length}): ${store.working.map((e) => `${e.role}: ${e.content}`).join(" || ") || "empty"}`,
    `Summaries (${store.summaries.length}): ${store.summaries.slice(-3).join(" || ") || "empty"}`,
    `Archival hits (${hits.length}): ${hits.map((h) => h.text).join(" || ") || "none"}`,
  ].join("\n");
}

export function memoryCounts(store: MemoryStore) {
  return {
    working: store.working.length,
    summaries: store.summaries.length,
    archival: store.archival.length,
  };
}
