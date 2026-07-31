import { promises as fs } from "fs";
import path from "path";
import { redact } from "@/lib/security/redact";

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
  // A corrupt/partial data/memory.json (crash mid-write, manual edit) must NOT
  // take the chat brain down: getMemory() runs in the chat route's top-level
  // Promise.all (outside its try/catch), so a thrown JSON.parse there 500s every
  // request. Fall back to a FRESH empty store (never the shared EMPTY ref, which
  // recordExchange would then mutate); the next recordExchange write self-heals.
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<MemoryStore>;
    return {
      working: Array.isArray(parsed.working) ? parsed.working : [],
      summaries: Array.isArray(parsed.summaries) ? parsed.summaries : [],
      archival: Array.isArray(parsed.archival) ? parsed.archival : [],
    };
  } catch {
    return { working: [], summaries: [], archival: [] };
  }
}

export async function saveMemory(store: MemoryStore): Promise<MemoryStore> {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(store, null, 2), "utf8");
  return store;
}

/**
 * How many raw exchanges stay verbatim in working memory. RAISED 10 → 24
 * (2026-07-30, Classic: "she can't recall things") — the last-10 window was
 * the measured cause of shallow recall on every surface. 24 is safe everywhere
 * it is read: the Kimi/Groq chat prompt clips itself to budget downstream
 * (api/chat clampToBudget), the call digest clips at 4000 chars in
 * useVoiceCall, and Grok/Anthropic take it whole.
 */
export const WORKING_WINDOW = 24;

// ONE WRITER AT A TIME (confirmed review finding). recordExchange is a
// read-modify-write of data/memory.json, and the deck now has CONCURRENT
// writers: api/chat's own turns, the call leg's POST /api/memory, and
// back-to-back call commits (assistant turn + barge-in user turn). Unserialized,
// the second write clobbers the first and a turn vanishes from the one shared
// memory. Every write flows through this in-process chain instead — each sees
// the previous write's result. The dev deck is a single Next process, so an
// in-process chain is the whole story.
let memoryWriteChain: Promise<unknown> = Promise.resolve();

export function recordExchange(
  role: "user" | "assistant",
  content: string,
): Promise<MemoryStore> {
  const run = () => recordExchangeUnserialized(role, content);
  const p = memoryWriteChain.then(run, run);
  memoryWriteChain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

async function recordExchangeUnserialized(
  role: "user" | "assistant",
  content: string,
): Promise<MemoryStore> {
  const store = await getMemory();
  store.working.push({
    role,
    content: redact(content),
    at: new Date().toISOString(),
  });

  // Keep the last WORKING_WINDOW raw exchanges verbatim; roll older into archival
  if (store.working.length > WORKING_WINDOW) {
    const overflow = store.working.splice(0, store.working.length - WORKING_WINDOW);
    const blob = overflow.map((e) => `${e.role}: ${e.content}`).join(" | ");
    store.archival.push({
      id: `arc-${Date.now()}`,
      text: redact(blob.slice(0, 500)),
      at: new Date().toISOString(),
    });
  }

  const totalMsgs =
    store.working.length + store.summaries.length * 30 + store.archival.length;
  if (totalMsgs > 0 && store.working.length === WORKING_WINDOW) {
    // Lightweight rolling summary without requiring LLM
    if (store.summaries.length < Math.floor(store.archival.length / 3) + 1) {
      const para = store.working
        .map((e) => e.content)
        .join(" ")
        .slice(0, 400);
      if (para && !store.summaries.includes(para)) {
        store.summaries.push(redact(para));
      }
    }
  }

  return saveMemory(store);
}

export function memoryForPrompt(store: MemoryStore, query: string): string {
  // WORD-SCORED archival recall (confirmed review finding: the old filter
  // required the blob to contain the query's exact first-24-char prefix, which
  // no real sentence ever satisfies — the archival tier was effectively dead).
  // Now: any blob sharing significant words (4+ chars) with the query scores
  // one point per matched word; top 5 by score, recency breaking ties. A short
  // or empty query (the call digest) keeps the recent-5 behavior.
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
  const scored = store.archival.map((a, recency) => {
    const t = a.text.toLowerCase();
    let score = 0;
    for (const w of words) if (t.includes(w)) score += 1;
    return { a, recency, score };
  });
  const hits = (
    words.length === 0
      ? scored.slice(-5)
      : scored
          .filter((s) => s.score > 0)
          .sort((x, y) => x.score - y.score || x.recency - y.recency)
          .slice(-5)
  ).map((s) => s.a);
  // Working is rendered NEWEST FIRST on purpose: both consumers truncate this
  // block from the tail (api/chat clips the system prompt to budget; the call
  // digest slices at 4000 chars), so whatever gets cut must be the OLDEST
  // exchanges, never the most recent ones.
  return [
    "MEMORY TIERS",
    `Working (${store.working.length}, newest first): ${[...store.working]
      .reverse()
      .map((e) => `${e.role}: ${e.content}`)
      .join(" || ") || "empty"}`,
    `Summaries (${store.summaries.length}): ${store.summaries.slice(-5).join(" || ") || "empty"}`,
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
