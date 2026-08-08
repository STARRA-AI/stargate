/**
 * THE PUBLIC SURFACE — who may read her, who may REWRITE her, and what else
 * is reachable at all from outside the house.
 *
 * One token used to grant `recall` (read) and `remember` (write) identically
 * (pre-change: src/app/api/voice-tools/[action]/route.ts authorized() checked
 * STARRA_MCP_TOKEN and nothing else, for every action). A holder could write
 * arbitrary text into data/memory.json — the store her prompt is built from.
 * That is not data corruption; it is a stranger editing what she believes
 * about Classic. Read access leaks. Write access rewrites her.
 *
 * Three things are pinned here:
 *   1. `authorizePublic` — the scope logic itself.
 *   2. Both public routes actually ASK for the right scope.
 *   3. The middleware public list is exactly the five known prefixes, and
 *      everything else 401s (or redirects to /login for a page).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { authorizePublic } from "../src/lib/api/public-auth";
import { middleware } from "../src/middleware";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const READ = "read-token-long-enough-for-the-guard-01234567";
const WRITE = "write-token-long-enough-for-the-guard-0123456";
let savedRead: string | undefined;
let savedWrite: string | undefined;

before(() => {
  savedRead = process.env.STARRA_MCP_TOKEN;
  savedWrite = process.env.STARRA_MCP_WRITE_TOKEN;
  process.env.STARRA_MCP_TOKEN = READ;
  process.env.STARRA_MCP_WRITE_TOKEN = WRITE;
});
after(() => {
  if (savedRead === undefined) delete process.env.STARRA_MCP_TOKEN;
  else process.env.STARRA_MCP_TOKEN = savedRead;
  if (savedWrite === undefined) delete process.env.STARRA_MCP_WRITE_TOKEN;
  else process.env.STARRA_MCP_WRITE_TOKEN = savedWrite;
});

const req = (token?: string) =>
  new Request("http://local/x", { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("public token scopes", () => {
  it("the read token reads", () => {
    assert.equal(authorizePublic(req(READ), "read").ok, true);
  });

  it("the read token CANNOT write — this is the whole point", () => {
    const r = authorizePublic(req(READ), "write");
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 403);
  });

  it("the write token writes", () => {
    assert.equal(authorizePublic(req(WRITE), "write").ok, true);
  });

  it("the write token also reads", () => {
    assert.equal(authorizePublic(req(WRITE), "read").ok, true);
  });

  it("no token is denied for both scopes", () => {
    assert.equal(authorizePublic(req(), "read").ok, false);
    assert.equal(authorizePublic(req(), "write").ok, false);
  });

  it("an UNSET write token denies writes but keeps reads working", () => {
    const prev = process.env.STARRA_MCP_WRITE_TOKEN;
    delete process.env.STARRA_MCP_WRITE_TOKEN;
    assert.equal(authorizePublic(req(READ), "read").ok, true, "reads must survive");
    assert.equal(authorizePublic(req(READ), "write").ok, false, "absent must never mean open");
    process.env.STARRA_MCP_WRITE_TOKEN = prev;
  });

  it("refuses a write token identical to the read token", () => {
    const prev = process.env.STARRA_MCP_WRITE_TOKEN;
    process.env.STARRA_MCP_WRITE_TOKEN = READ;
    const r = authorizePublic(req(READ), "write");
    assert.equal(r.ok, false, "one token wearing two hats is not a split");
    process.env.STARRA_MCP_WRITE_TOKEN = prev;
  });

  it("a too-short token is treated as unset", () => {
    const prev = process.env.STARRA_MCP_TOKEN;
    process.env.STARRA_MCP_TOKEN = "short";
    const r = authorizePublic(req("short"), "read");
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 503);
    process.env.STARRA_MCP_TOKEN = prev;
  });

  it("a too-short WRITE token is treated as unset — writes denied, reads alive", () => {
    const prev = process.env.STARRA_MCP_WRITE_TOKEN;
    process.env.STARRA_MCP_WRITE_TOKEN = "short";
    assert.equal(authorizePublic(req(READ), "read").ok, true);
    const r = authorizePublic(req("short"), "write");
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 403);
    process.env.STARRA_MCP_WRITE_TOKEN = prev;
  });

  it("never reveals WHICH token was wrong — the denial text is not an oracle", () => {
    const wrongLength = authorizePublic(req("x"), "read");
    const rightLengthWrongValue = authorizePublic(req("z".repeat(READ.length)), "read");
    assert.deepEqual(wrongLength, rightLengthWrongValue);
  });
});

describe("the routes actually enforce the scopes", () => {
  it("voice-tools maps each mutating action to the write scope", () => {
    const src = readFileSync(join(REPO, "src/app/api/voice-tools/[action]/route.ts"), "utf8");
    assert.match(src, /authorizePublic\(/);
    for (const write of ["remember", "note", "funding_status"]) {
      assert.match(
        src,
        new RegExp(`WRITE_ACTIONS[^]{0,200}${write}`),
        `${write} must be listed as a write action`,
      );
    }
    assert.doesNotMatch(src, /WRITE_ACTIONS[^]{0,200}"recall"/, "recall is a READ, not a write");
  });

  it("mcp requires write for the remember tool and read for everything else", () => {
    const src = readFileSync(join(REPO, "src/app/api/mcp/route.ts"), "utf8");
    assert.match(src, /authorizePublic\(/);
    assert.match(src, /"write"/);
    assert.match(src, /MCP_WRITE_TOOLS[^]{0,200}"remember"/);
  });

  it("no public route still reads STARRA_MCP_TOKEN directly — one gate, not three", () => {
    for (const rel of ["src/app/api/mcp/route.ts", "src/app/api/voice-tools/[action]/route.ts"]) {
      const src = readFileSync(join(REPO, rel), "utf8");
      assert.doesNotMatch(
        src,
        /process\.env\.STARRA_MCP_TOKEN/,
        `${rel} must delegate to authorizePublic, not re-implement the check`,
      );
    }
  });
});

describe("middleware public surface — five doors, everything else locked", () => {
  const PUBLIC = ["/login", "/api/auth", "/starra-ca.crt", "/api/mcp", "/api/voice-tools"];
  let savedPw: string | undefined;

  before(() => {
    savedPw = process.env.STARRA_PASSWORD;
    // A password MUST be configured, otherwise middleware takes the
    // fail-closed branch (src/middleware.ts:57-65) and never reaches the list.
    process.env.STARRA_PASSWORD = "middleware-surface-test-password";
  });
  after(() => {
    if (savedPw === undefined) delete process.env.STARRA_PASSWORD;
    else process.env.STARRA_PASSWORD = savedPw;
  });

  const hit = (path: string) =>
    middleware(new NextRequest(new Request(`https://deck.local${path}`, { headers: { host: "deck.local" } })));

  it("the public list in the source is exactly the five known prefixes", () => {
    const mw = readFileSync(join(REPO, "src/middleware.ts"), "utf8");
    const line = /const PUBLIC_PREFIXES = \[([\s\S]*?)\]/.exec(mw)?.[1] ?? "";
    const entries = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(entries, [...PUBLIC].sort(), "a sixth public door must never appear unnoticed");
  });

  for (const p of PUBLIC) {
    it(`${p} stays reachable while logged out`, async () => {
      const res = await hit(p);
      assert.notEqual(res.status, 401, `${p} must not be gated`);
      assert.equal(res.headers.get("location"), null, `${p} must not redirect to login`);
    });
  }

  for (const p of ["/api/keys", "/api/chat", "/api/memory", "/api/errors", "/api/vault/upload"]) {
    it(`${p} 401s without a session`, async () => {
      const res = await hit(p);
      assert.equal(res.status, 401, `${p} must stay private`);
    });
  }

  it("a prefix is a PATH boundary, not a string prefix — /api/authorize is NOT public", async () => {
    for (const near of ["/api/authorize", "/api/mcp-secret", "/api/voice-tools-admin"]) {
      const res = await hit(near);
      assert.equal(res.status, 401, `${near} must not inherit a public prefix`);
    }
  });

  it("a logged-out PAGE is redirected to /login rather than 401'd", async () => {
    const res = await hit("/deck");
    assert.equal(res.status, 307);
    assert.match(res.headers.get("location") ?? "", /\/login\?next=/);
  });
});
