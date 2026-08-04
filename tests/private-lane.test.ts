/**
 * Private lane — `private …` command parser.
 *
 * The parser is the gate that decides whether a turn NEVER leaves this Mac.
 * A false negative leaks a private ask to a hosted provider, so the boundary
 * cases (`privateer`, bare `private`) are load-bearing, not cosmetic.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePrivateCommand } from "../src/lib/private/commands";
import {
  buildUserTurn,
  classifyChatFrame,
  withoutPrivateTurns,
  type Msg,
} from "../src/lib/stargate-context";

describe("parsePrivateCommand — chat", () => {
  it("strips a whitespace-separated `private` prefix", () => {
    assert.deepEqual(parsePrivateCommand("private what is the code?"), {
      kind: "chat",
      text: "what is the code?",
    });
  });

  it("strips a colon-separated `private:` prefix", () => {
    assert.deepEqual(parsePrivateCommand("private: what is the code?"), {
      kind: "chat",
      text: "what is the code?",
    });
    assert.deepEqual(parsePrivateCommand("private:what is the code?"), {
      kind: "chat",
      text: "what is the code?",
    });
  });

  it("is case-insensitive on the prefix only", () => {
    assert.deepEqual(parsePrivateCommand("PRIVATE Whats the plan"), {
      kind: "chat",
      text: "Whats the plan",
    });
    assert.deepEqual(parsePrivateCommand("PrIvAtE: Whats the plan"), {
      kind: "chat",
      text: "Whats the plan",
    });
  });

  it("tolerates leading/trailing whitespace around the whole ask", () => {
    assert.deepEqual(parsePrivateCommand("   private   hold this   "), {
      kind: "chat",
      text: "hold this",
    });
  });

  it("keeps multi-line asks intact", () => {
    assert.deepEqual(parsePrivateCommand("private summarize:\nline two"), {
      kind: "chat",
      text: "summarize:\nline two",
    });
  });
});

describe("parsePrivateCommand — non-matches", () => {
  it("does NOT match a word that merely starts with `private`", () => {
    assert.equal(parsePrivateCommand("privateer stories"), null);
    assert.equal(parsePrivateCommand("privately, I disagree"), null);
    assert.equal(parsePrivateCommand("private-gpt is running"), null);
  });

  it("does NOT match `private` mid-sentence", () => {
    assert.equal(parsePrivateCommand("keep this private please"), null);
  });

  it("returns null for a bare prefix with no ask", () => {
    assert.equal(parsePrivateCommand("private"), null);
    assert.equal(parsePrivateCommand("private "), null);
    assert.equal(parsePrivateCommand("private:"), null);
    assert.equal(parsePrivateCommand("private:   "), null);
  });

  it("returns null for empty / non-string input", () => {
    assert.equal(parsePrivateCommand(""), null);
    assert.equal(parsePrivateCommand("   "), null);
    assert.equal(
      parsePrivateCommand(undefined as unknown as string),
      null,
    );
    assert.equal(parsePrivateCommand(null as unknown as string), null);
  });
});

describe("parsePrivateCommand — docs", () => {
  it("matches `private docs` exactly", () => {
    assert.deepEqual(parsePrivateCommand("private docs"), { kind: "docs" });
    assert.deepEqual(parsePrivateCommand("private: docs"), { kind: "docs" });
    assert.deepEqual(parsePrivateCommand("  PRIVATE DOCS  "), {
      kind: "docs",
    });
  });

  it("treats `docs`-prefixed prose as a chat ask, not a listing", () => {
    assert.deepEqual(parsePrivateCommand("private documents"), {
      kind: "chat",
      text: "documents",
    });
    assert.deepEqual(parsePrivateCommand("private docs about taxes"), {
      kind: "chat",
      text: "docs about taxes",
    });
  });
});

describe("parsePrivateCommand — ingest", () => {
  it("takes an absolute path", () => {
    assert.deepEqual(
      parsePrivateCommand("private ingest /Users/work/notes/tax.txt"),
      { kind: "ingest", path: "/Users/work/notes/tax.txt" },
    );
  });

  it("takes a ~ path verbatim (expansion is the route's job, not the parser's)", () => {
    assert.deepEqual(parsePrivateCommand("private ingest ~/Desktop/a.md"), {
      kind: "ingest",
      path: "~/Desktop/a.md",
    });
  });

  it("is case-insensitive on the subcommand and accepts the colon form", () => {
    assert.deepEqual(parsePrivateCommand("private: INGEST /tmp/a.txt"), {
      kind: "ingest",
      path: "/tmp/a.txt",
    });
  });

  it("strips matched surrounding quotes so paths with spaces survive", () => {
    assert.deepEqual(
      parsePrivateCommand('private ingest "/Users/work/my notes.txt"'),
      { kind: "ingest", path: "/Users/work/my notes.txt" },
    );
    assert.deepEqual(
      parsePrivateCommand("private ingest '/Users/work/my notes.txt'"),
      { kind: "ingest", path: "/Users/work/my notes.txt" },
    );
  });

  it("falls back to a private chat ask when no path follows", () => {
    assert.deepEqual(parsePrivateCommand("private ingest"), {
      kind: "chat",
      text: "ingest",
    });
  });
});

/**
 * The private branch must write NOTHING to the shared memory store.
 *
 * This is not paranoia about a local file — data/memory.json is an INPUT to
 * later HOSTED prompts, on two verified roads:
 *   recordExchange -> data/memory.json (src/lib/memory/store.ts:85,46)
 *     -> getMemory -> memoryForPrompt (route.ts) -> the system prompt
 *     -> Kimi/Grok/FreeLLM/Anthropic
 *   the same store -> callDigest (src/app/api/memory/route.ts:18-20)
 *     -> src/lib/voice/useVoiceCall.ts:1898-1902 -> xAI session instructions
 * So a recorded private turn does not stay private; it leaks on the NEXT
 * normal turn or the next call. These assertions look at CALLS, not mentions —
 * the branch's own comments name both functions to explain why they're absent.
 */
