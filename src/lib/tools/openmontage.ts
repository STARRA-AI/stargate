import { promises as fs } from "fs";
import path from "path";

const ROOT = process.cwd();
const VENDOR = path.join(ROOT, "vendor", "OpenMontage");
const JOBS = path.join(ROOT, "data", "openmontage-jobs.json");

export const MONTAGE_PIPELINES = [
  "silent-shadow-short",
  "book-of-starra",
  "atelier",
] as const;

export type MontagePipeline = (typeof MONTAGE_PIPELINES)[number];

export type MontageJob = {
  id: string;
  brief: string;
  pipeline: string;
  status: "queued" | "ready_for_agent" | "done" | "error";
  at: string;
  notes?: string;
  outputPath?: string;
  doneAt?: string;
};

export type MontageStatus = {
  present: boolean;
  path: string;
  hasVenv: boolean;
  hasRemotion: boolean;
  hasGuide: boolean;
  ready: boolean;
  readiness: "missing_vendor" | "needs_setup" | "ready";
  retiredPath: string;
  guide: string;
  nextStep: string;
  jobs: MontageJob[];
  pipelines: readonly string[];
};

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadJobs(): Promise<MontageJob[]> {
  try {
    const raw = await fs.readFile(JOBS, "utf8");
    return JSON.parse(raw) as MontageJob[];
  } catch {
    return [];
  }
}

async function saveJobs(jobs: MontageJob[]) {
  await fs.mkdir(path.dirname(JOBS), { recursive: true });
  await fs.writeFile(JOBS, JSON.stringify(jobs, null, 2), "utf8");
}

function readinessOf(input: {
  present: boolean;
  hasVenv: boolean;
  hasRemotion: boolean;
}): MontageStatus["readiness"] {
  if (!input.present) return "missing_vendor";
  if (!input.hasVenv || !input.hasRemotion) return "needs_setup";
  return "ready";
}

export async function getMontageStatus(): Promise<MontageStatus> {
  const present = await exists(path.join(VENDOR, "README.md"));
  const hasVenv = await exists(path.join(VENDOR, ".venv"));
  const hasRemotion = await exists(
    path.join(VENDOR, "remotion-composer", "node_modules"),
  );
  const hasGuide = await exists(path.join(VENDOR, "AGENT_GUIDE.md"));
  const readiness = readinessOf({ present, hasVenv, hasRemotion });
  const ready = readiness === "ready";
  const jobs = await loadJobs();

  let nextStep = "Run: npm run tools:bootstrap";
  if (present && !ready) {
    nextStep = "Run: npm run tools:montage-setup";
  } else if (ready) {
    nextStep =
      "Queue a brief, then open vendor/OpenMontage/AGENT_GUIDE.md and render.";
  }

  return {
    present,
    path: path.relative(ROOT, VENDOR),
    hasVenv,
    hasRemotion,
    hasGuide,
    ready,
    readiness,
    retiredPath: "Higgsfield — retired. OpenMontage is the only STARGATE video path.",
    guide: present
      ? "Open vendor/OpenMontage/AGENT_GUIDE.md in Cursor and paste the queued brief. Do not claim render finished until you mark the job done."
      : "Run: npm run tools:bootstrap",
    nextStep,
    jobs: jobs.slice(0, 20),
    pipelines: MONTAGE_PIPELINES,
  };
}

export async function queueMontageJob(input: {
  brief: string;
  pipeline?: string;
}): Promise<MontageJob> {
  const pipeline = (input.pipeline ?? "silent-shadow-short").trim();
  const jobs = await loadJobs();
  const job: MontageJob = {
    id: `om-${Date.now()}`,
    brief: input.brief.trim(),
    pipeline,
    status: "queued",
    at: new Date().toISOString(),
    notes:
      "Hand this brief to an agent with OpenMontage AGENT_GUIDE.md loaded. STARGATE does not auto-render. Higgsfield is not used.",
  };
  jobs.unshift(job);
  await saveJobs(jobs);

  const briefDir = path.join(ROOT, "data", "openmontage-briefs");
  await fs.mkdir(briefDir, { recursive: true });
  await fs.writeFile(
    path.join(briefDir, `${job.id}.md`),
    `# OpenMontage job ${job.id}

Pipeline: ${job.pipeline}
Queued: ${job.at}
Video path: OpenMontage (canonical). Higgsfield: retired — do not use.

## Brief

${job.brief}

## STARRA constraints

- Silent Shadow: pseudonymous; Storm Ink (indigo/charcoal/gold); 6 blocks × ~10s; caption QA mandatory.
- Book of Starra: tribal/mythology tone when requested.
- Integrity: no fake scarcity in CTAs; no income promises.
- Posting: human gate — do not auto-upload to social from STARGATE.

## Agent instructions

1. \`cd vendor/OpenMontage\`
2. Read \`AGENT_GUIDE.md\` first.
3. Execute the matching pipeline for this brief.
4. Mark job done in STARGATE Tools (or POST action=mark_done) when a real render exists.
`,
    "utf8",
  );

  job.status = "ready_for_agent";
  jobs[0] = job;
  await saveJobs(jobs);
  return job;
}

export async function markMontageJobDone(input: {
  id: string;
  outputPath?: string;
  error?: string;
}): Promise<MontageJob | null> {
  const jobs = await loadJobs();
  const idx = jobs.findIndex((j) => j.id === input.id);
  if (idx < 0) return null;
  const job = { ...jobs[idx] };
  if (input.error) {
    job.status = "error";
    job.notes = input.error;
  } else {
    job.status = "done";
    job.outputPath = input.outputPath?.trim() || job.outputPath;
    job.doneAt = new Date().toISOString();
    job.notes = job.outputPath
      ? `Render marked done: ${job.outputPath}`
      : "Render marked done (no output path recorded).";
  }
  jobs[idx] = job;
  await saveJobs(jobs);
  return job;
}

/** Seed a Silent Shadow–shaped default brief */
export function silentShadowTemplate(topic: string) {
  return `Make a 60-second Silent Shadow short about: ${topic}.
Style: Storm Ink — indigo/charcoal/gold, Anton captions, 2D flat, 6 blocks × ~10s.
Tone: Sage/Magician — curiosity, empathy, hope, belonging. No desperation hooks.
Output: vertical 9:16, caption QA with known-text .srt, no Whisper-hallucinated ambient captions.
Brand: Silent Shadow (pseudonymous). Do not reveal Classic Williams.
Studio: OpenMontage only. Higgsfield is retired.`;
}

export function bookOfStarraTemplate(topic: string) {
  return `Make a Book of Starra visual short about: ${topic}.
Tone: tribal, mythic, anticipation — not Silent Shadow's men's self-help voice.
Output: vertical 9:16, caption QA mandatory.
Studio: OpenMontage only. Higgsfield is retired.`;
}

export function briefForPipeline(pipeline: string, topic: string): string {
  if (pipeline === "book-of-starra") return bookOfStarraTemplate(topic);
  return silentShadowTemplate(topic);
}
