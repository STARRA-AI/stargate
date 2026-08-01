import fs from "node:fs";
import path from "node:path";

/**
 * Staged Instagram posts (G9). Staging is local-only and always available;
 * publishing is a separate, approval-gated act that requires linked Meta
 * credentials. The /approve route is the ONLY code path permitted to call
 * graph.facebook.com — and it refuses while unlinked.
 */

export type StagedPost = {
  id: string;
  caption: string;
  mediaPath: string;
  stagedAt: string;
  status: "staged" | "published" | "rejected";
};

const STORE = path.join(process.cwd(), "data", "instagram-staged.json");

export function readStaged(): StagedPost[] {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, "utf8")) as { staged?: StagedPost[] };
    return raw.staged ?? [];
  } catch {
    return [];
  }
}

export function writeStaged(staged: StagedPost[]): void {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify({ staged }, null, 2));
}
