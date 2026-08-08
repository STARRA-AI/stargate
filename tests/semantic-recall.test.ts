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
 *  - ASSUMED / UNVERIFIED — ESCALATE TO THE EXECUTIVE: the exact stdout wire
 *    shape semantic.ts parses. starra_recall.py's `search` command as it
 *    stands today prints human-formatted, truncated lines
 *    (`  [archival ] 0.8123  text...`), not JSON, so semantic.ts (or a
 *    modified copy of the script) must add a machine-readable mode to
 *    satisfy the `string[]` contract. This file assumes stdout is a single
 *    JSON array of hit strings, e.g. `["text one", "text two"]` — the
 *    simplest shape consistent with the contract. If the real
 *    implementation differs, only FAKE_STDOUT_PAYLOAD / EXPECTED_HITS below
 *    need to change to re-align this net with the real wire shape.
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
  childProcess.spawn = (() => {
    queueMicrotask(() => drive(child));
    return child as unknown as ReturnType<typeof REAL_SPAWN>;
  }) as typeof childProcess.spawn;
  return child;
}

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

describe("static guard — the mcp route must not statically import child_process", () => {
  it("route.ts has no top-level `import ... from \"child_process\"` / \"node:child_process\"", () => {
    const routePath = path.join(process.cwd(), "src/app/api/mcp/route.ts");
    const src = readFileSync(routePath, "utf8");
    assert.doesNotMatch(
      src,
      /^\s*import\s+[^;]*\bfrom\s+["'](?:node:)?child_process["']/m,
      "src/app/api/mcp/route.ts must not statically import child_process — that hands " +
        "Turbopack a traceable binding and 500s the route in dev (see " +
        "tests/route-bundler-traps.test.ts). semanticRecall must own the createRequire " +
        "escape hatch internally, not route.ts.",
    );
  });
});
