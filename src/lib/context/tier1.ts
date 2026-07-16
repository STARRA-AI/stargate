import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";

export const GoalSchema = z.object({
  id: z.string(),
  horizon: z.enum(["quarterly", "monthly"]),
  text: z.string(),
});

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["active", "paused"]),
});

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  due: z.string().optional(),
  owner: z.string().default("Classic"),
  priority: z.enum(["high", "med", "low"]).default("med"),
  done: z.boolean().default(false),
});

export const DecisionSchema = z.object({
  id: z.string(),
  text: z.string(),
  why: z.string(),
  at: z.string(),
});

export const Tier1Schema = z.object({
  mrrLabel: z.string().default("—"),
  goals: z.array(GoalSchema).default([]),
  projects: z.array(ProjectSchema).default([]),
  tasks: z.array(TaskSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
});

export type Tier1Data = z.infer<typeof Tier1Schema>;

const DATA_PATH = path.join(process.cwd(), "data", "tier1.json");

const SEED: Tier1Data = {
  mrrLabel: "$0 (seed)",
  goals: [
    {
      id: "g1",
      horizon: "monthly",
      text: "Plus Ultra: 3 contractor customers by Day 14",
    },
    {
      id: "g2",
      horizon: "quarterly",
      text: "Business credit foundation — DUNS + 5–7 Net-30s, Paydex path",
    },
  ],
  projects: [
    { id: "p1", name: "Plus Ultra Presence", status: "active" },
    { id: "p2", name: "Silent Shadow Shorts", status: "active" },
    { id: "p3", name: "STARGATE PWA", status: "active" },
  ],
  tasks: [
    {
      id: "t1",
      title: "DUNS at dnb.com",
      due: "2026-07-16",
      owner: "Classic",
      priority: "high",
      done: false,
    },
    {
      id: "t2",
      title: "Net-30s: Uline, Quill, Grainger",
      due: "2026-07-16",
      owner: "Classic",
      priority: "high",
      done: false,
    },
    {
      id: "t3",
      title: "Silent Shadow Short — caption QA",
      due: "2026-07-15",
      owner: "Classic",
      priority: "med",
      done: false,
    },
  ],
  decisions: [
    {
      id: "d1",
      text: "Final STARGATE is the Next.js PWA; Flask desktop HUD frozen",
      why: "Ship installable phone+desktop bridge without rewriting locked web/",
      at: "2026-07-15",
    },
  ],
};

async function ensure() {
  try {
    await fs.access(DATA_PATH);
  } catch {
    await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
    await fs.writeFile(DATA_PATH, JSON.stringify(SEED, null, 2), "utf8");
  }
}

export async function getTier1(): Promise<Tier1Data> {
  await ensure();
  const raw = await fs.readFile(DATA_PATH, "utf8");
  return Tier1Schema.parse(JSON.parse(raw));
}

export async function saveTier1(data: Tier1Data): Promise<Tier1Data> {
  const parsed = Tier1Schema.parse(data);
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(parsed, null, 2), "utf8");
  return parsed;
}

export function serializeTier1(data: Tier1Data): string {
  const openTasks = data.tasks.filter((t) => !t.done);
  const active = data.projects.filter((p) => p.status === "active");
  return [
    "TIER-1 BUSINESS CONTEXT",
    `MRR readout: ${data.mrrLabel}`,
    `Goals: ${data.goals.map((g) => `[${g.horizon}] ${g.text}`).join(" | ") || "none"}`,
    `Active projects: ${active.map((p) => p.name).join(", ") || "none"}`,
    `Open tasks (${openTasks.length}): ${openTasks.map((t) => `${t.title}${t.due ? ` due ${t.due}` : ""} [${t.priority}]`).join("; ") || "none"}`,
    `Recent decisions: ${data.decisions
      .slice(0, 5)
      .map((d) => `${d.text} (${d.why})`)
      .join(" | ") || "none"}`,
  ].join("\n");
}
