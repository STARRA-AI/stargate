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
    // This used to be a blunt `!middleware.includes("mcp")`. It was protecting
    // HER OUTBOUND hands (src/lib/mcp — Playwright/Composio), which must never
    // be reachable without Classic's session. That intent stands.
    //
    // 2026-08-06 added an INBOUND MCP server at /api/mcp so xAI's Voice Agent
    // can call back into her memory — different direction, and it MUST be
    // publicly reachable because xAI's servers cannot hold his cookie. So the
    // check gets sharper instead of being deleted: /api/mcp is the ONLY mcp
    // path allowed past the cookie gate, and it has to carry its own lock.
    const mw = read("src/middleware.ts");
    const publicLine = /const PUBLIC_PREFIXES = \[([\s\S]*?)\]/.exec(mw)?.[1] ?? "";
    const mcpEntries = [...publicLine.matchAll(/"([^"]*mcp[^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(mcpEntries, ["/api/mcp"], "only the inbound memory bridge may be public");
    // /api/voice-tools is the other token-gated public door (same gate module,
    // same fail-closed rule). Asserted here so a third one cannot appear unnoticed.
    const publics = [...publicLine.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(publics, ["/api/auth", "/api/mcp", "/api/voice-tools", "/login", "/starra-ca.crt"],
      "every public path must be deliberate");

    const inbound = read("src/app/api/mcp/route.ts");
    assert.match(inbound, /STARRA_MCP_TOKEN/, "the public bridge must carry its own token");
    assert.match(inbound, /authorizePublic\(req, "read"\)/, "and gate EVERY method on it");
    assert.match(inbound, /503/, "and FAIL CLOSED when the token is unset");
    // 2026-08-07: the token check moved OUT of this route into one shared gate
    // so /api/mcp and /api/voice-tools cannot drift apart. The guarantees this
    // block used to read off the route source now live there — assert them at
    // their new home rather than deleting them.
    const gate = read("src/lib/api/public-auth.ts");
    assert.match(gate, /MIN_TOKEN_LENGTH = 24/, "a weak token is still rejected");
    assert.match(gate, /STARRA_MCP_WRITE_TOKEN/, "writes need their own key");
    assert.match(gate, /status: 503/, "an unset read token still fails closed");
    assert.ok(
      !/src\/lib\/mcp|parseMcpCommand|composio|playwright/i.test(inbound),
      "the public bridge must never reach her outbound hands",
    );
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
