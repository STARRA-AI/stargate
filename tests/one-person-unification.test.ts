/**
 * ONE PERSON — Classic's order (2026-07-30): "everything needs to be ONE
 * persistent AI across everything... same voice which is the british sounding
 * one she's using on the call" — and subagents only when he asks.
 *
 * What that means in this codebase, pinned on the source so it cannot regress:
 *
 *   1. ONE VOICE = eve. The call already sends voice:"eve"; the TTS route's
 *      default is eve too, and the Web Speech fallback prefers an English
 *      female (closest to eve) over the old Japanese rung.
 *   2. ONE MEMORY. The call leg reads the same continuity digest the chat
 *      brain uses (api/memory?digest=1 → memoryForPrompt) and writes finished
 *      turns back through POST /api/memory → recordExchange — the exact
 *      function api/chat already calls. The chat UI seeds its visible history
 *      from that store on boot.
 *   3. ONE SESSION FOR IN-CALL TEXT. Typing during a live call injects into
 *      the realtime session (conversation.item.create) so the call itself
 *      answers; the brain+TTS path is the fallback, not the default.
 *   4. THE PERSONALITY BUDGET HOLDS. STARRA_PERSONALITY.md must fit inside
 *      brain.ts's PERSONALITY_CHAR_BUDGET — text past the clip point silently
 *      never loads, which is how a "locked" rule quietly dies.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

describe("one voice — eve everywhere", () => {
  it("api/tts defaults to eve (env still overrides)", () => {
    const src = read("src/app/api/tts/route.ts");
    assert.match(src, /process\.env\.XAI_TTS_VOICE\s*\|\|\s*"eve"/);
  });

  it("the realtime call is eve", () => {
    assert.match(read("src/lib/voice/useVoiceCall.ts"), /voice:\s*"eve"/);
  });

  it("Web Speech fallback prefers an English female over the Japanese rung", () => {
    const src = read("src/lib/voice/voice-select.ts");
    const pick = src.slice(src.indexOf("export function pickStarraVoice"));
    const enFemaleAt = pick.indexOf("EN_FEMALE_HINTS.some");
    const jaAt = pick.indexOf("JA_FEMALE, \"ja\"");
    assert.ok(enFemaleAt > 0 && jaAt > 0, "both rungs must exist");
    assert.ok(
      enFemaleAt < jaAt,
      "any-English-female must outrank the Japanese fallback",
    );
  });
});

describe("one memory — call and chat share the store", () => {
  it("api/memory exposes the digest and the write path", () => {
    const src = read("src/app/api/memory/route.ts");
    assert.match(src, /memoryForPrompt/);
    assert.match(src, /export async function POST/);
    assert.match(src, /recordExchange/);
  });

  it("the call fetches the digest and extends her instructions with it", () => {
    const src = read("src/lib/voice/useVoiceCall.ts");
    assert.match(src, /\/api\/memory\?digest=1/);
    assert.match(src, /SHARED MEMORY/);
  });

  it("the call records finished turns into the store", () => {
    const src = read("src/lib/voice/useVoiceCall.ts");
    const calls = src.match(/recordCallTurn\(/g) ?? [];
    // definition + user commit + assistant commit + typed injection ≥ 4 sites
    assert.ok(
      calls.length >= 4,
      `expected recordCallTurn wired at every commit point, saw ${calls.length}`,
    );
  });

  it("the chat UI seeds visible history from the store on boot", () => {
    const src = read("src/lib/stargate-context.tsx");
    assert.match(src, /fetch\("\/api\/memory"\)/);
    assert.match(src, /prev\.length === 0 \? seed : prev/);
  });
});

describe("one session — typed messages ride the live call", () => {
  it("sendText injects via conversation.item.create + response.create", () => {
    const src = read("src/lib/voice/useVoiceCall.ts");
    assert.match(src, /conversation\.item\.create/);
    assert.match(src, /response\.create/);
  });

  it("the overlay prefers the live call and falls back to the brain", () => {
    const src = read("src/components/bridge/VoiceCallOverlay.tsx");
    assert.match(
      src,
      /if \(sendText\(t\)\) return;\s*\n\s*void sendMessage\(t\);/,
    );
  });
});

describe("recall depth — the store carries enough to actually remember", () => {
  it("the working window is at least 20 exchanges (was 10 — the shallow-recall bug)", async () => {
    const { WORKING_WINDOW } = await import("../src/lib/memory/store");
    assert.ok(
      WORKING_WINDOW >= 20,
      `WORKING_WINDOW is ${WORKING_WINDOW} — shrinking it below 20 reintroduces "she can't recall things"`,
    );
  });

  it("memoryForPrompt renders working NEWEST first, so truncation drops the oldest", async () => {
    const { memoryForPrompt } = await import("../src/lib/memory/store");
    const store = {
      working: [
        { role: "user" as const, content: "OLDEST-MARKER", at: "t0" },
        { role: "assistant" as const, content: "middle", at: "t1" },
        { role: "user" as const, content: "NEWEST-MARKER", at: "t2" },
      ],
      summaries: [],
      archival: [],
      facts: [],
    };
    const block = memoryForPrompt(store, "");
    const newestAt = block.indexOf("NEWEST-MARKER");
    const oldestAt = block.indexOf("OLDEST-MARKER");
    assert.ok(newestAt > 0 && oldestAt > 0, "both markers must render");
    assert.ok(
      newestAt < oldestAt,
      "newest exchange must come first — both consumers truncate from the tail",
    );
  });

  it("recordExchange rolls overflow at WORKING_WINDOW, not a stale hardcoded 10", () => {
    const src = read("src/lib/memory/store.ts");
    assert.match(src, /store\.working\.length > WORKING_WINDOW/);
    assert.ok(
      !/working\.length > 10\b/.test(src),
      "hardcoded window survived the WORKING_WINDOW extraction",
    );
  });
});

describe("xhigh review findings — each confirmed defect stays dead", () => {
  it("memory writes are serialized through one chain (no lost turns)", () => {
    const src = read("src/lib/memory/store.ts");
    assert.match(src, /memoryWriteChain/);
    assert.match(src, /const p = memoryWriteChain\.then\(run, run\)/);
  });

  it("archival recall matches by significant words, not a 24-char prefix", async () => {
    const { memoryForPrompt } = await import("../src/lib/memory/store");
    const store = {
      working: [],
      summaries: [],
      archival: [
        { id: "a1", text: "user: we picked the DUNS number route | assistant: filed it", at: "t0" },
        { id: "a2", text: "user: pizza tonight | assistant: sure", at: "t1" },
      ],
      facts: [],
    };
    const block = memoryForPrompt(store, "what did we decide about the DUNS number yesterday?");
    assert.ok(block.includes("DUNS number route"), "word match must surface the old exchange");
    assert.ok(!block.match(/Archival hits \(0\)/), "archival tier must not be dead");
  });

  it("the call waits briefly for the digest and re-sends it when late", () => {
    const src = read("src/lib/voice/useVoiceCall.ts");
    assert.match(src, /memoryDigestPromiseRef/);
    assert.match(src, /Promise\.race\(/);
    assert.match(src, /sentWithDigest/);
  });

  it("call-turn writes keep their order (client-side chain)", () => {
    assert.match(read("src/lib/voice/useVoiceCall.ts"), /recordCallChain/);
  });

  it("a reconnect never wipes the visible transcript", () => {
    assert.match(
      read("src/lib/voice/useVoiceCall.ts"),
      /if \(stateRef\.current !== "reconnecting"\) setTranscript\(\[\]\);/,
    );
  });

  it("the call column is chronological: history before live transcript", () => {
    const src = read("src/components/bridge/VoiceCallOverlay.tsx");
    const historyAt = src.indexOf("...history.map");
    const transcriptAt = src.indexOf("...transcript.map");
    assert.ok(historyAt > 0 && transcriptAt > 0);
    assert.ok(historyAt < transcriptAt, "history must render above the live call turns");
  });
});

describe("the eye cam is gone (Classic's order — no pointless camera data)", () => {
  it("ReactorEye is deleted and unreferenced", () => {
    assert.ok(!existsSync(join(REPO, "src/components/bridge/ReactorEye.tsx")));
    // Comments stripped: the removal note may NAME it; code may not touch it.
    const codeOnly = read("src/components/bridge/Bridge.tsx")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!codeOnly.includes("ReactorEye"));
  });
});

describe("the locked rules actually load", () => {
  it("STARRA_PERSONALITY.md fits the brain's clip budget", () => {
    const size = Buffer.byteLength(read("STARRA_PERSONALITY.md"), "utf8");
    const brain = read("src/lib/brain.ts");
    const m = brain.match(/PERSONALITY_CHAR_BUDGET\s*=\s*(\d+)/);
    assert.ok(m, "PERSONALITY_CHAR_BUDGET must exist in brain.ts");
    const budget = Number(m![1]);
    assert.ok(
      size <= budget,
      `STARRA_PERSONALITY.md is ${size} chars but the budget is ${budget} — the tail (locked rules) would silently never load`,
    );
  });

  it("persona.ts carries the locked memory/privacy/agents/pacing rules", () => {
    const src = read("src/lib/persona.ts");
    for (const marker of [
      "MEMORY & PRIVACY (LOCKED)",
      "warm and SLOW",
      "never tacked on after every sentence",
      "never deploy subagents",
    ]) {
      assert.ok(src.includes(marker), `persona.ts must contain: ${marker}`);
    }
  });

  it("the avatar app's prompt stays in sync on the locked rules", () => {
    // The avatar app lives outside this repo on this machine; when present it
    // must carry the same locked markers (persona.ts's own sync rule).
    const p = "/Users/work/Desktop/STARGATE/starra-avatar/personality/system_prompt.txt";
    if (!existsSync(p)) return; // absent on other machines — nothing to check
    const txt = readFileSync(p, "utf8");
    for (const marker of [
      "MEMORY & PRIVACY (LOCKED)",
      "warm and SLOW",
      "never deploy subagents",
    ]) {
      assert.ok(txt.includes(marker), `avatar prompt must contain: ${marker}`);
    }
  });
});
