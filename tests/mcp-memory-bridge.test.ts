/**
 * MCP MEMORY BRIDGE — the door to her memory that faces the public internet.
 *
 * WHY THIS FILE IS A TEST AND NOT A COMMENT: this is the only endpoint in the
 * house xAI's servers must be able to reach, which means it is the only one an
 * anonymous stranger can also reach. Classic's canon is explicit that his life
 * is a vault. Every assertion below is a lock on that vault, and each one fails
 * silently in production if it regresses — an open endpoint still returns 200.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { POST, GET } from "../src/app/api/mcp/route";

// Denials report through captureError (no bare return on a failure path), which
// writes to sqlite. Temp DB so this suite never pollutes the real errors table.
process.env.STARGATE_DB_PATH = join(
  tmpdir(),
  `mcp-bridge-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
);

const TOKEN = "test-token-long-enough-for-the-guard-0123456789";
/** Rewriting her memory takes a SECOND key, which must differ from the read one. */
const WRITE_TOKEN = "write-token-long-enough-for-the-guard-012345678";
let saved: string | undefined;
let savedWrite: string | undefined;

before(() => {
  saved = process.env.STARRA_MCP_TOKEN;
  savedWrite = process.env.STARRA_MCP_WRITE_TOKEN;
  process.env.STARRA_MCP_TOKEN = TOKEN;
  process.env.STARRA_MCP_WRITE_TOKEN = WRITE_TOKEN;
});
after(() => {
  if (saved === undefined) delete process.env.STARRA_MCP_TOKEN;
  else process.env.STARRA_MCP_TOKEN = saved;
  if (savedWrite === undefined) delete process.env.STARRA_MCP_WRITE_TOKEN;
  else process.env.STARRA_MCP_WRITE_TOKEN = savedWrite;
});

async function call(body: unknown, token?: string) {
  const res = await POST(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json().catch(() => null)) as never };
}

describe("MCP bridge — the vault stays locked", () => {
  it("refuses an unauthenticated caller", async () => {
    const r = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(r.status, 401);
  });

  it("refuses a wrong token", async () => {
    const r = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "not-the-token");
    assert.equal(r.status, 401);
  });

  it("FAILS CLOSED when no token is configured — absent must never mean open", async () => {
    const prev = process.env.STARRA_MCP_TOKEN;
    delete process.env.STARRA_MCP_TOKEN;
    const r = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "anything");
    process.env.STARRA_MCP_TOKEN = prev;
    assert.equal(r.status, 503);
  });

  it("refuses a token that is too short to be real", async () => {
    const prev = process.env.STARRA_MCP_TOKEN;
    process.env.STARRA_MCP_TOKEN = "short";
    const r = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "short");
    process.env.STARRA_MCP_TOKEN = prev;
    assert.equal(r.status, 503, "a weak token is treated as no token");
  });

  it("has NO way to dump everything — recall requires a real query", async () => {
    const r = await call(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "recall_memory", arguments: { query: "   " } },
      },
      TOKEN,
    );
    const text = (r.json as never as { result: { content: { text: string }[] } }).result.content[0].text;
    assert.match(text, /No query given/i);
  });

  it("the READ token cannot call remember — reading her is not rewriting her", async () => {
    const r = await call(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "remember", arguments: { role: "user", content: "planted by a stranger" } },
      },
      TOKEN,
    );
    assert.equal(r.status, 403, "the read key must not be able to edit what she believes");
  });

  it("the WRITE token can call remember", async () => {
    const r = await call(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "remember", arguments: { role: "user", content: "" } },
      },
      WRITE_TOKEN,
    );
    assert.equal(r.status, 200, "the write key is the one that may write");
  });

  it("with NO write token configured, remember is denied and recall survives", async () => {
    const prev = process.env.STARRA_MCP_WRITE_TOKEN;
    delete process.env.STARRA_MCP_WRITE_TOKEN;
    const write = await call(
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "remember", arguments: { role: "user", content: "x" } },
      },
      TOKEN,
    );
    const read = await call(
      {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: { name: "recall_memory", arguments: { query: "starra" } },
      },
      TOKEN,
    );
    process.env.STARRA_MCP_WRITE_TOKEN = prev;
    assert.equal(write.status, 403, "absent must never mean open");
    assert.equal(read.status, 200, "reads keep working — capability degrades, nothing opens");
  });

  it("even initialize needs a token — a stranger learns nothing about the bridge", async () => {
    const r = await call({ jsonrpc: "2.0", id: 14, method: "initialize", params: {} });
    assert.equal(r.status, 401);
  });

  it("exposes exactly two verbs — nothing that deletes or enumerates", async () => {
    const r = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" }, TOKEN);
    const names = (r.json as never as { result: { tools: { name: string }[] } }).result.tools.map(
      (t) => t.name,
    );
    assert.deepEqual(names.sort(), ["recall_memory", "remember"]);
  });
});

describe("MCP bridge — speaks the protocol", () => {
  it("initializes and echoes the client's protocol version", async () => {
    const r = await call(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      TOKEN,
    );
    const res = (r.json as never as { result: { protocolVersion: string; serverInfo: { name: string } } })
      .result;
    assert.equal(res.protocolVersion, "2025-06-18");
    assert.equal(res.serverInfo.name, "stargate-memory");
  });

  it("recalls from the SAME store the deck uses — one person, one memory", async () => {
    const r = await call(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "recall_memory", arguments: { query: "starra", limit: 3 } },
      },
      TOKEN,
    );
    const out = (r.json as never as { result: { content: { text: string }[] } }).result.content[0];
    assert.equal(typeof out.text, "string");
    assert.ok(out.text.length > 0);
  });

  it("caps the recall limit so one call cannot drain the store", async () => {
    const r = await call(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "recall_memory", arguments: { query: "a", limit: 9999 } },
      },
      TOKEN,
    );
    const text = (r.json as never as { result: { content: { text: string }[] } }).result.content[0].text;
    assert.ok(text.split("\n---\n").length <= 40, "limit must clamp to 40");
  });

  it("reports an unknown method rather than crashing", async () => {
    const r = await call({ jsonrpc: "2.0", id: 5, method: "nope/nope" }, TOKEN);
    const err = (r.json as never as { error: { code: number } }).error;
    assert.equal(err.code, -32601);
  });

  it("advertises the transport xAI requires", async () => {
    const res = await GET();
    const body = (await res.json()) as { transport: string; stateless: boolean };
    assert.equal(body.transport, "streamable-http");
    assert.equal(body.stateless, true);
  });
});
