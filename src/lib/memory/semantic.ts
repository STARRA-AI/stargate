/**
 * SEMANTIC RECALL — she finds a memory by MEANING, not by keyword.
 *
 * `recall_memory` was a raw substring scan (`content.toLowerCase().includes(q)`),
 * so she could only find a memory containing Classic's exact word. Measured
 * 2026-08-08: the query "the money thing" returned **0 hits across all 1,265
 * memories**, while the semantic index returned four genuinely relevant
 * conversations. That reads to him as her forgetting his life.
 *
 * This is the bridge to the index. Everything stays on this Mac — a turbovec
 * index built from local Ollama embeddings. Her memory is his vault; nothing is
 * uploaded, and there is no hosted embedding call anywhere in this path.
 *
 * ── WHY child_process IS LOADED THROUGH createRequire ──────────────────────
 * Turbopack STATICALLY TRACES the argument array of any spawn()/exec() call
 * whose binding it can see, and tries to resolve that string as a module. On
 * 2026-08-08 that took `/api/tools/prompts` down with
 * "Can't resolve './ROOT/scripts' <dynamic>" and 500'd six sibling tool routes
 * with it. The path shape is irrelevant — absolute from cwd and relative both
 * fail. createRequire returns a value the bundler cannot identify, so it stops
 * tracing. `tests/route-bundler-traps.test.ts` fails the build if anyone
 * "cleans this up" back into a static import.
 *
 * That failure is DEV-ONLY: `next build` compiled fine while the page was
 * broken. A green build proves nothing here.
 *
 * ── FAILURE POLICY ─────────────────────────────────────────────────────────
 * This function NEVER rejects. Every failure — no index, Ollama down, python
 * missing, malformed output, timeout — resolves `null`, and the caller falls
 * back to the substring scan it already had. Her recall must degrade, never
 * break: an exception here would take out the whole memory tool, which is far
 * worse than a keyword-only answer.
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

const nodeRequire = createRequire(import.meta.url);

/** Where the venv and the CLI live. Outside the repo — the index is ~1,265 embeddings. */
const ENV_DIR = path.join(homedir(), "STARGATE", "turbovec-env");
const PYTHON = path.join(ENV_DIR, ".venv", "bin", "python");
const SCRIPT = path.join(ENV_DIR, "starra_recall.py");

/**
 * Hard ceiling on how long she will wait for a memory lookup.
 *
 * A cold Ollama embed is ~200-400ms; 4s is generous. The number that matters is
 * the CEILING, not the average: this sits in her reply path, so a hung python
 * would otherwise become her sitting silent on a call. On timeout the child is
 * killed and we degrade.
 */
const TIMEOUT_MS = 4000;

/** Default hits. Enough context to answer from, small enough not to flood her prompt. */
const DEFAULT_K = 8;

export function semanticRecall(query: string, k: number = DEFAULT_K): Promise<string[] | null> {
  const q = query.trim();
  if (!q) return Promise.resolve(null);

  return new Promise<string[] | null>((resolve) => {
    let settled = false;
    let child: { kill: () => void; stdout: NodeJS.EventEmitter; on: (...a: never[]) => unknown };

    try {
      const { spawn } = nodeRequire("child_process") as typeof import("node:child_process");
      child = spawn(PYTHON, [SCRIPT, "json", q, String(k)], {
        cwd: ENV_DIR,
        stdio: ["ignore", "pipe", "ignore"],
      }) as unknown as typeof child;
    } catch {
      // spawn threw synchronously (missing binary, bad path). Degrade.
      return resolve(null);
    }

    // Declared before `done` so it can be const: the timer callback references
    // `done`, which is defined below, but only RUNS after this tick, so the
    // binding is always initialized by the time it fires.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone — nothing to do, and it must not mask the timeout */
      }
      done(null);
    }, TIMEOUT_MS);

    // Resolved-once latch: timeout, error and close can all fire for one run
    // (a killed process emits BOTH), and settling twice would be a silent
    // no-op that hides which path actually won.
    const done = (value: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let out = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      out += String(chunk);
    });

    // An ENOENT or permission error arrives here, not as a throw.
    (child.on as unknown as (e: string, f: (...a: never[]) => void) => void)("error", () => done(null));

    (child.on as unknown as (e: string, f: (code: number | null) => void) => void)(
      "close",
      (code) => {
        if (code !== 0) return done(null);
        try {
          const parsed: unknown = JSON.parse(out);
          // Trust nothing about the shape: a partially-written or non-array
          // payload must degrade, not put `undefined` into her prompt.
          if (!Array.isArray(parsed)) return done(null);
          const hits = parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
          done(hits.length > 0 ? hits : null);
        } catch {
          done(null);
        }
      },
    );
  });
}
