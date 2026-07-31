/**
 * MORNING BRIEFING — the sixty-second composer. Pulls every operational
 * surface Classic built into one spoken block she delivers at the top of a
 * briefing call: tasks due, Flip Radar, Silent Shadow queues, the funding
 * pipeline, and the newest durable facts.
 *
 * composeBrief is PURE (tested with synthetic stores); buildMorningBrief is
 * the server-side assembler, fail-open per section — a broken store costs its
 * one line, never the briefing.
 */
import { getTier1 } from "@/lib/context/tier1";
import { getRadar } from "@/lib/flipradar/store";
import { getFunding } from "@/lib/funding/store";
import { getMemory } from "@/lib/memory/store";
import { readAllQueues } from "@/lib/shadow";

export type BriefInputs = {
  tasksDue: string[];
  radar: { fresh: { name: string; mrr: number; score: number | null }[]; approved: number };
  shadow: { ready: number; uploaded: number; failed: number };
  funding: { prequal: number; applied: number; next: string[] };
  facts: string[];
};

/** Pure: inputs → the spoken block. Sections self-omit when empty; the whole
 *  brief stays under ~1400 chars so it rides instructions comfortably. */
export function composeBrief(b: BriefInputs): string {
  const lines: string[] = ["MORNING BRIEF (deliver conversationally, ~60 seconds, then ask what he wants run):"];
  if (b.tasksDue.length > 0) {
    lines.push(`Tasks due: ${b.tasksDue.slice(0, 3).join("; ")}.`);
  }
  if (b.radar.fresh.length > 0) {
    const top = b.radar.fresh[0];
    lines.push(
      `Flip Radar: ${b.radar.fresh.length} new candidate${b.radar.fresh.length === 1 ? "" : "s"} — top is ${top.name} at $${top.mrr.toLocaleString("en-US")}/mo${top.score !== null ? ` (score ${top.score})` : ""}. ${b.radar.approved} in the build pipeline.`,
    );
  } else if (b.radar.approved > 0) {
    lines.push(`Flip Radar: nothing new; ${b.radar.approved} in the build pipeline.`);
  }
  if (b.shadow.ready + b.shadow.failed > 0) {
    lines.push(
      `Silent Shadow: ${b.shadow.ready} ready to publish${b.shadow.failed > 0 ? `, ${b.shadow.failed} FAILED uploads need eyes` : ""}. ${b.shadow.uploaded} up.`,
    );
  }
  if (b.funding.prequal + b.funding.applied > 0 || b.funding.next.length > 0) {
    const next = b.funding.next.slice(0, 2).join("; ");
    lines.push(
      `Funding: ${b.funding.applied} applied, ${b.funding.prequal} in prequal${next ? ` — next: ${next}` : ""}.`,
    );
  }
  if (b.facts.length > 0) {
    lines.push(`Carry-over worth remembering: ${b.facts.slice(0, 3).join("; ")}.`);
  }
  if (lines.length === 1) {
    lines.push("Quiet board: no tasks due, no new candidates, queues clear. Ask him what today is for.");
  }
  return lines.join("\n").slice(0, 1400);
}

/** Server assembler — every section fail-open. */
export async function buildMorningBrief(): Promise<string> {
  const [tier1, radar, funding, memory, shadow] = await Promise.all([
    getTier1().catch(() => null),
    getRadar().catch(() => null),
    getFunding().catch(() => null),
    getMemory().catch(() => null),
    readAllQueues().catch(() => null),
  ]);
  return composeBrief({
    tasksDue:
      tier1?.tasks?.filter((t) => !t.done).map((t) => t.title ?? String(t)) ?? [],
    radar: {
      fresh:
        radar?.entries
          .filter((e) => e.status === "new")
          .map((e) => ({ name: e.name, mrr: e.mrr, score: e.verdict?.score ?? null })) ?? [],
      approved:
        radar?.entries.filter((e) => e.status === "approved" || e.status === "building")
          .length ?? 0,
    },
    shadow: {
      ready: shadow?.ready.count ?? 0,
      uploaded: shadow?.uploaded.count ?? 0,
      failed: shadow?.failed.count ?? 0,
    },
    funding: {
      prequal: funding?.leads.filter((l) => l.status === "prequal").length ?? 0,
      applied: funding?.leads.filter((l) => l.status === "applied").length ?? 0,
      next:
        funding?.leads
          .filter((l) => l.status === "prequal" || l.status === "applied")
          .map((l) => l.institution) ?? [],
    },
    facts: memory ? [...memory.facts].slice(-3).reverse().map((f) => f.text) : [],
  });
}
