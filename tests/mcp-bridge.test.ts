/**
 * MCP BRIDGE — her hands on Playwright + Composio. Pure command grammar
 * tested directly; structural safety pinned on the source.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseMcpCommand } from "../src/lib/mcp/commands";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

describe("parseMcpCommand — exact grammar, total", () => {
  it("lists, browses, and calls", () => {
    assert.deepEqual(parseMcpCommand("mcp tools"), { kind: "list" });
    assert.deepEqual(parseMcpCommand("browse trustmrr.com"), {
      kind: "browse",
      url: "https://trustmrr.com",
    });
    assert.deepEqual(
      parseMcpCommand('mcp playwright browser_navigate {"url":"https://x.com"}'),
      {
        kind: "call",
        server: "playwright",
        tool: "browser_navigate",
        args: { url: "https://x.com" },
      },
    );
    assert.deepEqual(parseMcpCommand("mcp composio GMAIL_SEND"), {
      kind: "call",
      server: "composio",
      tool: "GMAIL_SEND",
      args: {},
    });
  });

  it("rejects junk instead of guessing", () => {
    assert.equal(parseMcpCommand("hey how are you"), null);
    assert.equal(parseMcpCommand("mcp playwright tool {not json}"), null);
    assert.equal(parseMcpCommand("browse not a url with spaces"), null);
    assert.equal(parseMcpCommand(undefined as unknown as string), null);
  });
});

describe("bridge discipline, on the source", () => {
  it("stays behind the auth gate; every call has a timeout; failures are captured", () => {
    assert.ok(!read("src/middleware.ts").includes("mcp"));
    const client = read("src/lib/mcp/client.ts");
    assert.match(client, /CALL_TIMEOUT_MS = 30_000/);
    assert.match(client, /captureError\(`mcp:/);
  });

  it("composio never fakes: dark until BOTH env vars exist", () => {
    const client = read("src/lib/mcp/client.ts");
    assert.match(client, /if \(url && key\)/);
    assert.match(client, /COMPOSIO_MCP_URL/);
    assert.match(client, /configured: false/);
  });

  it(".mcp.json carries env REFS, never secret values", () => {
    const cfg = read(".mcp.json");
    assert.match(cfg, /\$\{COMPOSIO_MCP_URL\}/);
    assert.match(cfg, /\$\{COMPOSIO_API_KEY\}/);
    assert.ok(!/x-api-key":\s*"[^$]/.test(cfg), "no literal key material");
  });

  it("the chat brain exposes the fast-paths and stays call-independent", () => {
    // Same intent as before, following the code to its new home: the MCP
    // fast-path branches moved OUT of the chat route into the one shared
    // module (src/lib/tools/fastpath.ts) so the voice call can reach the
    // identical implementation through POST /api/tools/fastpath. The chat
    // brain still exposes them — by importing that module, not by owning a
    // private copy — and still knows nothing about the call.
    const route = read("src/app/api/chat/route.ts");
    const shared = read("src/lib/tools/fastpath.ts");
    assert.match(route, /import\s*\{[^}]*\bmaybeToolReply\b[^}]*\}\s*from\s*["']@\/lib\/tools\/fastpath["']/);
    assert.match(route, /await\s+maybeToolReply\s*\(/);
    assert.match(shared, /parseMcpCommand/);
    assert.match(shared, /browser_snapshot/);
    // Call-independent: the server brain must not reach into the client hook.
    assert.ok(
      !/useVoiceCall|realtime session|conversation\.item\.create/.test(route),
      "the chat route must stay independent of the voice call",
    );
  });
});
