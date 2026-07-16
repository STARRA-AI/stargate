import { readFileSync } from "fs";
import path from "path";
import { structureBlock } from "@/lib/prompt-structure";
import { fableReasoningBlock } from "@/lib/fable-reasoning";

const OPERATOR_RULES = `
VOICE & TONE (non-negotiable):
You are STARRA, the operator behind STARGATE. Calm. Low. Decisive. Dry.
Say "Copy." not "Sure!". Never "I'd be happy to help", "Great question", or "let me know if you need anything else".
Never apologize for being an AI. Never use emoji. Never use the operator's name more than once per session.
Lead with the next move. Prefer short sentences.
`.trim();

/** Brain knowledge base — hard rules / ops context. */
const BRAIN_CHAR_BUDGET = 8000;

/**
 * Soul spiritual OS. Prefer full file; if over budget, keep Part IV + V and
 * laws intact — trim builder anecdotes (Part III) first, then scripture detail.
 */
const SOUL_CHAR_BUDGET = 10000;

const SOUL_PREAMBLE = `STARRA_SOUL — spiritual operating system.
Governs how STARRA thinks and speaks about money, work, and outcomes.
Does not override hard rules in STARRA_BRAIN.`;

export type CanonLoadStatus = {
  loaded: boolean;
  chars: number;
  budget: number;
  truncated: boolean;
};

function clipAtBudget(raw: string, budget: number): { text: string; truncated: boolean } {
  if (raw.length <= budget) return { text: raw, truncated: false };
  return { text: raw.slice(0, budget) + "\n…[truncated]", truncated: true };
}

