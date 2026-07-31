/**
 * SILENT SHADOW panel — safety pins on the queue-visibility route.
 * The route reads ONLY its three fixed queue dirs (no user input reaches the
 * filesystem), fails open to zeros on any miss, narrates each failed upload
 * into the feed exactly once, and stays behind the default /api/* auth gate.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");
const SRC = read("src/app/api/tools/shadow/route.ts");

// The queue-reading logic moved from the route into src/lib/shadow.ts when the
// morning briefing gained a second consumer — the invariants moved with it.
const LIB = read("src/lib/shadow.ts");

describe("shadow route discipline, on the source", () => {
  it("no user input reaches the filesystem — fixed queue names only", () => {
    assert.ok(!SRC.includes("searchParams"), "route takes no query input");
    assert.ok(!/await req\.json/.test(SRC), "route takes no body input");
    assert.match(LIB, /ready_to_publish/);
    assert.match(LIB, /upload_failed/);
    assert.ok(!LIB.includes("searchParams"), "lib reads only its fixed names");
  });

  it("fails open — a missing folder is zero, never a throw", () => {
    assert.match(LIB, /return \{ count: 0, files: \[\] \};/);
  });

  it("narrates each failed upload once (deduped feed lines)", () => {
    assert.match(SRC, /narratedFailures/);
    assert.match(SRC, /pushFeed\("SHDW"/);
  });

  it("stays behind the auth gate", () => {
    assert.ok(!read("src/middleware.ts").includes("shadow"));
  });

  it("base dir is env-overridable and outside the repo by default", () => {
    assert.match(LIB, /STARRA_SHADOW_DIR/);
    assert.match(LIB, /silent shadow launch/);
  });
});
