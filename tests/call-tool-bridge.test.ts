/**
 * CALL <-> TOOL FAST-PATH BRIDGE (source-scan).
 *
 * useVoiceCall.ts is a CLIENT hook (runs in the browser). The TOOL FAST-PATH
 * CONTRACT requires exactly one implementation of the keyword/MCP fast-path,
 * living server-side in src/lib/tools/fastpath.ts, exposed to the browser
 * ONLY through POST /api/tools/fastpath. This test proves the wiring on the
 * client side of that contract without needing a live browser/WebSocket:
 *
 *   1. useVoiceCall.ts actually references the endpoint (it fires the tool
 *      fast-path on the call).
 *   2. useVoiceCall.ts does NOT import from src/lib/tools/* or src/lib/mcp/*
 *      — a client hook pulling in server-side tool/MCP modules would either
 *      break the browser bundle or smuggle server secrets into it.
 *
 * A comment saying "this only calls the HTTP endpoint" cannot fail. This can.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const HOOK_PATH = resolve(REPO, "src/lib/voice/useVoiceCall.ts");
const source = readFileSync(HOOK_PATH, "utf8");

/** Every runtime import specifier (static `from "..."`, `export ... from`,
 *  side-effect `import "..."`, and dynamic `import("...")`), same extraction
 *  approach as tests/bus-adoption-import-graph.test.ts. `import type` edges
 *  are erased at compile time and deliberately excluded. */
function importSpecifiers(code: string): string[] {
  const out: string[] = [];
  const stmt = /(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = stmt.exec(code))) {
    const clause = m[2] ?? "";
    if (/^type\b/.test(clause.trim())) continue;
    out.push(m[3]);
  }
  const bare = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  while ((m = bare.exec(code))) out.push(m[1]);
  const dyn = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dyn.exec(code))) out.push(m[1]);
  return out;
}

