/**
 * FLIP RADAR store — data/flipradar.json (gitignored with the rest of data/).
 *
 * Same discipline as lib/memory/store.ts: reads are corruption-tolerant (a
 * broken file yields a fresh empty store, the next write self-heals) and every
 * write flows through one in-process chain so concurrent scan/status writes
 * can never clobber each other.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FlipCandidate, FlipVerdict } from "./scan";

export type FlipStatus = "new" | "approved" | "passed" | "building";

export type RadarEntry = FlipCandidate & {
  verdict: FlipVerdict | null;
  status: FlipStatus;
  seenAt: string;
  updatedAt: string;
};

export type RadarStore = {
  entries: RadarEntry[];
  lastScanAt: string | null;
};

const DATA_PATH = path.join(process.cwd(), "data", "flipradar.json");

export async function getRadar(): Promise<RadarStore> {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<RadarStore>;
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      lastScanAt:
        typeof parsed.lastScanAt === "string" ? parsed.lastScanAt : null,
    };
  } catch {
    return { entries: [], lastScanAt: null };
  }
}

async function saveRadar(store: RadarStore): Promise<RadarStore> {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(store, null, 2), "utf8");
  return store;
}

let radarWriteChain: Promise<unknown> = Promise.resolve();
function serialized<T>(run: () => Promise<T>): Promise<T> {
  const p = radarWriteChain.then(run, run);
  radarWriteChain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/**
 * Fold a scan's candidates in: NEW slugs are added as status "new"; known
 * slugs only refresh their listed MRR (status and verdict are operator truth
 * and never regress from a re-scan). Stamps lastScanAt.
 */
export function upsertScan(
  candidates: FlipCandidate[],
  verdicts: Map<string, FlipVerdict | null>,
  now: string,
): Promise<RadarStore> {
  return serialized(async () => {
    const store = await getRadar();
    const byId = new Map(store.entries.map((e) => [e.id, e]));
    for (const c of candidates) {
      const known = byId.get(c.id);
      if (known) {
        known.mrr = c.mrr;
        if (!known.verdict && verdicts.has(c.id)) {
          known.verdict = verdicts.get(c.id) ?? null;
        }
        known.updatedAt = now;
      } else {
        byId.set(c.id, {
          ...c,
          verdict: verdicts.get(c.id) ?? null,
          status: "new",
          seenAt: now,
          updatedAt: now,
        });
      }
    }
    // Newest-seen first, keep the radar bounded so the panel stays readable.
    const entries = [...byId.values()]
      .sort((a, b) => (a.seenAt < b.seenAt ? 1 : -1))
      .slice(0, 100);
    return saveRadar({ entries, lastScanAt: now });
  });
}

export function setStatus(
  id: string,
  status: FlipStatus,
  now: string,
): Promise<RadarStore | null> {
  return serialized(async () => {
    const store = await getRadar();
    const entry = store.entries.find((e) => e.id === id);
    if (!entry) return null;
    entry.status = status;
    entry.updatedAt = now;
    await saveRadar(store);
    return store;
  });
}