describe("private lane — writes nothing to the shared memory store", () => {
  const routeSrc = async () => {
    const { readFile } = await import("node:fs/promises");
    return readFile(
      new URL("../src/app/api/chat/route.ts", import.meta.url),
      "utf8",
    );
  };

  /** Strip block + line comments so prose mentions can't mask a real call. */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  /**
   * Everything from the PRIVATE LANE banner up to the POST handler. The slice
   * starts at the `/*` that OPENS the banner comment, not at the banner text
   * inside it — otherwise the stripper can't see the comment's opening token
   * and the branch's own explanatory prose reads as code.
   */
  const privateBranch = (src: string) => {
    const banner = src.indexOf("PRIVATE LANE");
    const start = src.lastIndexOf("/*", banner);
    const end = src.indexOf("export async function POST");
    assert.ok(banner > 0, "PRIVATE LANE banner not found in route.ts");
    assert.ok(start > 0, "banner's opening block comment not found");
    assert.ok(end > start, "POST handler not found after the private branch");
    const slice = src.slice(start, end);
    // Guard the guard: a bad slice must fail loudly, not pass vacuously.
    assert.ok(
      slice.includes("privateLaneResponse"),
      "sliced private branch does not contain privateLaneResponse",
    );
    return slice;
  };

  it("never calls recordExchange", async () => {
    const branch = stripComments(privateBranch(await routeSrc()));
    assert.equal(
      /\brecordExchange\s*\(/.test(branch),
      false,
      "private turns must not be written to the shared memory store — it feeds hosted prompts",
    );
  });

  it("never calls extractFactsFromExchange", async () => {
    const branch = stripComments(privateBranch(await routeSrc()));
    assert.equal(
      /\bextractFactsFromExchange\s*\(/.test(branch),
      false,
      "the fact distiller posts the exchange to Groq/Kimi (src/lib/memory/extract.ts:54-55)",
    );
  });

  it("never reaches a hosted provider or an external lookup", async () => {
    const branch = stripComments(privateBranch(await routeSrc()));
    for (const forbidden of [
      "streamHosted",
      "hostedAvailable",
      "streamAnthropicCached",
      "runAnthropicAgent",
      "getWeather",
      "webSearch",
      "maybeShellReply",
      "maybeToolReply",
    ]) {
      assert.equal(
        new RegExp(`\\b${forbidden}\\s*\\(`).test(branch),
        false,
        `private branch must not call ${forbidden}`,
      );
    }
  });

  it("still records NON-private turns (the removal is scoped, not global)", async () => {
    const src = await routeSrc();
    const mainPath = stripComments(
      src.slice(src.indexOf("export async function POST")),
    );
    assert.equal(
      /\brecordExchange\s*\(/.test(mainPath),
      true,
      "the normal lane must keep its memory writes",
    );
  });
});

/**
 * The client's silence gate (Task 3) only works if the marker is genuinely
 * the FIRST thing the private branch ever enqueues — a marker that can arrive
 * after even one text frame protects nothing, because the client has already
 * started speaking/rendering before it reads the flag.
 */
describe("private lane — first-frame contract", () => {
  it('emits `{"private": true}` as the very first frame, before any text', async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../src/app/api/chat/route.ts", import.meta.url),
      "utf8",
    );
    const banner = src.indexOf("PRIVATE LANE");
    const start = src.lastIndexOf("/*", banner);
    const end = src.indexOf("export async function POST");
    assert.ok(banner > 0, "PRIVATE LANE banner not found in route.ts");
    assert.ok(start > 0, "banner's opening block comment not found");
    assert.ok(end > start, "POST handler not found after the private branch");
    const branch = src
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    const markerIdx = branch.search(
      /sseFrame\(\s*\{\s*private:\s*true\s*\}\s*\)/,
    );
    assert.ok(
      markerIdx >= 0,
      'route.ts must enqueue sseFrame({ private: true }) inside the private branch',
    );

    const firstPushIdx = branch.indexOf("push(c)");
    assert.ok(
      firstPushIdx < 0 || markerIdx < firstPushIdx,
      "the private marker must be enqueued before any text frame is pushed",
    );
  });
});

describe("private lane parser — macOS 12 WebKit safety", () => {
  it("contains no regex lookbehind (client may import this module)", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../src/lib/private/commands.ts", import.meta.url),
      "utf8",
    );
    assert.equal(
      /\(\?<[=!]/.test(src),
      false,
      "lookbehind assertions crash Safari/WebKit on macOS 12",
    );
  });
});

