/**
 * SILENT SHADOW queue reader — shared by the deck panel route and the morning
 * briefing composer. Read-only over the launch folder's queue dirs; fail-open:
 * a missing folder is zero, never a throw. No user input ever reaches paths.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SHADOW_BASE =
  process.env.STARRA_SHADOW_DIR ||
  path.join(os.homedir(), "STARGATE", "silent shadow launch");

export const SHADOW_QUEUES = {
  ready: "ready_to_publish",
  uploaded: "uploaded",
  failed: "upload_failed",
} as const;

export type QueueReport = { count: number; files: { name: string; at: string }[] };

export async function readQueue(dir: string): Promise<QueueReport> {
  try {
    const entries = await fs.readdir(path.join(SHADOW_BASE, dir));
    const visible = entries.filter((f) => !f.startsWith("."));
    const files: { name: string; at: string }[] = [];
    for (const name of visible.slice(0, 10)) {
      try {
        const st = await fs.stat(path.join(SHADOW_BASE, dir, name));
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

export async function readAllQueues(): Promise<{
  ready: QueueReport;
  uploaded: QueueReport;
  failed: QueueReport;
}> {
  const [ready, uploaded, failed] = await Promise.all([
    readQueue(SHADOW_QUEUES.ready),
    readQueue(SHADOW_QUEUES.uploaded),
    readQueue(SHADOW_QUEUES.failed),
  ]);
  return { ready, uploaded, failed };
}