describe("useVoiceCall <-> tool fast-path bridge", () => {
  it("references POST /api/tools/fastpath", () => {
    assert.match(
      source,
      /\/api\/tools\/fastpath/,
      "useVoiceCall.ts should fire the tool fast-path endpoint on a final user transcript",
    );
  });

  it("posts {text} and reads back {handled, reply} from the endpoint", () => {
    // Loose shape check — proves the client speaks the contract's request/
    // response shape, not just the URL string.
    assert.match(source, /text:\s*t\b/, "expected a POST body carrying { text }");
    assert.match(source, /\.handled\b/, "expected the response's `handled` field to be read");
    assert.match(source, /\.reply\b/, "expected the response's `reply` field to be read");
  });

  // `assert.match` prints the ENTIRE 60KB hook as `actual` when it fails,
  // which buries the real message. These pin the same things via a boolean.
  const has = (re: RegExp, msg: string) => assert.ok(re.test(source), msg);

  it("delivers a handled reply through the ONE live-session injection path", () => {
    has(
      /deliverToolReply\(/,
      "the handled reply should be handed to deliverToolReply",
    );
    has(
      /const\s+injectLiveTurn\s*=\s*useCallback/,
      "there must be a single named injection function into the live session",
    );
    // No second speech path: the operator's typed-text entry point is a thin
    // wrapper over the SAME injector the tool path uses.
    has(
      /const\s+sendText\s*=\s*useCallback\(\s*\n?\s*\(text:\s*string\):\s*boolean\s*=>\s*injectLiveTurn\(/,
      "sendText must delegate to injectLiveTurn, not duplicate the ws sends",
    );
    assert.equal(
      (source.match(/type:\s*"response\.create"/g) ?? []).length,
      1,
      "exactly one place may open a realtime response — a second is a fork of the speech path",
    );
  });

  it("never logs a tool result as an operator turn (shared memory stays clean)", () => {
    // A tool result is machinery, not something Classic said. Logging it would
    // print a bracketed instruction in the call transcript AND POST it to
    // /api/memory as role:"user", burning a slot in the shared 24-turn window
    // that the Deck reads back (src/lib/memory/store.ts:67,104).
    has(
      /injectLiveTurn\(\s*payload\s*,\s*\{\s*log:\s*false\s*\}\s*\)/,
      "the tool path must inject with logging suppressed",
    );
    has(
      /opts\?\.log\s*!==\s*false/,
      "injectLiveTurn must gate transcript+memory writes on the log option",
    );
    // setTranscript/recordCallTurn for the injected user line exist in exactly
    // two places — the grok injector (injectLiveTurn) and the kimi brain turn
    // (runKimiTurn) — and BOTH sit inside the same `log` gate contract, so a
    // tool payload (log: false) can never be recorded as an operator turn on
    // either brain.
    // `t[,)]` — runKimiTurn now passes a third `supersede` argument (the
    // one-row-per-utterance guard, 2026-08-06), injectLiveTurn still passes
    // two. Both are still the same two sites, both still inside the log gate.
    assert.equal(
      (source.match(/recordCallTurn\("user",\s*t\s*[,)]/g) ?? []).length,
      2,
      "only the two log-gated paths may record an injected line as a user turn",
    );
    // Scoped rather than character-budgeted: the log gate's body grew when the
    // one-row-per-utterance supersede landed (2026-08-06), and a {0,400} window
    // would need re-tuning on every change. The invariant is positional — the
    // record must live INSIDE runKimiTurn's log gate, wherever the gate ends.
    const kimi = source.slice(
      source.indexOf("const runKimiTurn = useCallback"),
      source.indexOf("runKimiTurnRef.current = runKimiTurn"),
    );
    const logGate = kimi.indexOf("if (log) {");
    const record = kimi.indexOf('recordCallTurn("user", t');
    assert.ok(logGate >= 0, "runKimiTurn must have a log gate");
    assert.ok(
      record > logGate,
      "runKimiTurn's user record must sit inside its own log gate",
    );
  });

  it("never opens a second response while one is already in flight", () => {
    // commitUser fires from schedulePlayback — i.e. while her response IS
    // streaming. Sending response.create then is a protocol collision and the
    // tool reply is lost. Delivery must wait for a genuinely safe window.
    //
    // These conditions are asserted against the BODY of deliverToolReply only.
    // Scanning the whole hook would pass vacuously: the same guard expressions
    // legitimately appear in the playback/drain code (e.g. the
    // `activeSourcesRef.current.size === 0 && assistantResponseDoneRef.current`
    // drain check, and `if (!userTurnPendingRef.current) return;` in
    // commitUser). Verified by mutation — dropping a gate must fail this test.
    const start = source.indexOf("const deliverToolReply");
    assert.notEqual(start, -1, "deliverToolReply must exist");
    const end = source.indexOf("const fireToolFastpath", start);
    assert.ok(end > start, "deliverToolReply must sit before fireToolFastpath");
    const body = source.slice(start, end);

    for (const [re, what] of [
      [/assistantResponseDoneRef\.current\s*&&/, "her response must be finished"],
      [/activeSourcesRef\.current\.size\s*===\s*0/, "her audio must have drained"],
      [/!userTurnPendingRef\.current/, "Classic must not be mid-utterance"],
      [/s\s*===\s*"listening"\s*&&/, "the call must be idle in listening"],
      [/wsRef\.current\s*!==\s*ws/, "a reply must not leak into a later call's socket"],
    ] as const) {
      assert.ok(re.test(body), `tool-reply delivery gate must check: ${what}`);
    }
  });

  const specifiers = importSpecifiers(source);

  it("imports nothing from src/lib/tools/* (no server-side tool module in the client hook)", () => {
    const offenders = specifiers.filter((s) => /(^|\/)lib\/tools\//.test(s));
    assert.deepEqual(offenders, [], `unexpected tools import(s): ${offenders.join(", ")}`);
  });

  it("imports nothing from src/lib/mcp/* (no server-side MCP module in the client hook)", () => {
    const offenders = specifiers.filter((s) => /(^|\/)lib\/mcp\//.test(s));
    assert.deepEqual(offenders, [], `unexpected mcp import(s): ${offenders.join(", ")}`);
  });

  it("never names maybeToolReply, parseMcpCommand, callMcpTool, or listMcpServers directly", () => {
    // The one-implementation rule: those symbols belong to the server-side
    // fastpath module and must only be reached through the HTTP endpoint.
    assert.doesNotMatch(
      source,
      /\b(maybeToolReply|parseMcpCommand|callMcpTool|listMcpServers)\b/,
      "client hook must consume the tool fast-path only via /api/tools/fastpath, never a direct symbol import",
    );
  });
});
