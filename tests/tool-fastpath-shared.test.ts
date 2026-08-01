/**
 * TOOL FAST-PATH — single source of truth, enforced via source scan.
 *
 * B1 moved the keyword/MCP fast-path out of /api/chat/route.ts into
 * src/lib/tools/fastpath.ts (`maybeToolReply`). This pins down what a
 * regression could silently break:
 *   1. fastpath.ts is the ONE place that exports maybeToolReply.
 *   2. api/chat/route.ts imports it rather than re-defining the branches —
 *      no second copy of the MCP/repomix/openmontage/prompt-distill logic.
 *   3. the new POST /api/tools/fastpath endpoint module exists and exports
 *      POST, consuming the shared implementation (not its own copy).
 *
 * Source-scan style (readFileSync + regex), matching
 * bus-adoption-import-graph.test.ts — this deliberately never imports the
 * route modules themselves (Next.js route handlers pull in server-only
 * runtime pieces that don't need to run to prove "one implementation").
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const FASTPATH = resolve(REPO, "src/lib/tools/fastpath.ts");
const CHAT_ROUTE = resolve(REPO, "src/app/api/chat/route.ts");
const ENDPOINT = resolve(REPO, "src/app/api/tools/fastpath/route.ts");

/** Literal strings that live inside the moved branches — if any of these
 * show back up in route.ts, the branch logic was copy-pasted rather than
 * extracted, and there are now two implementations. */
const BRANCH_MARKERS = [
  "MCP BRIDGE (2026-07-31)",
  "pack (the )?repo|repomix|pack codebase|dump (the )?repo",
  "openmontage|queue (a )?short|silent shadow short|make (a )?short",
  "distill prompts|prompt structure|system prompts",
];

describe("tool fast-path — single implementation, shared everywhere", () => {
  const fastpathSrc = readFileSync(FASTPATH, "utf8");
  const chatSrc = readFileSync(CHAT_ROUTE, "utf8");
  const endpointSrc = readFileSync(ENDPOINT, "utf8");

  it("fastpath.ts exports maybeToolReply", () => {
    assert.match(
      fastpathSrc,
      /export\s+async\s+function\s+maybeToolReply\s*\(\s*lastUser\s*:\s*string\s*\)\s*:\s*Promise<string\s*\|\s*null>/,
      "src/lib/tools/fastpath.ts must export maybeToolReply(lastUser: string): Promise<string | null>",
    );
  });

  it("api/chat/route.ts imports maybeToolReply from the shared module", () => {
    assert.match(
      chatSrc,
      /import\s*\{\s*maybeToolReply\s*\}\s*from\s*["']@\/lib\/tools\/fastpath["']/,
      "route.ts must import maybeToolReply from @/lib/tools/fastpath",
    );
  });

  it("api/chat/route.ts defines no second maybeToolReply implementation", () => {
    assert.doesNotMatch(
      chatSrc,
      /(?:async\s+)?function\s+maybeToolReply\s*\(/,
      "route.ts must not redefine maybeToolReply locally — one implementation, imported",
    );
  });

  it("api/chat/route.ts carries no duplicate of the fast-path branch logic", () => {
    for (const marker of BRANCH_MARKERS) {
      assert.ok(
        !chatSrc.includes(marker),
        `route.ts still contains a fast-path branch marker (should have moved): ${marker}`,
      );
    }
  });

  it("fastpath.ts carries every branch route.ts used to own", () => {
    for (const marker of BRANCH_MARKERS) {
      assert.ok(
        fastpathSrc.includes(marker),
        `fastpath.ts is missing fast-path branch marker: ${marker}`,
      );
    }
  });

  it("api/chat/route.ts still calls maybeToolReply at the same call site", () => {
    assert.match(
      chatSrc,
      /await\s+maybeToolReply\s*\(\s*lastUser\s*\)/,
      "route.ts must still invoke maybeToolReply(lastUser) — behavior must stay byte-identical",
    );
  });

  it("POST /api/tools/fastpath endpoint module exports POST", () => {
    assert.match(
      endpointSrc,
      /export\s+async\s+function\s+POST\s*\(/,
      "src/app/api/tools/fastpath/route.ts must export POST",
    );
  });

  it("endpoint consumes the shared fastpath module, not a private copy", () => {
    // Other named imports from the SAME module are fine (the endpoint also
    // pulls maybeLiveInfoReply, the call-only live-info lookup). What must not
    // happen is the endpoint sourcing maybeToolReply from anywhere else.
    assert.match(
      endpointSrc,
      /import\s*\{[^}]*\bmaybeToolReply\b[^}]*\}\s*from\s*["']@\/lib\/tools\/fastpath["']/,
      "endpoint must import maybeToolReply from @/lib/tools/fastpath",
    );
    for (const marker of BRANCH_MARKERS) {
      assert.ok(
        !endpointSrc.includes(marker),
        `endpoint route.ts must not carry its own copy of branch logic: ${marker}`,
      );
    }
  });

  it("endpoint response shape is {handled, reply} with handled = reply !== null", () => {
    assert.match(
      endpointSrc,
      /handled\s*:\s*reply\s*!==\s*null/,
      "endpoint must derive handled from reply !== null, per spec",
    );
  });
});
