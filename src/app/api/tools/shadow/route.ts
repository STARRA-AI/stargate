import { promises as fs } from "node:fs";
import path from "node:path";
import { pushFeed } from "@/lib/feed";

/**
 * SILENT SHADOW queue visibility — the content engine's pipeline folders,
 * surfaced on the deck. Read-only over the queue dirs that already exist at
 * the launch folder (outside the repo; env-overridable), behind the default
 * /api/* auth gate. Fail-open everywhere: a missing folder reads as zero,
 * never an error — the panel must render on any machine.
 *
 *   GET → { ready, uploaded, failed } each { count, files: [{name, at}] }
 *
 * Failures push one feed line per NEW failed file (tracked in-process) so the
 * deck's feed narrates the content engine without polling spam.
 */

export const runtime = "nodejs";

const BASE =
  process.env.STARRA_SHADOW_DIR ||
  "/Users/work/Desktop/STARGATE/silent shadow launch";

const QUEUES = {
  ready: "ready_to_publish",
  uploaded: "uploaded",
  failed: "upload_failed",
} as const;

type QueueReport = { count: number; files: { name: string; at: string }[] };

async function readQueue(dir: string): Promise<QueueReport> {
  try {
    const entries = await fs.readdir(path.join(BASE, dir));
    const visible = entries.filter((f) => !f.startsWith("."));
    const files: { name: string; at: string }[] = [];
    for (const name of visible.slice(0, 10)) {
      try {
        const st = await fs.stat(path.join(BASE, dir, name));
        files.push({ name, at: st.mtime.toISOString() });
      } catch {
        files.push({ name, at: "" });
      }
    }
    files.sort((a, b) => (a.at < b.at ? 1 : -1));
    return { count: visible.length, files };
  } catch {
    return { count: 0, files: [] };
  }
}

/** In-process memory of failures already narrated — one feed line each. */
const narratedFailures = new Set<string>();

export async function GET() {
  const [ready, uploaded, failed] = await Promise.all([
    readQueue(QUEUES.ready),
    readQueue(QUEUES.uploaded),
    readQueue(QUEUES.failed),
  ]);
  for (const f of failed.files) {
    if (!narratedFailures.has(f.name)) {
      narratedFailures.add(f.name);
      try {
        pushFeed("SHDW", `Upload failed · ${f.name.slice(0, 60)}`);
      } catch {
        /* feed is garnish */
      }
    }
  }
  return Response.json({ ready, uploaded, failed });
}
