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
 *
 * A degrade is LOUD, though: every failure path calls `captureError` first,
 * with the python stderr attached. A silent degrade here is indistinguishable
 * from "she has no memory of that" — the exact symptom this file exists to
 * kill — and would leave nothing to debug. An empty result is NOT a failure
 * and is not reported; it is a legitimate "no hits".
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { captureError } from "@/lib/errlog";

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
    let child: {
      kill: () => void;
      stdout: NodeJS.EventEmitter;
      stderr: NodeJS.EventEmitter;
      on: (...a: never[]) => unknown;
    };

    try {
      const { spawn } = nodeRequire("child_process") as typeof import("node:child_process");
      // `json` is the machine mode at starra_recall.py:154 — a bare JSON array
      // and nothing else. `search` prints human lines TRUNCATED to 110 chars;
      // using it here would hand her mangled memories, not a parse error.
      // argv, never a shell string: his memories are the argument.
      child = spawn(PYTHON, [SCRIPT, "json", q, String(k)], {
        cwd: ENV_DIR,
        // stderr is PIPED, not ignored: the python traceback is the only
        // evidence of why recall degraded.
        stdio: ["ignore", "pipe", "pipe"],
      }) as unknown as typeof child;
    } catch (err) {
      // spawn threw synchronously (missing binary, bad path). Degrade, loudly.
      captureError("memory.semantic.spawn", err);
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
      captureError(
        "memory.semantic.timeout",
        new Error(`recall exceeded ${TIMEOUT_MS}ms and was killed${errTail()}`),
      );
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

    let errOut = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      errOut += String(chunk);
    });
    /** Last of stderr, bounded — the tail carries the exception, not the banner. */
    const errTail = () => (errOut.trim() ? ` — stderr: ${errOut.trim().slice(-400)}` : "");

    // An ENOENT or permission error arrives here, not as a throw.
    (child.on as unknown as (e: string, f: (...a: never[]) => void) => void)(
      "error",
      ((err: unknown) => {
        captureError("memory.semantic.child", err);
        done(null);
      }) as unknown as (...a: never[]) => void,
    );

    (child.on as unknown as (e: string, f: (code: number | null) => void) => void)(
      "close",
      (code) => {
        if (code !== 0) {
          captureError(
            "memory.semantic.exit",
            new Error(`starra_recall.py exited ${String(code)}${errTail()}`),
          );
          return done(null);
        }
        try {
          const parsed: unknown = JSON.parse(out);
          // Trust nothing about the shape: a partially-written or non-array
          // payload must degrade, not put `undefined` into her prompt.
          if (!Array.isArray(parsed)) {
            captureError(
              "memory.semantic.shape",
              new Error(`expected a JSON array, got ${typeof parsed}: ${out.slice(0, 200)}`),
            );
            return done(null);
          }
          const hits = parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
          // Zero hits is a legitimate answer, not a fault: no report.
          done(hits.length > 0 ? hits : null);
        } catch (err) {
          captureError("memory.semantic.parse", err);
          done(null);
        }
      },
    );
  });
}

/**
 * Fold the two recall lanes into one answer — and never let either one vanish.
 *
 * WHY THIS EXISTS. turbovec applies NO relevance floor: measured 2026-08-08 on
 * the live index, `json "zzqqxx flurblegronk 9917" 3` returned three hits, and
 * the score bands overlap a real query's (nonsense top 0.5717 vs. 0.5911 for
 * "the money thing"), so no threshold separates signal from noise. Semantic
 * therefore returns hits on virtually every query while the index is up. A
 * caller that RETURNS on the first non-empty semantic result makes the live
 * substring scan unreachable — and NOTHING rebuilds the index (no cron, no
 * write hook anywhere in src/ or scripts/; `data/memory.json` was 34 minutes
 * newer than the index when this was written). She would silently stop being
 * able to recall anything Classic told her since the last build, even verbatim.
 *
 * So both lanes always get a seat: the live store is the fresh/exact lane, the
 * index is the meaning lane. When the index answers, the store keeps half the
 * budget; when it doesn't, the store keeps all of it and behaviour is exactly
 * what it was before this file existed.
 */
export function mergeRecall(exact: string[], sem: string[] | null, limit: number): string[] {
  const semHits = sem ?? [];
  if (semHits.length === 0) return exact.slice(-limit);

  // Newest last in the store, so the TAIL is the recent, most relevant end.
  const reserved = Math.max(1, Math.ceil(limit / 2));
  const merged = exact.slice(-reserved);
  for (const hit of semHits) {
    if (merged.length >= limit) break;
    if (!merged.includes(hit)) merged.push(hit);
  }
  return merged;
}