/* ───────────────────────── TASK 3 — CLIENT SILENCE GATES ─────────────────────
 * The route's half of the contract is a marker: `data: {"private": true}` is
 * the FIRST frame of every private reply (src/app/api/chat/route.ts:603-604).
 * A marker nobody reads protects nothing, so the two clients that consume
 * /api/chat — the deck chat (stargate-context.tsx) and the live call
 * (useVoiceCall.ts) — must both classify it and go silent for that turn.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("classifyChatFrame — the SSE silence marker", () => {
  it("classifies the private marker frame", () => {
    assert.deepEqual(classifyChatFrame(JSON.stringify({ private: true })), {
      kind: "private",
    });
  });

  it("classifies a text delta", () => {
    assert.deepEqual(classifyChatFrame(JSON.stringify({ text: "hi" })), {
      kind: "text",
      text: "hi",
    });
  });

  it("takes `private` over `text` if a frame ever carried both", () => {
    // The safe direction is silence: a frame that says private is private,
    // whatever else rides on it.
    assert.deepEqual(
      classifyChatFrame(JSON.stringify({ private: true, text: "leak" })),
      { kind: "private" },
    );
  });

  it("demands a literal `true` — a truthy lookalike is not the marker", () => {
    assert.deepEqual(classifyChatFrame(JSON.stringify({ private: "true" })), {
      kind: "ignore",
    });
    assert.deepEqual(classifyChatFrame(JSON.stringify({ private: 1 })), {
      kind: "ignore",
    });
    assert.deepEqual(classifyChatFrame(JSON.stringify({ private: false })), {
      kind: "ignore",
    });
  });

  it("ignores [DONE], empty payloads and malformed frames", () => {
    for (const payload of ["[DONE]", "", "   ", "{", "not json", "null", "[]"]) {
      assert.deepEqual(
        classifyChatFrame(payload),
        { kind: "ignore" },
        `payload ${JSON.stringify(payload)} must be inert`,
      );
    }
  });

  it("ignores an empty text delta, exactly like the old `if (json.text)`", () => {
    assert.deepEqual(classifyChatFrame(JSON.stringify({ text: "" })), {
      kind: "ignore",
    });
    assert.deepEqual(classifyChatFrame(JSON.stringify({ text: 7 })), {
      kind: "ignore",
    });
  });
});

describe("withoutPrivateTurns — the outbound-body filter", () => {
  it("drops private-marked turns and keeps the order of the rest", () => {
    const history: Msg[] = [
      { role: "user", content: "hey" },
      { role: "assistant", content: "hey back" },
      { role: "user", content: "private what is the code", private: true },
      { role: "assistant", content: "the code is 1234", private: true },
      { role: "user", content: "what's the weather" },
    ];
    assert.deepEqual(withoutPrivateTurns(history), [
      { role: "user", content: "hey" },
      { role: "assistant", content: "hey back" },
      { role: "user", content: "what's the weather" },
    ]);
  });

  it("keeps every turn when none is marked (the normal lane is untouched)", () => {
    const history: Msg[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    assert.deepEqual(withoutPrivateTurns(history), history);
  });

  it("does not mutate the visible history it is given", () => {
    const history: Msg[] = [
      { role: "user", content: "secret", private: true },
      { role: "user", content: "public" },
    ];
    withoutPrivateTurns(history);
    assert.equal(history.length, 2, "visible history keeps private turns");
    assert.equal(history[0].private, true);
  });
});

/** Strip block + line comments so prose mentions can't mask a real call. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const readSrc = async (rel: string) => {
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL(`../${rel}`, import.meta.url), "utf8");
};

/** Slice [from, to) and prove the slice is real, so a rename fails loudly. */
const between = (src: string, from: string, to: string) => {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start + from.length);
  assert.ok(start >= 0, `slice start not found: ${from}`);
  assert.ok(end > start, `slice end not found after start: ${to}`);
  return src.slice(start, end);
};

