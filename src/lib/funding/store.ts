/**
 * FUNDING TRACKER — the backyard-banks playbook as live pipeline state.
 *
 * Every row in docs/BACKYARD_BANKS_AND_SOFT_PULL_FUNDING.md is a LEAD to
 * verify, not a fact (the doc says so itself) — so the tracker's job is
 * moving each lead through: lead → prequal → applied → funded (or dead).
 *
 * SELF-SEEDING: data/funding.json is created on first read by parsing the
 * doc's markdown tables — no manual seed step. The parser is pure/total and
 * exported for tests; the doc remains the read-only source, the JSON is the
 * working state (data/ is gitignored). Writes share the serialized-chain
 * discipline of the other stores.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export type FundingStatus = "lead" | "prequal" | "applied" | "funded" | "dead";

export type FundingLead = {
  id: string;
  institution: string;
  intel: string;
  status: FundingStatus;
  updatedAt: string;
};

export type FundingStore = { leads: FundingLead[]; seededAt: string | null };

const DATA_PATH = path.join(process.cwd(), "data", "funding.json");
const DOC_PATH = path.join(
  process.cwd(),
  "docs",
  "BACKYARD_BANKS_AND_SOFT_PULL_FUNDING.md",
);

/** Slugify an institution name into a stable id. */
function idFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Pull leads out of the playbook's markdown tables. A lead row is any table
 * row whose first cell is bold (`| **Name** | ...`). Total: junk → [].
 */
export function parseFundingDoc(md: string): { institution: string; intel: string }[] {
  if (typeof md !== "string") return [];
  const out: { institution: string; intel: string }[] = [];
  const seen = new Set<string>();
  for (const line of md.split("\n")) {
    const m = /^\|\s*\*\*(.+?)\*\*\s*\|(.+)\|\s*$/.exec(line.trim());
    if (!m) continue;
    const institution = m[1].trim();
    if (!institution || seen.has(institution)) continue;
    seen.add(institution);
    const intel = m[2]
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean)
      .join(" · ")
      .slice(0, 240);
    out.push({ institution, intel });
  }
  return out;
}

async function seed(): Promise<FundingStore> {
  let rows: { institution: string; intel: string }[] = [];
  try {
    rows = parseFundingDoc(await fs.readFile(DOC_PATH, "utf8"));
  } catch {
    /* doc absent on this machine — empty tracker, still functional */
  }
  const now = new Date().toISOString();
  return {
    leads: rows.map((r) => ({
      id: idFor(r.institution),
      institution: r.institution,
      intel: r.intel,
      status: "lead" as const,
      updatedAt: now,
    })),
    seededAt: now,
  };
}

let fundingWriteChain: Promise<unknown> = Promise.resolve();
function serialized<T>(run: () => Promise<T>): Promise<T> {
  const p = fundingWriteChain.then(run, run);
  fundingWriteChain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

async function save(store: FundingStore): Promise<FundingStore> {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(store, null, 2), "utf8");
  return store;
}

export async function getFunding(): Promise<FundingStore> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(DATA_PATH, "utf8"),
    ) as Partial<FundingStore>;
    if (Array.isArray(parsed.leads)) {
      return {
        leads: parsed.leads,
        seededAt: typeof parsed.seededAt === "string" ? parsed.seededAt : null,
      };
    }
  } catch {
    /* fall through to seeding */
  }
  return serialized(async () => save(await seed()));
}

const VALID: FundingStatus[] = ["lead", "prequal", "applied", "funded", "dead"];

export function setLeadStatus(
  id: string,
  status: FundingStatus,
  now: string,
): Promise<FundingStore | null> {
  if (!VALID.includes(status)) return Promise.resolve(null);
  return serialized(async () => {
    const store = await getFunding();
    const lead = store.leads.find((l) => l.id === id);
    if (!lead) return null;
    lead.status = status;
    lead.updatedAt = now;
    await save(store);
    return store;
  });
}
