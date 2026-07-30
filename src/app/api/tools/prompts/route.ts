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

  // Resolve the distill script by READING the scripts dir at runtime, so there is
  // no static .mjs path literal anywhere for Turbopack's asset tracer to fold and
  // try to resolve as a server-relative module — that produced "Module not found:
  // Can't resolve './ROOT/scripts/distill-prompt-patterns.mjs'" at build time.
  // It's spawned (not imported), so the real file on disk is still found.
  const scriptsDir = path.join(root, "scripts");
  const entries = await fs.readdir(scriptsDir).catch(() => [] as string[]);
  const scriptName = entries.find(
    (f) => f.startsWith("distill-prompt-patterns") && f.endsWith(".mjs"),
  );
  if (!scriptName) {
    return Response.json(
      { ok: false, error: "distill script not found in scripts/" },
      { status: 500 },
    );
  }
  const script = path.join(scriptsDir, scriptName);
  const code = await new Promise<number>((resolve) => {
    const child = spawn("node", [script], {
      cwd: root,
      stdio: "inherit",
    });
    // No 'error' listener → a spawn failure (node missing / ENOENT) throws an
    // uncaught exception and 500s the route; resolve it as a failed exit code so
    // the handler returns { ok:false, error } instead of crashing.
    child.on("error", () => resolve(1));
    child.on("close", (c) => resolve(c ?? 1));
  });

  if (code !== 0) {
    return Response.json({ ok: false, error: "distill failed" }, { status: 500 });
  }
  return Response.json({ ok: true, message: "STRUCTURE DISTILLED" });
}