describe("silence gate — deck chat (stargate-context.tsx)", () => {
  const CTX = "src/lib/stargate-context.tsx";

  it("strips private turns out of every /api/chat body", async () => {
    const src = stripComments(await readSrc(CTX));
    assert.match(
      src,
      /messages: \[\s*\.\.\.withoutPrivateTurns\(priorHistory\),/,
      "PRIOR private turns must be stripped from the outbound body",
    );
    assert.equal(
      /withoutPrivateTurns\(nextHistory\)/.test(src),
      false,
      "filtering nextHistory strips the ask being asked — but the route needs that exact string to route the turn locally (route.ts:713-725)",
    );
    assert.match(
      src,
      /\{ role: "user", content: trimmed \},\s*\]/,
      "the current ask must still be sent, and sent UNMARKED (a `private: true` key is noise on the wire)",
    );
  });

  it("never hands a private reply to the TTS path", async () => {
    const branch = stripComments(
      between(await readSrc(CTX), "if (privateTurn) {", 'setHudState("speaking")'),
    );
    assert.equal(
      /\bspeakStarra\s*\(/.test(branch),
      false,
      "speakStarra POSTs the text to /api/tts, which sends it to xAI",
    );
    assert.equal(
      /\bimport\s*\(\s*["']@\/lib\/voice\/speak["']\s*\)/.test(branch),
      false,
      "a private reply must not even load the TTS module",
    );
  });

  it("releases the reveal gate so private text is never held back", async () => {
    const branch = stripComments(
      between(await readSrc(CTX), "if (privateTurn) {", 'setHudState("speaking")'),
    );
    assert.match(
      branch,
      /gate\.release\("silent"\)/,
      'the G3 gate must release on the existing "silent" reason — nothing waits on audio that will never play',
    );
  });

  it("logs the private landing line", async () => {
    const src = await readSrc(CTX);
    assert.match(src, /\[ORACLE\] private reply landed · local only/);
  });

  it("marks BOTH sides of a private turn in visible history", async () => {
    const branch = stripComments(
      between(await readSrc(CTX), "if (privateTurn) {", 'setHudState("speaking")'),
    );
    assert.match(branch, /private: true/, "the assistant commit carries the mark");
    assert.match(
      branch,
      /role: "assistant", content: full, private: true/,
      "the reply enters history marked, so the next turn's body filter sees it",
    );
  });

  /**
   * THE ABORT LEAK (fix wave 2). Marking the ask only after the read loop
   * finishes is not enough: `private what's my SSN` -> marker frame -> he hits
   * stop (or a barge-in / the next message calls abortTurn) -> AbortError ->
   * the ask sits in history UNMARKED -> the next NORMAL turn's body filter does
   * not strip it -> the literal private ask POSTs to the hosted brain.
   *
   * The mark therefore has to exist BEFORE anything can abort — which means it
   * cannot come from the stream at all. It comes from the parser, up front, the
   * same way the call's `privateAsk` does.
   */
  it("marks the ask at COMMIT time, before any fetch can abort", async () => {
    const src = stripComments(await readSrc(CTX));
    const classified = src.indexOf("buildUserTurn(trimmed)");
    const committed = src.indexOf("setHistory(nextHistory)");
    const fetched = src.indexOf('fetch("/api/chat"');
    assert.ok(classified > 0, "the ask must be classified by the parser up front");
    assert.ok(
      classified < committed,
      "classification must precede the commit to history",
    );
    assert.ok(
      committed < fetched,
      "…and the whole decision must precede the fetch that can abort",
    );
  });

  it("does not depend on the marker frame to mark the ask", async () => {
    const src = stripComments(await readSrc(CTX));
    // `privateTurn` is the marker-frame flag. If the ONLY place the user turn
    // gets marked is behind it, every abort/error path leaks the ask.
    const commitSite = between(src, "const userMsg", "setStreaming(\"\")");
    assert.equal(
      /privateTurn/.test(commitSite),
      false,
      "the commit site must not consult the stream flag — the stream may never finish",
    );
    assert.match(
      commitSite,
      /buildUserTurn/,
      "the commit site must carry the mark itself",
    );
  });
});

/**
 * The up-front classification, as a unit. This is what makes the abort path
 * safe, and it is provable without a fetch, a stream or a React tree: the mark
 * is a function of the TEXT, never of how the turn ended.
 */
describe("buildUserTurn — the ask is classified before it is committed", () => {
  it("marks a private ask", () => {
    assert.deepEqual(buildUserTurn("private what is my SSN"), {
      role: "user",
      content: "private what is my SSN",
      private: true,
    });
  });

  it("defers to the parser, so every prefix form is covered", () => {
    assert.equal(buildUserTurn("private: what is my SSN").private, true);
    assert.equal(buildUserTurn("PRIVATE docs").private, true);
    assert.equal(buildUserTurn("private ingest /tmp/a.txt").private, true);
  });

  it("leaves a normal ask byte-identical to today's — no `private` key at all", () => {
    const turn = buildUserTurn("what's the weather");
    assert.deepEqual(turn, { role: "user", content: "what's the weather" });
    assert.equal(
      "private" in turn,
      false,
      "an absent key, not `private: undefined` — the normal lane must not change shape",
    );
  });

  it("does not mark a word that merely starts with `private`", () => {
    assert.equal("private" in buildUserTurn("privateer stories"), false);
    assert.equal("private" in buildUserTurn("keep this private please"), false);
    assert.equal("private" in buildUserTurn("private"), false); // bare prefix
  });

  it("survives the abort scenario by construction", () => {
    // No stream, no marker frame, no completion — and the ask is already
    // stripped from anything bound for a hosted brain.
    const turn = buildUserTurn("private what is my SSN");
    assert.deepEqual(withoutPrivateTurns([turn]), []);
  });
});

describe("silence gate — live call (useVoiceCall.ts)", () => {
  const HOOK = "src/lib/voice/useVoiceCall.ts";

  /** runKimiTurn's body — the only user-commit path on a kimi call. */
  const kimiTurn = async () =>
    between(
      await readSrc(HOOK),
      "const runKimiTurn = useCallback(",
      "runKimiTurnRef.current = runKimiTurn;",
    );

  it("decides the ask is private BEFORE the optimistic user commit", async () => {
    const body = stripComments(await kimiTurn());
    const decided = body.indexOf("parsePrivateCommand(t)");
    const committed = body.indexOf('recordCallTurn("user", t)');
    assert.ok(decided >= 0, "runKimiTurn must classify the ask itself");
    assert.ok(
      decided < committed,
      "recordCallTurn fires before the fetch — a POST cannot be recalled once the marker frame arrives",
    );
  });

  it("keeps a private ask out of the store and out of the hosted context", async () => {
    const body = stripComments(await kimiTurn());
    assert.match(
      body,
      /if \(!privateAsk\) \{[\s\S]{0,200}?recordCallTurn\("user", t\);[\s\S]{0,200}?callTurnsRef\.current\.push\(\{ role: "user", text: t \}\);/,
      "both the shared-store write and the hosted-bound context push must sit behind the private guard",
    );
  });

  it("never speaks a private reply and never stores it", async () => {
    const src = await readSrc(HOOK);
    const branch = stripComments(
      between(src, "if (privateReply) {", "speakForced(spoken, reply);"),
    );
    for (const forbidden of ["speakForced", "recordCallTurn"]) {
      assert.equal(
        new RegExp(`\\b${forbidden}\\s*\\(`).test(branch),
        false,
        `the private reply branch must not call ${forbidden} — force_message hands text to the xAI socket, recordCallTurn to the shared store`,
      );
    }
    assert.equal(
      /callTurnsRef\.current\.push\s*\(/.test(branch),
      false,
      "callTurnsRef rides later /api/chat bodies to the hosted Kimi brain",
    );
  });

  it("still shows the private reply in the call column", async () => {
    const branch = stripComments(
      between(await readSrc(HOOK), "if (privateReply) {", "speakForced(spoken, reply);"),
    );
    assert.match(
      branch,
      /setTranscript\(\(prev\) => \[\.\.\.prev, \{ role: "assistant", text: reply \}\]\)/,
      "she stays silent, but the text belongs on screen",
    );
  });
});
