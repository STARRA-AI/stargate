import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";

export async function GET() {
  const root = process.cwd();
  const leaks = path.join(root, "docs/reference/system_prompts_leaks");
  const structureMd = path.join(root, "docs/reference/PROMPT_STRUCTURE.md");
  const structureTs = path.join(root, "src/lib/prompt-structure.ts");

  const present = await fs
    .access(path.join(leaks, "README.md"))
    .then(() => true)
    .catch(() => false);

  let structurePreview = "";
  try {
    structurePreview = (await fs.readFile(structureMd, "utf8")).slice(0, 3000);
  } catch {
    structurePreview = "Run: npm run tools:distill";
  }

  const distilled = await fs
    .access(structureTs)
    .then(() => true)
    .catch(() => false);

  return Response.json({
    present,
    path: "docs/reference/system_prompts_leaks",
    distilled,
    structurePath: "docs/reference/PROMPT_STRUCTURE.md",
    policy:
      "Structure only — STARRA operator voice is never replaced by leaked assistant tone.",
    structurePreview,
  });
}

export async function POST() {
  const { spawn } = await import("child_process");
  const root = process.cwd();

  const code = await new Promise<number>((resolve) => {
    const child = spawn("node", ["scripts/distill-prompt-patterns.mjs"], {
      cwd: root,
      stdio: "inherit",
    });
    child.on("close", (c) => resolve(c ?? 1));
  });

  if (code !== 0) {
    return Response.json({ ok: false, error: "distill failed" }, { status: 500 });
  }
  return Response.json({ ok: true, message: "STRUCTURE DISTILLED" });
}