/** Split markdown on ## headings; keep heading line with its body. */
function splitMarkdownSections(raw: string): { title: string; body: string }[] {
  const lines = raw.split("\n");
  const sections: { title: string; body: string }[] = [];
  let title = "";
  let buf: string[] = [];

  const flush = () => {
    if (!title && buf.length === 0) return;
    sections.push({ title, body: buf.join("\n") });
    buf = [];
  };

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      flush();
      title = line.replace(/^##\s+/, "").trim();
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

function sectionMatches(title: string, ...needles: string[]): boolean {
  const t = title.toLowerCase();
  return needles.some((n) => t.includes(n.toLowerCase()));
}

/**
 * Priority pack when soul exceeds budget:
 * Identity → Part IV → Part V → Part I (laws) → Part II → Part III (anecdotes last).
 */
export function prioritizeSoul(raw: string, budget: number): {
  text: string;
  truncated: boolean;
} {
  if (raw.length <= budget) return { text: raw, truncated: false };

  const sections = splitMarkdownSections(raw);
  const pick = (...needles: string[]) =>
    sections.find((s) => sectionMatches(s.title, ...needles))?.body ?? "";

  const preamble =
    sections.find((s) => !s.title || sectionMatches(s.title, "STARRA_SOUL"))
      ?.body ?? "";
  // Title-less leading block is usually the H1 + blockquote before first ##
  const leading = sections[0] && !sections[0].title ? sections[0].body : preamble;

  const identity = pick("Identity");
  const partIv = pick("Part IV", "Operating Protocol");
  const partV = pick("Part V", "Affirmation");
  const partI = pick("Part I", "Seven Laws");
  const partIi = pick("Part II", "Biblical");
  const partIii = pick("Part III", "Builders");

  const ordered = [leading, identity, partIv, partV, partI, partIi, partIii].filter(
    Boolean,
  );

  let out = "";
  let truncated = false;
  for (const block of ordered) {
    const next = out ? `${out}\n\n${block}` : block;
    if (next.length <= budget) {
      out = next;
      continue;
    }
    // Never drop Part IV / V mid-stream if they already fit; skip lower-priority blocks.
    // If a critical block itself overflows remaining space, keep as much as fits
    // but only after IV/V/laws are already in (they appear earlier in ordered).
    const remaining = budget - out.length - (out ? 2 : 0);
    if (remaining > 200) {
      out = out
        ? `${out}\n\n${block.slice(0, remaining - 14)}\n…[truncated]`
        : `${block.slice(0, budget - 14)}\n…[truncated]`;
    }
    truncated = true;
    break;
  }

  if (!out) {
    return clipAtBudget(raw, budget);
  }
  if (!truncated && out.length < raw.length) truncated = true;
  return { text: out, truncated };
}

/** Cache static canon — rebuildSystemPrompt was re-reading disk every chat token path. */
let brainCache: string | null = null;
let soulCache: string | null = null;

export function loadBrain(): string {
  if (brainCache) return brainCache;
  try {
    const p = path.join(process.cwd(), "STARRA_BRAIN.md");
    const raw = readFileSync(p, "utf8");
    const { text } = clipAtBudget(raw, BRAIN_CHAR_BUDGET);
    brainCache = `${text}\n\n${OPERATOR_RULES}`;
    return brainCache;
  } catch {
    return `STARRA operator brain unavailable offline.\n\n${OPERATOR_RULES}`;
  }
}

export function loadSoul(): string {
  if (soulCache) return soulCache;
  try {
    const p = path.join(process.cwd(), "STARRA_SOUL.md");
    const raw = readFileSync(p, "utf8");
    const { text } = prioritizeSoul(raw, SOUL_CHAR_BUDGET);
    soulCache = `${SOUL_PREAMBLE}\n\n${text}`;
    return soulCache;
  } catch {
    return `${SOUL_PREAMBLE}\n\nSoul file unavailable offline — operate from brain hard rules only.`;
  }
}

/** Test/dev helper — clear canon caches after file edits. */
export function clearCanonCache() {
  brainCache = null;
  soulCache = null;
}

export function brainStatus(): CanonLoadStatus {
  try {
    const raw = readFileSync(path.join(process.cwd(), "STARRA_BRAIN.md"), "utf8");
    return {
      loaded: true,
      chars: Math.min(raw.length, BRAIN_CHAR_BUDGET),
      budget: BRAIN_CHAR_BUDGET,
      truncated: raw.length > BRAIN_CHAR_BUDGET,
    };
  } catch {
    return { loaded: false, chars: 0, budget: BRAIN_CHAR_BUDGET, truncated: false };
  }
}

export function soulStatus(): CanonLoadStatus {
  try {
    const raw = readFileSync(path.join(process.cwd(), "STARRA_SOUL.md"), "utf8");
    const { text, truncated } = prioritizeSoul(raw, SOUL_CHAR_BUDGET);
    return {
      loaded: true,
      chars: text.length,
      budget: SOUL_CHAR_BUDGET,
      truncated,
    };
  } catch {
    return { loaded: false, chars: 0, budget: SOUL_CHAR_BUDGET, truncated: false };
  }
}

export function buildSystemPrompt(extras: string[] = []): string {
  const t0 = Date.now();
  const soul = loadSoul();
  const brain = loadBrain();
  const parts = [
    structureBlock(),
    fableReasoningBlock(),
    soul,
    brain,
    ...extras.filter(Boolean),
  ];
  const out = parts.join("\n\n---\n\n");
  // #region agent log
  fetch("http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "f8c9f7",
    },
    body: JSON.stringify({
      sessionId: "f8c9f7",
      location: "brain.ts:buildSystemPrompt",
      message: "system prompt assembled",
      data: {
        totalChars: out.length,
        soulChars: soul.length,
        brainChars: brain.length,
        hasSoulPreamble: soul.includes("STARRA_SOUL"),
        hasCopyRule: out.includes('Say "Copy."'),
        extrasCount: extras.filter(Boolean).length,
        assembleMs: Date.now() - t0,
      },
      timestamp: Date.now(),
      hypothesisId: "H-C1",
      runId: "post-fix",
    }),
  }).catch(() => {});
  // #endregion
  return out;
}
