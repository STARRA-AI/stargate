/**
 * SEMANTIC RECALL — TDD net for src/lib/memory/semantic.ts (division C).
 *
 * WRITTEN FIRST, before the module exists. Confirmed failing state (this
 * session, `npx tsx --test tests/mcp-memory-bridge.test.ts`, which already
 * imports the not-yet-built module via src/app/api/mcp/route.ts:38):
 *
 *   Error: Cannot find module '@/lib/memory/semantic'
 *   Require stack:
 *   - src/app/api/mcp/route.ts
 *   - tests/mcp-memory-bridge.test.ts
 *   code: 'MODULE_NOT_FOUND'
 *
 * CONTRACT (division brief): semanticRecall(query: string, k?: number):
 * Promise<string[] | null> — resolves to hit strings on success, resolves to
 * null on ANY failure (missing index, Ollama down, python error, timeout
 * ~4s), and NEVER rejects.
 *
 * TRANSPORT — what's VERIFIED vs ASSUMED, since the module does not exist
 * yet to read a contract from directly:
 *  - VERIFIED (division contract's "BUNDLER LANDMINE" clause, and the
 *    precedent it names at src/app/api/tools/prompts/route.ts:3-19, read in
 *    full): child_process must be loaded via
 *    `createRequire(import.meta.url)("child_process")`, never a static
 *    `import ... from "child_process"` (tests/route-bundler-traps.test.ts
 *    enforces the static-import ban repo-wide, on every route — this file's
 *    guard test below extends the same check specifically to route.ts).
 *  - VERIFIED (`~/STARGATE/turbovec-env/starra_recall.py`, read in full):
 *    the only local semantic-search tool in the privacy-approved surface
 *    (127.0.0.1 Ollama + local turbovec index) is a python CLI —
 *    `search "<query>" [k]` — so a child process is what gets spawned.
 *  - VERIFIED (reproduced this session, `node -e`): two separate
 *    `createRequire(...)("child_process")` calls in the SAME process return
 *    the identical mutable object, and reassigning `.spawn` on it is visible
 *    to every other caller of that same require — including semantic.ts's
 *    own createRequire call. That identity is the mock seam used below; it
 *    needs no module-mocking API (this Node build's `mock.module` is not
 *    available: `typeof require("node:test").mock.module === "undefined"`,
 *    checked this session).
 *  - RESOLVED by the executive (was "ASSUMED" here): the wire shape is real
 *    and verified end to end. `starra_recall.py` gained a machine mode at
 *    starra_recall.py:154-174 — `python starra_recall.py json "<query>" <k>`
 *    prints a bare JSON array of hit strings and nothing else. Measured
 *    2026-08-08 on the live 1,265-entry index: `json "the money thing" 4`
 *    returned 4 relevant hits in 0.69-0.77s wall clock (three runs), well
 *    inside semantic.ts's 4s ceiling. The argv-shape test below pins that
 *    contract so a silent rename of the subcommand fails here instead of
 *    degrading to "no results" forever in production.
 *
 * WHY THE MERGE TESTS EXIST (executive finding, 2026-08-08). turbovec has NO
 * relevance floor: `json "zzqqxx flurblegronk 9917" 3` returns three hits,
 * and the score bands overlap (nonsense top 0.5717 vs. a real query's 0.5911),
 * so no threshold separates them. Semantic therefore returns hits on ~every
 * query while the index is healthy. Combined with a route that RETURNED on
 * the first non-empty semantic result, the substring scan became unreachable
 * — and nothing rebuilds the index (no cron, no hook; `data/memory.json` was
 * 04:24 against a 03:50 index at the time of writing), so anything she was
 * told since the last build could not be recalled at all, not even verbatim.
 * `mergeRecall` is the fix: the live-store scan always keeps a seat.
 */

import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const childProcess = nodeRequire("child_process") as typeof import("node:child_process");
const REAL_SPAWN = childProcess.spawn;

/** Minimal stand-in for the ChildProcess the real spawn() would return. */
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

/**
 * Replaces the shared child_process.spawn (see header) with a fake that hands
 * the caller a FakeChildProcess, then lets `drive` script events on it after
 * semantic.ts has had a tick to attach its own listeners.
 */
function installFakeSpawn(drive: (child: FakeChildProcess) => void): FakeChildProcess {
  const child = new FakeChildProcess();
  childProcess.spawn = ((...args: unknown[]) => {
    lastSpawnArgs = args;
    queueMicrotask(() => drive(child));
    return child as unknown as ReturnType<typeof REAL_SPAWN>;
  }) as typeof childProcess.spawn;
  return child;
}

/** What the implementation last handed spawn(). Pins the CLI contract. */
let lastSpawnArgs: unknown[] = [];

