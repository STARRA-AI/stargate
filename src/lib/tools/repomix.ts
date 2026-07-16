import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "data", "packs", "stargate-repomix.xml");

export type RepomixResult = {
  ok: boolean;
  outputPath: string;
  bytes: number;
  preview: string;
  error?: string;
};

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function runRepomix(targetDir?: string): Promise<RepomixResult> {
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  const cwd = targetDir ? path.resolve(ROOT, targetDir) : ROOT;

  const localBin = path.join(ROOT, "node_modules", ".bin", "repomix");
  const useLocal = await fs
    .access(localBin)
    .then(() => true)
    .catch(() => false);

  const result = useLocal
    ? await run(localBin, ["--config", path.join(ROOT, "repomix.config.json")], cwd)
    : await run("npx", ["--yes", "repomix@latest", "--config", path.join(ROOT, "repomix.config.json")], cwd);

  if (result.code !== 0) {
    return {
      ok: false,
      outputPath: OUT,
      bytes: 0,
      preview: "",
      error: (result.stderr || result.stdout || "repomix failed").slice(0, 800),
    };
  }

  try {
    const buf = await fs.readFile(OUT);
    const text = buf.toString("utf8");
    return {
      ok: true,
      outputPath: path.relative(ROOT, OUT),
      bytes: buf.length,
      preview: text.slice(0, 4000),
    };
  } catch (e) {
    return {
      ok: false,
      outputPath: OUT,
      bytes: 0,
      preview: "",
      error: e instanceof Error ? e.message : "output missing",
    };
  }
}

export async function readLatestPackPreview(max = 6000): Promise<string | null> {
  try {
    const text = await fs.readFile(OUT, "utf8");
    return text.slice(0, max);
  } catch {
    return null;
  }
}
