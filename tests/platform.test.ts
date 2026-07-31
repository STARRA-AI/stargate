/**
 * PLATFORM HARDENING — database, error tracking, auth fail-closed, headers,
 * caching. Behavioral where possible (temp SQLite), source-pinned where the
 * invariant is structural. Born from the night the middleware's edge sandbox
 * lost its env and the "no password" clause silently OPENED the deck.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

describe("auth gate — fail closed, nodejs runtime", () => {
  const mw = read("src/middleware.ts");

  it("middleware runs on the nodejs runtime (the env-loss fix)", () => {
    assert.match(mw, /runtime: "nodejs"/);
  });

  it("a missing password seals non-local requests instead of opening the deck", () => {
    assert.match(mw, /deck sealed/);
    assert.match(mw, /status: 503/);
    assert.ok(
      !/if \(!authPassword\(\)\) return NextResponse\.next\(\);/.test(mw),
      "the old unconditional fail-open clause must stay dead",
    );
  });

  it("authed responses carry the hardening headers; camera stays off", () => {
    assert.match(mw, /X-Content-Type-Options/);
    assert.match(mw, /X-Frame-Options/);
    assert.match(mw, /camera=\(\)/);
    assert.match(mw, /microphone=\(self\)/);
  });
});

describe("error tracking — behavioral, temp db", () => {
  it("captureError → recentErrors roundtrip, bounded, never throws", async () => {
    process.env.STARGATE_DB_PATH = join(
      tmpdir(),
      `errlog-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    const { captureError, recentErrors } = await import("../src/lib/errlog");
    captureError("test-scope", new Error("boom with detail"));
    captureError("test-scope", "a plain string failure");
    assert.doesNotThrow(() => captureError("junk", undefined));
    const rows = recentErrors(10);
    assert.ok(rows.length >= 3);
    assert.equal(rows[1].scope, "test-scope");
    assert.ok(rows.some((r) => r.message.includes("boom with detail")));
  });

  it("the process-wide net observes and never exits", () => {
    const src = read("src/instrumentation.ts");
    assert.match(src, /NEXT_RUNTIME !== "nodejs"/);
    assert.match(src, /unhandledRejection/);
    assert.match(src, /uncaughtException/);
    assert.ok(!src.includes("process.exit"), "handlers observe only");
  });
});

describe("database — operator-scoped by construction", () => {
  it("every db.ts helper table carries operator and queries scope to it", () => {
    const src = read("src/lib/db.ts");
    assert.match(src, /CURRENT_OPERATOR = "classic"/);
    assert.match(src, /operator TEXT NOT NULL DEFAULT 'classic'/);
    const flip = read("src/lib/flipradar/store.ts");
    assert.match(flip, /WHERE operator = \?/);
    const errs = read("src/lib/errlog.ts");
    assert.match(errs, /WHERE operator = \?/);
  });

  it("WAL mode + migrations table", () => {
    const src = read("src/lib/db.ts");
    assert.match(src, /journal_mode = WAL/);
    assert.match(src, /_migrations/);
  });
});

describe("caching — media revalidates, never immutable", () => {
  it("avatar + brand media get bounded cache headers", () => {
    const cfg = read("next.config.ts");
    assert.match(cfg, /\/avatar\/:path\*/);
    assert.match(cfg, /max-age=3600, must-revalidate/);
    // Comments stripped: the doc comment may EXPLAIN why immutable is banned;
    // the header VALUES may not carry it.
    const codeOnly = cfg
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !codeOnly.includes("immutable"),
      "in-place-replaced media must never be immutable",
    );
  });
});
