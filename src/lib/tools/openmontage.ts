import { promises as fs } from "fs";
import path from "path";

const ROOT = process.cwd();
const VENDOR = path.join(ROOT, "vendor", "OpenMontage");
const JOBS = path.join(ROOT, "data", "openmontage-jobs.json");

export type MontageJob = {
  id: string;
  brief: string;
  pipeline: string;
  status: "queued" | "ready_for_agent" | "done" | "error";
  at: string;
  notes?: string;
};

export type MontageStatus = {
  present: boolean;
  path: string;
  hasVenv: boolean;
  hasRemotion: boolean;
  guide: string;
  jobs: MontageJob[];
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

export async function getMontageStatus(): Promise<MontageStatus> {
  const present = await exists(path.join(VENDOR, "README.md"));
  const hasVenv = await exists(path.join(VENDOR, ".venv"));
  const hasRemotion = await exists(
    path.join(VENDOR, "remotion-composer", "node_modules"),
  );
  const jobs = await loadJobs();
  return {
    present,
    path: path.relative(ROOT, VENDOR),
    hasVenv,
    hasRemotion,
    guide: present
      ? "Open vendor/OpenMontage/AGENT_GUIDE.md in Cursor and paste the queued brief."
      : "Run: npm run tools:bootstrap",
    jobs: jobs.slice(0, 20),
  };
}

export async function queueMontageJob(input: {
  brief: string;
  pipeline?: string;
}): Promise<MontageJob> {
  const jobs = await loadJobs();
  const job: MontageJob = {
    id: `om-${Date.now()}`,
    brief: input.brief.trim(),
    pipeline: input.pipeline ?? "silent-shadow-short",
    status: "queued",
    at: new Date().toISOString(),
    notes:
      "Hand this brief to an agent with OpenMontage AGENT_GUIDE.md loaded. STARGATE does not auto-render.",
  };
  jobs.unshift(job);
  await saveJobs(jobs);

  // Also write a human-readable brief for the agent
  const briefDir = path.join(ROOT, "data", "openmontage-briefs");
  await fs.mkdir(briefDir, { recursive: true });
  await fs.writeFile(
    path.join(briefDir, `${job.id}.md`),
    `# OpenMontage job ${job.id}

Pipeline: ${job.pipeline}
Queued: ${job.at}

## Brief

${job.brief}

## STARRA constraints

- Silent Shadow: pseudonymous; Storm Ink (indigo/charcoal/gold); 6 blocks × ~10s; caption QA mandatory.
- Book of Starra: tribal/mythology tone when requested.
- Integrity: no fake scarcity in CTAs; no income promises.

## Agent instructions

1. \`cd vendor/OpenMontage\`
2. Read \`AGENT_GUIDE.md\` first.
3. Execute the matching pipeline for this brief.
4. Mark job done in STARGATE Tools when render exists.
`,
    "utf8",
  );

  job.status = "ready_for_agent";
  jobs[0] = job;
  await saveJobs(jobs);
  return job;
}

/** Seed a Silent Shadow–shaped default brief */
export function silentShadowTemplate(topic: string) {
  return `Make a 60-second Silent Shadow short about: ${topic}.
Style: Storm Ink — indigo/charcoal/gold, Anton captions, 2D flat, 6 blocks × ~10s.
Tone: Sage/Magician — curiosity, empathy, hope, belonging. No desperation hooks.
Output: vertical 9:16, caption QA with known-text .srt, no Whisper-hallucinated ambient captions.
Brand: Silent Shadow (pseudonymous). Do not reveal Classic Williams.`;
}
