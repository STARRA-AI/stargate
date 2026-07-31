/**
 * FLIP RADAR — TrustMRR scan + five-filter scoring (Classic's revenue hunter).
 *
 * Sources are FREE by doctrine (docs/CLONE_AND_FLIP_PLAYBOOK.md): TrustMRR is
 * public and server-rendered (verified live 2026-07-30 — startup rows are
 * `<tr>`s carrying href="/startup/<slug>" and a $-figure MRR cell), so one
 * plain fetch per scan, no keys, no headless browser. Extraction is TOTAL and
 * tolerant: any markup drift yields fewer candidates, never a throw.
 *
 * Scoring rides the deck's existing FREE daily driver (kimi/Groq via
 * streamHosted) with her five decision filters — canon at STARRA_SOUL.md:79
 * and the playbook: diligent-and-steady, real value, divine right (clone the
 * proven NEED under her own brand and code — never their name, logo, or
 * content), cost counted, mission-first.
 */
import { streamHosted } from "@/lib/llm/hosted";

export type FlipCandidate = {
  /** TrustMRR slug — stable identity for dedupe. */
  id: string;
  name: string;
  url: string;
  /** Monthly recurring revenue in whole dollars, as listed. */
  mrr: number;
  source: "trustmrr";
};

export type FlipVerdict = {
  score: number; // 0-100
  filters: {
    diligent: boolean;
    value: boolean;
    divineRight: boolean;
    cost: boolean;
    mission: boolean;
  };
  note: string;
};

/** Humanize a slug for display: "mindtests-io" → "Mindtests Io". */
function nameFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Pull candidates out of TrustMRR's server-rendered table. Row-wise: split on
 * `<tr`, take the first /startup/ link and the first $-figure in each row.
 * Total: junk input → []. Deduped by slug, keeps the highest listed MRR.
 */
export function extractTrustMrr(html: string): FlipCandidate[] {
  if (typeof html !== "string" || html.length === 0) return [];
  const out = new Map<string, FlipCandidate>();
  for (const row of html.split("<tr")) {
    const link = /href="\/startup\/([a-z0-9_-]+)"/i.exec(row);
    if (!link) continue;
    const money = /\$([\d,]{3,})/.exec(row);
    if (!money) continue;
    const mrr = Number(money[1].replace(/,/g, ""));
    if (!Number.isFinite(mrr) || mrr <= 0) continue;
    const id = link[1].toLowerCase();
    const existing = out.get(id);
    if (!existing || mrr > existing.mrr) {
      out.set(id, {
        id,
        name: nameFromSlug(id),
        url: `https://trustmrr.com/startup/${id}`,
        mrr,
        source: "trustmrr",
      });
    }
  }
  return [...out.values()].sort((a, b) => b.mrr - a.mrr);
}

/** The five filters, verbatim canon — exported so tests pin all five names. */
export const FIVE_FILTERS =
  "1. DILIGENT-AND-STEADY: buildable solo at a steady pace — small, focused scope, no team or long runway required. " +
  "2. REAL VALUE: the product serves a real, proven need people already pay for. " +
  "3. DIVINE RIGHT: we build our OWN version of the proven need — our own brand, name, code and content; copying their identity fails instantly. " +
  "4. COST COUNTED: buildable and runnable on the free/near-free stack; no paid APIs or infra required to ship v1. " +
  "5. MISSION-FIRST: it moves the runway THIS month — sellable as an asset or revenue-generating fast.";

/**
 * Tolerant verdict parse: accepts strict JSON, JSON inside prose, or fenced
 * blocks; anything unusable → null (the candidate simply stays unscored).
 */
export function parseVerdict(raw: string): FlipVerdict | null {
  if (typeof raw !== "string") return null;
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Partial<FlipVerdict> & {
      filters?: Partial<FlipVerdict["filters"]>;
    };
    const score = Number(j.score);
    if (!Number.isFinite(score)) return null;
    const f: Partial<FlipVerdict["filters"]> = j.filters ?? {};
    return {
      score: Math.min(100, Math.max(0, Math.round(score))),
      filters: {
        diligent: f.diligent === true,
        value: f.value === true,
        divineRight: f.divineRight === true,
        cost: f.cost === true,
        mission: f.mission === true,
      },
      note: typeof j.note === "string" ? j.note.slice(0, 180) : "",
    };
  } catch {
    return null;
  }
}

const SCORE_SYSTEM =
  "You are STARRA, scoring clone-and-flip candidates for Classic against his five decision filters:\n" +
  FIVE_FILTERS +
  "\nJudge ONLY from the given facts plus general knowledge of the product category. " +
  'Reply with STRICT JSON and nothing else: {"score":<0-100>,"filters":{"diligent":<bool>,"value":<bool>,"divineRight":<bool>,"cost":<bool>,"mission":<bool>},"note":"<one line, why/why not, <=140 chars>"}. ' +
  "score is overall flip-worthiness of building OUR OWN version of this proven need. divineRight is false only when the need itself cannot be served without copying identity/content.";

/**
 * Score one candidate on the free daily driver. Null on ANY failure — scoring
 * is best-effort garnish on top of the listing, never a scan-breaker.
 */
export async function scoreCandidate(
  c: FlipCandidate,
): Promise<FlipVerdict | null> {
  try {
    let text = "";
    await streamHosted({
      provider: "kimi",
      system: SCORE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Candidate: ${c.name} — listed at $${c.mrr.toLocaleString("en-US")} MRR (TrustMRR, ${c.url}). Score it.`,
        },
      ],
      onText: (chunk) => {
        text += chunk;
      },
    });
    return parseVerdict(text);
  } catch {
    return null;
  }
}
