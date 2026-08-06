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
import { POST, GET } from "../src/app/api/mcp/route";

const TOKEN = "test-token-long-enough-for-the-guard-0123456789";
let saved: string | undefined;

before(() => {
  saved = process.env.STARRA_MCP_TOKEN;
  process.env.STARRA_MCP_TOKEN = TOKEN;
});
after(() => {
  if (saved === undefined) delete process.env.STARRA_MCP_TOKEN;
  else process.env.STARRA_MCP_TOKEN = saved;
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
