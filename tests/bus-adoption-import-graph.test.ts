/**
 * BUS ADOPTION — SECRET DISCIPLINE, enforced on the IMPORT GRAPH.
 *
 * Adoption added `import … from "@/lib/engine/bus"` to four CLIENT modules (her
 * TTS path, the realtime call hook, the call overlay, her face). Anything a client
 * component can reach is public: it is compiled into a bundle a browser downloads.
 * So the one thing that could turn this wiring into a credential leak is an import
 * EDGE — bus.ts (or anything else on these four graphs) pulling in a module that
 * resolves secrets.
 *
 * This test walks the real graph from each adopted file and proves two things:
 *   1. NO PATH reaches a secret-bearing engine module (config / providers / router
 *      / health / the barrel index). Those resolve keyOverride → process.env.
 *   2. NO reachable module reads a non-NEXT_PUBLIC_ env var. NEXT_PUBLIC_* is
 *      public by definition and inlined at build time; anything else in a client
 *      graph is either dead weight or a leak.
 *
 * A comment ("this module is client-safe") cannot fail. This can.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const SRC = join(REPO, "src");

/** The four files this division adopted the bus into. */
const ADOPTED = [
  "src/lib/voice/speak.ts",
  "src/lib/voice/useVoiceCall.ts",
  "src/components/bridge/VoiceCallOverlay.tsx",
  "src/components/bridge/StarraClipFace.tsx",
];

/** Modules that resolve credentials. None may be reachable from a client graph. */
const SECRET_BEARING = [
  "src/lib/engine/config.ts",
  "src/lib/engine/providers.ts",
  "src/lib/engine/router.ts",
  "src/lib/engine/health.ts",
  "src/lib/engine/index.ts",
];

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

function resolveModule(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // bare package — not our source tree
  for (const ext of ["", ...EXTS]) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  for (const ext of EXTS) {
    const p = join(base, "index" + ext);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/**
 * Every RUNTIME module specifier in `src`: static imports, `export … from`, and
 * dynamic `import("…")` (speak.ts and the overlay both reach their dependencies
 * that way, so ignoring dynamic edges would ignore the real graph).
 *
 * `import type { … } from "x"` is erased by the compiler and is deliberately NOT
 * followed — a type-only edge ships no code. Note the source of truth for that
 * distinction is the `type` keyword right after `import`/`export`.
 */
function runtimeSpecifiers(code: string): string[] {
  const out: string[] = [];
  const stmt = /(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = stmt.exec(code))) {
    const clause = m[2] ?? "";
    // `import type {…}` / `export type {…}` — erased, no runtime edge.
    if (/^type\b/.test(clause.trim())) continue;
    out.push(m[3]);
  }
  // Side-effect imports: `import "x";`
  const bare = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  while ((m = bare.exec(code))) out.push(m[1]);
  // Dynamic imports.
  const dyn = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dyn.exec(code))) out.push(m[1]);
  return out;
}

function walk(entries: string[]): Map<string, string[]> {
  // file → the chain that reached it, so a failure names the exact edge path.
  const seen = new Map<string, string[]>();
  const queue: Array<{ file: string; path: string[] }> = [];
  for (const e of entries) {
    const abs = join(REPO, e);
    assert.ok(existsSync(abs), `adopted file is missing: ${e}`);
    queue.push({ file: abs, path: [e] });
  }
  while (queue.length) {
    const { file, path } = queue.shift()!;
    const key = relative(REPO, file);
    if (seen.has(key)) continue;
    seen.set(key, path);
    const code = readFileSync(file, "utf8");
    for (const spec of runtimeSpecifiers(code)) {
      const next = resolveModule(file, spec);
      if (!next) continue;
      const nkey = relative(REPO, next);
      if (seen.has(nkey)) continue;
      queue.push({ file: next, path: [...path, nkey] });
    }
  }
  return seen;
}

describe("bus adoption — client import graph carries no secrets", () => {
  const graph = walk(ADOPTED);

  it("actually reached the bus (the walker is not vacuously passing)", () => {
    assert.ok(
      graph.has("src/lib/engine/bus.ts"),
      "adoption should put the bus on the client graph — if not, the wiring is missing",
    );
    // Sanity: the walker followed real edges, not just the four entry points.
    assert.ok(graph.size > 10, `graph looks too small to be real: ${graph.size} files`);
  });

  for (const secret of SECRET_BEARING) {
    it(`never reaches ${secret}`, () => {
      const chain = graph.get(secret);
      assert.equal(
        chain,
        undefined,
        chain ? `LEAK PATH: ${chain.join(" -> ")}` : "unreachable, as required",
      );
    });
  }

  it("reads no env var other than NEXT_PUBLIC_*", () => {
    const offenders: string[] = [];
    for (const file of graph.keys()) {
      const code = readFileSync(join(REPO, file), "utf8");
      const re = /process\.env(?:\.([A-Za-z0-9_]+)|\[\s*["']([A-Za-z0-9_]+)["']\s*\])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) {
        const name = m[1] ?? m[2] ?? "";
        if (!name.startsWith("NEXT_PUBLIC_")) offenders.push(`${file}: ${name}`);
      }
    }
    assert.deepEqual(offenders, [], `non-public env read on a client graph:\n${offenders.join("\n")}`);
  });

  it("no adopted file names a credential env var at all", () => {
    for (const file of ADOPTED) {
      const code = readFileSync(join(REPO, file), "utf8");
      assert.doesNotMatch(
        code,
        /\b(XAI_API_KEY|GROQ_API_KEY|HF_TOKEN|REPLICATE_API_TOKEN|STARRA_PASSWORD|ANTHROPIC_API_KEY)\b/,
        `${file} must never name a key`,
      );
    }
  });
});