const FAKE_STDOUT_PAYLOAD = JSON.stringify(["memory hit one", "memory hit two"]);
const EXPECTED_HITS = ["memory hit one", "memory hit two"];

describe("semanticRecall — transport failures always resolve null, never reject", () => {
  let semanticRecall: (query: string, k?: number) => Promise<string[] | null>;

  before(async () => {
    ({ semanticRecall } = await import("@/lib/memory/semantic"));
  });

  beforeEach(() => {
    childProcess.spawn = REAL_SPAWN;
  });

  after(() => {
    childProcess.spawn = REAL_SPAWN;
  });

  it("resolves null, never rejects, when the transport errors (spawn ENOENT / process error)", async () => {
    installFakeSpawn((child) => {
      child.emit("error", Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" }));
    });

    const result = await semanticRecall("what did we decide about the funding play");
    assert.equal(result, null);
  });

  it("resolves null, never rejects, when the process exits non-zero (python error)", async () => {
    installFakeSpawn((child) => {
      child.stderr.emit("data", Buffer.from("Traceback (most recent call last): ...\n"));
      child.emit("close", 1);
    });

    const result = await semanticRecall("stock engine status");
    assert.equal(result, null);
  });

  it(
    "resolves null on timeout (~4s) rather than hanging when the process never closes",
    { timeout: 6000 },
    async () => {
      // Never emits close/exit/error — the real implementation must give up
      // on its own internal ~4s timer rather than waiting forever.
      installFakeSpawn(() => {
        /* deliberately silent */
      });

      const result = await semanticRecall("a query that never gets an answer");
      assert.equal(result, null);
    },
  );

  it("maps a successful transport payload to string[]", async () => {
    installFakeSpawn((child) => {
      child.stdout.emit("data", Buffer.from(FAKE_STDOUT_PAYLOAD));
      child.emit("close", 0);
    });

    const result = await semanticRecall("clone and flip playbook", 5);
    assert.deepEqual(result, EXPECTED_HITS);
  });

  it("spawns the python CLI in `json` machine mode, with the query and k", async () => {
    installFakeSpawn((child) => {
      child.stdout.emit("data", Buffer.from(FAKE_STDOUT_PAYLOAD));
      child.emit("close", 0);
    });

    await semanticRecall("what did we decide about the funding play", 5);

    const [bin, argv] = lastSpawnArgs as [string, string[]];
    assert.match(String(bin), /python/, "must run the turbovec venv python, not a shell");
    assert.ok(Array.isArray(argv), "argv must be an array — never a shell string");
    assert.match(argv[0], /starra_recall\.py$/, "argv[0] is the recall CLI");
    assert.equal(
      argv[1],
      "json",
      "must use the machine mode at starra_recall.py:154 — `search` prints " +
        "human-formatted TRUNCATED lines and would never JSON.parse",
    );
    assert.equal(argv[2], "what did we decide about the funding play", "query passed as ONE argv slot");
    assert.equal(argv[3], "5", "k passed as the trailing digit-only slot the CLI parses");
  });

  it("resolves null when stdout is not JSON at all (a stray print, a traceback)", async () => {
    installFakeSpawn((child) => {
      child.stdout.emit("data", Buffer.from("Traceback (most recent call last):\n  File ...\n"));
      child.emit("close", 0);
    });

    assert.equal(await semanticRecall("anything"), null);
  });

  it("resolves null when stdout is valid JSON of the WRONG shape", async () => {
    installFakeSpawn((child) => {
      // An object, not the bare array the contract promises. Putting this
      // through unchecked would push `undefined` into her prompt.
      child.stdout.emit("data", Buffer.from(JSON.stringify({ hits: ["one"] })));
      child.emit("close", 0);
    });

    assert.equal(await semanticRecall("anything"), null);
  });

  it("resolves null (not []) on an empty result, so the caller's fallback runs", async () => {
    installFakeSpawn((child) => {
      child.stdout.emit("data", Buffer.from("[]"));
      child.emit("close", 0);
    });

    assert.equal(await semanticRecall("nothing matches this"), null);
  });

  it("survives stdout arriving in fragments (a big payload is chunked)", async () => {
    installFakeSpawn((child) => {
      const half = Math.floor(FAKE_STDOUT_PAYLOAD.length / 2);
      child.stdout.emit("data", Buffer.from(FAKE_STDOUT_PAYLOAD.slice(0, half)));
      child.stdout.emit("data", Buffer.from(FAKE_STDOUT_PAYLOAD.slice(half)));
      child.emit("close", 0);
    });

    assert.deepEqual(await semanticRecall("chunked"), EXPECTED_HITS);
  });

  it("never rejects for an empty-string query", async () => {
    // No transport expectations here — an empty query is meaningless to embed
    // and search, so this only pins the "never rejects" half of the contract,
    // not which branch (short-circuit vs. real transport) produces it.
    installFakeSpawn((child) => {
      child.stdout.emit("data", Buffer.from(JSON.stringify([])));
      child.emit("close", 0);
    });

    let result: string[] | null | undefined;
    let threw: unknown;
    try {
      result = await semanticRecall("");
    } catch (err) {
      threw = err;
    }
    assert.equal(threw, undefined, "semanticRecall must never reject, even for an empty query");
    assert.ok(
      result === null || Array.isArray(result),
      `expected null or string[] for an empty query, got ${JSON.stringify(result)}`,
    );
  });
});

describe("mergeRecall — the live store never loses its seat to the index", () => {
  let mergeRecall: (exact: string[], sem: string[] | null, limit: number) => string[];

  before(async () => {
    ({ mergeRecall } = await import("@/lib/memory/semantic"));
  });

  it("returns nothing when neither lane found anything (she says so honestly)", () => {
    assert.deepEqual(mergeRecall([], null, 12), []);
    assert.deepEqual(mergeRecall([], [], 12), []);
  });

  it("index down (null) — pure substring behaviour, newest tail, unchanged", () => {
    const exact = ["a", "b", "c", "d"];
    assert.deepEqual(mergeRecall(exact, null, 2), ["c", "d"]);
  });

  it("no substring hits — semantic fills the whole budget", () => {
    assert.deepEqual(mergeRecall([], ["s1", "s2", "s3"], 2), ["s1", "s2"]);
  });

  it("a flood of substring hits STILL leaves room for semantic", () => {
    // The regression this exists for: a common word ("the") matches 20 stored
    // lines, and meaning-based recall gets crowded out of the answer entirely.
    const exact = Array.from({ length: 20 }, (_, i) => `e${i}`);
    const out = mergeRecall(exact, ["s1", "s2"], 4);
    assert.equal(out.length, 4);
    assert.ok(
      out.some((h) => h.startsWith("e")),
      "verbatim live-store hits must survive",
    );
    assert.ok(
      out.some((h) => h.startsWith("s")),
      "semantic hits must survive a substring flood",
    );
  });

  it("never exceeds the limit and never repeats a memory found by both lanes", () => {
    const out = mergeRecall(["dup", "e1"], ["dup", "s1", "s2"], 4);
    assert.ok(out.length <= 4, `expected <= 4, got ${out.length}`);
    assert.equal(new Set(out).size, out.length, `duplicate memory in ${JSON.stringify(out)}`);
    assert.ok(out.includes("dup"));
  });

  it("limit 1 still returns exactly one hit, not zero", () => {
    assert.equal(mergeRecall(["e1"], ["s1"], 1).length, 1);
  });
});

describe("static guards — the bundler trap and the silent-failure trap", () => {
  const semanticPath = path.join(process.cwd(), "src/lib/memory/semantic.ts");

  it("semantic.ts loads child_process opaquely, never as a static import", () => {
    // tests/route-bundler-traps.test.ts scans route.ts files ONLY. semantic.ts
    // is now in the mcp route's module graph and carries the spawn() call, so
    // the repo-wide guard has a blind spot exactly where the risk moved.
    const src = readFileSync(semanticPath, "utf8");
    assert.doesNotMatch(
      src,
      /^\s*import\s+[^;]*\bfrom\s+["'](?:node:)?child_process["']/m,
      "src/lib/memory/semantic.ts must not statically import child_process — Turbopack " +
        "traces the spawn() argument array through a binding it can see and 500s the " +
        "route in dev (it took /api/tools/prompts and six sibling routes down on " +
        "2026-08-08). `next build` stays green while dev is broken, so a passing build " +
        "proves nothing here.",
    );
    assert.match(
      src,
      /nodeRequire\(\s*["']child_process["']\s*\)/,
      "child_process must come through createRequire, the same escape hatch as " +
        "src/app/api/tools/prompts/route.ts",
    );
  });

  it("semantic.ts reports its degrades instead of failing silently", () => {
    // Shared invariant (5): the recall path degrades, but a degrade that leaves
    // no trace is indistinguishable from "she has no memory of that" — the exact
    // symptom this division was formed to kill.
    const src = readFileSync(semanticPath, "utf8");
    assert.match(
      src,
      /captureError\(/,
      "every failure path must report to the error feed (src/lib/errlog.ts) before " +
        "returning null",
    );
    assert.doesNotMatch(
      src,
      /stdio:\s*\[[^\]]*"ignore"\s*\]/,
      "stderr must be piped, not ignored — the python traceback IS the reason, and " +
        "throwing it away leaves nothing to debug",
    );
  });
});
