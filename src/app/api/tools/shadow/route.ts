import { readAllQueues } from "@/lib/shadow";
import { pushFeed } from "@/lib/feed";

/**
 * SILENT SHADOW queue visibility — the content engine's pipeline folders,
 * surfaced on the deck. Read-only via lib/shadow (fixed queue names, fail-open
 * to zeros, env-overridable base OUTSIDE the repo: "silent shadow launch"),
 * behind the default /api/* auth gate: ready_to_publish / uploaded /
 * upload_failed each report { count, files }.
 *
 * Failures push one feed line per NEW failed file (tracked in-process) so the
 * deck's feed narrates the content engine without polling spam.
 */

export const runtime = "nodejs";

/** In-process memory of failures already narrated — one feed line each. */
const narratedFailures = new Set<string>();

export async function GET() {
  const report = await readAllQueues();
  for (const f of report.failed.files) {
    if (!narratedFailures.has(f.name)) {
      narratedFailures.add(f.name);
      try {
        pushFeed("SHDW", `Upload failed · ${f.name.slice(0, 60)}`);
      } catch {
        /* feed is garnish */
      }
    }
  }
  return Response.json(report);
}
