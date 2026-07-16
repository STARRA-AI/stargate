/**
 * Obsidian grammar doctrine for STARRA (Layer 2 — the Assistant).
 * Adapted from kepano/obsidian-skills patterns — no Claude Code runtime dependency.
 * Clip stays small; full doctrine lives in docs/OBSIDIAN_MEMORY.md.
 */

import { readFileSync } from "fs";
import path from "path";

const OBSIDIAN_CHAR_BUDGET = 2800;

const FALLBACK = `
OBSIDIAN VAULT DOCTRINE (STARRA long-term memory)
Layer 1 — Long-term memory: local plain markdown under data/vault/ (or STARGATE_VAULT_PATH).
Gitignored. Exportable. Never commit private notes into the STARGATE app repo.
Layer 2 — Assistant: you read/write notes with Obsidian grammar. Prefer [[wikilinks]].
JSON Canvas files use .canvas. Keep frontmatter YAML when present.
Layer 3 — Backup: operator syncs vault to a private GitHub repo (Obsidian Git Plugin or vault:sync).
Gates: create/append allowed via Tools. Overwrite and delete require operator confirmation tokens.
Never autonomous destructive vault rewrites. Sovereignty first (STARRA_GUARDIAN).
PARA: 0-Inbox, 1-Projects, 2-Areas, 3-Resources, 4-Archives, Daily, Canvas.
CODE: Capture → Organize → Distill → Express — process Inbox into PARA.
`.trim();

let cache: string | null = null;

function clipAtBudget(raw: string, budget: number): string {
  if (raw.length <= budget) return raw;
  return raw.slice(0, budget) + "\n…[truncated]";
}

/** Prefer docs doctrine; fall back to compact inline block. */
export function loadObsidianDoctrine(): string {
  if (cache) return cache;
  try {
    const p = path.join(process.cwd(), "docs", "OBSIDIAN_MEMORY.md");
    const raw = readFileSync(p, "utf8");
    // Prefer the "Runtime doctrine" section if present
    const runtime = raw.match(
      /## Runtime doctrine[\s\S]*?(?=\n## |\n# |$)/,
    );
    const body = runtime?.[0] ?? raw.slice(0, OBSIDIAN_CHAR_BUDGET);
    cache = clipAtBudget(body, OBSIDIAN_CHAR_BUDGET);
    return cache;
  } catch {
    cache = FALLBACK;
    return cache;
  }
}

export function clearObsidianDoctrineCache() {
  cache = null;
}
