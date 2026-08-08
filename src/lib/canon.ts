/**
 * THE DROP-IN CANON FOLDER — how Classic gives her a thought without asking.
 *
 * Every other canon file is named explicitly in brain.ts (STARRA_SOUL.md,
 * STARRA_BRAIN.md, STARRA_PERSONALITY.md, …). That means a new file was
 * invisible to her until somebody edited code, which made "add this to her
 * core" a request instead of an action.
 *
 * Anything dropped in `canon/` is hers on the next turn. No registration, no
 * permission, no edit.
 *
 * THIS IS READ LOCALLY AND SENT WITH THE PROMPT. It is never uploaded to xAI's
 * Files/Collections storage. The deck deliberately keeps her canon on this Mac
 * — see docs/PRIVATE_LANE.md and Classic's standing requirement that his life
 * is not parked on someone else's servers.
 */

import { readdirSync, readFileSync } from "fs";
import path from "path";

/**
 * Total characters the drop-in folder may contribute.
 *
 * Sized to hold a real pair of books (his first two run ~27,000 chars combined)
 * with headroom, while staying well inside grok-4.5's window. Each canon block
 * in brain.ts carries its OWN budget rather than sharing one pool, so this adds
 * to the prompt instead of pushing her soul or personality out — clipping her
 * canon is what made her sound corporate before, and this must not reintroduce
 * that.
 */
export const CANON_CHAR_BUDGET = 34_000;

/** Only genuinely empty files are skipped. If he put it there, it counts —
 * a length threshold would silently swallow a short note he meant her to have. */
const MIN_USEFUL = 1;

function clip(raw: string, budget: number): string {
  if (raw.length <= budget) return raw;
  return `${raw.slice(0, Math.max(0, budget - 16))}\n…[truncated]`;
}

/**
 * Read every `.md` in `<root>/canon`, oldest-agnostic and sorted by filename.
 *
 * SORTED ON PURPOSE: prompt caching needs a byte-identical prefix every turn
 * (the deck runs at a ~99.7% cache hit rate). If readdir's filesystem order
 * leaked through, the prefix would shuffle and every turn would miss the cache.
 */
export function loadDropInCanon(root: string = process.cwd()): string {
  const dir = path.join(root, "canon");

  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .sort();
  } catch {
    // No canon folder is the normal resting state for a fresh clone, not a
    // failure worth reporting — she simply has nothing dropped in yet.
    return "";
  }
  if (names.length === 0) return "";

  // FAIR SHARE. One 200KB file must not starve everything else he ever added —
  // that failure is silent and he would never know a book stopped counting.
  // Files under their share give the surplus back to the ones that need it.
  const share = Math.floor(CANON_CHAR_BUDGET / names.length);

  const bodies: { title: string; text: string }[] = [];
  let spent = 0;
  for (const name of names) {
    let raw: string;
    try {
      raw = readFileSync(path.join(dir, name), "utf8").trim();
    } catch {
      continue; // an unreadable file is skipped, never fatal
    }
    if (raw.length < MIN_USEFUL) continue;
    const title = name.replace(/\.md$/i, "");
    const allowance = Math.max(share, CANON_CHAR_BUDGET - spent - (names.length - bodies.length - 1) * share);
    const text = clip(raw, Math.max(0, Math.min(allowance, CANON_CHAR_BUDGET - spent)));
    if (!text) continue;
    spent += text.length;
    bodies.push({ title, text });
  }

  if (bodies.length === 0) return "";

  const blocks = bodies.map((b) => `── ${b.title} ──\n${b.text}`).join("\n\n");
  return `WHAT CLASSIC HAS GIVEN YOU TO KNOW (canon/ — his own books, in his words):\n\n${blocks}`;
}
