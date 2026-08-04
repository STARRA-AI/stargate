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
import { isLoopbackBase } from "../src/app/api/chat/route";
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

/* ─────────────────── FIX WAVE — isLoopbackBase, the egress gate ───────────────
 * `PRIVATE_GPT_BASE` is the ONLY host the private branch ever talks to, so the
 * check on that value IS the privacy boundary. The first cut tested the URL's
 * host with `/^127\./`, which is a PREFIX test on a NAME: it accepts
 * `127.0.0.1.evil.example.com` and `127.attacker.example.com`, both ordinary
 * DNS-resolvable hosts that route straight off this Mac. The rule is now
 * numeric-literal loopback only — and `localhost` is deliberately gone with it,
 * because a name is only ever whatever a resolver says it is.
 * ──────────────────────────────────────────────────────────────────────────── */
describe("isLoopbackBase — only numeric loopback literals", () => {
  const ACCEPT = [
    // The shipped default (PRIVATE_GPT_DEFAULT_BASE) and what .env.local carries.
    "http://127.0.0.1:8080/v1",
    // WHATWG URL normalizes IPv4 shorthand to dotted-quad, so this IS 127.0.0.1.
    "http://127.1/v1",
    "http://[::1]:8080/v1",
    "http://127.0.0.1/v1",
    "https://127.0.0.1:8080/v1",
  ];

  const REJECT = [
    // The bug: a DNS-resolvable name that merely STARTS with `127.`
    "http://127.0.0.1.evil.com/v1",
    "http://127.evil.com/v1",
    // Deliberately dropped: `localhost` is a resolver lookup (/etc/hosts, search
    // domains), not a guaranteed loopback address.
    "http://localhost:8080/v1",
    "http://localhost.evil.com/v1",
    // IPv4-mapped IPv6 — loopback in practice, refused on purpose: one alternate
    // spelling invites the rest. URL serializes it as [::ffff:7f00:1].
    "http://[::ffff:127.0.0.1]/v1",
    // Credential trick — the authority's LAST `@` wins, so the host is evil.com.
    "http://user@127.0.0.1@evil.com/v1",
    // Non-http schemes and garbage.
    "file:///etc/passwd",
    "not-a-url",
    "",
    "http://10.0.0.5:8080/v1",
    "http://128.0.0.1/v1",
  ];

  for (const base of ACCEPT) {
    it(`accepts ${JSON.stringify(base)}`, () => {
      assert.equal(isLoopbackBase(base), true);
    });
  }

  for (const base of REJECT) {
    it(`refuses ${JSON.stringify(base)}`, () => {
      assert.equal(
        isLoopbackBase(base),
        false,
        `${base} is not a numeric loopback literal — the private lane must refuse to start`,
      );
    });
  }

  it("proves the live deck's real default still passes", () => {
    // Sanity for the running service: the value in .env.local and in the runbook.
    assert.equal(isLoopbackBase("http://127.0.0.1:8080/v1"), true);
  });
});

/* ──────────────── FIX WAVE — `private ingest` is deck-local only ──────────────
 * `private ingest <path>` reads ANY absolute path on this Mac server-side and
 * ships it into the index. The shell primitive already refuses that class of
 * power for a request that arrived over the LAN/phone (route.ts, maybeShellReply)
 * — the ingest arm has to refuse it the same way, BEFORE the read. The two
 * read-free commands are untouched on purpose: `private <ask>` and `private docs`
 * expose answers, not new file reads, and he uses them from the phone.
 * ──────────────────────────────────────────────────────────────────────────── */
describe("private lane — `private ingest` refuses non-local requests", () => {
  const ROUTE = "src/app/api/chat/route.ts";

  it("uses the SHARED helper, not a third copy of the host idiom", async () => {
    const src = stripComments(await readSrc(ROUTE));
    assert.match(
      src,
      /import \{[^}]*\bisLocalRequest\b[^}]*\} from "@\/lib\/auth-lockout"/,
      "isLocalRequest lives in src/lib/auth-lockout.ts — import it so the two cannot drift",
    );
  });

  it("gates the ingest arm before privateIngest can touch the disk", async () => {
    const src = stripComments(await readSrc(ROUTE));
    const arm = between(src, 'cmd.kind === "ingest"', "privateIngest(");
    assert.match(
      arm,
      /isLocalRequest\(/,
      "a LAN caller must not be able to drive an arbitrary server-side file read",
    );
  });

  it("puts the file read in the local-only arm, never on the refusal path", async () => {
    const src = stripComments(await readSrc(ROUTE));
    assert.match(
      src,
      /isLocalRequest\(host\)\s*\?\s*await privateIngest\(/,
      "privateIngest must be reachable ONLY when the request is local",
    );
  });

  it("streams a refusal line in the shell primitive's voice", async () => {
    const src = await readSrc(ROUTE);
    assert.match(
      src,
      /disabled over the network for safety[\s\S]{0,120}localhost/,
      "the refusal should read like maybeShellReply's, not like an error",
    );
  });

  it("leaves `private <ask>` and `private docs` LAN-usable", async () => {
    const src = stripComments(await readSrc(ROUTE));
    const banner = src.indexOf("const PRIVATE_GPT_DEFAULT_BASE");
    const branchSrc = src.slice(banner, src.indexOf("export async function POST"));
    const chatArm = between(branchSrc, 'cmd.kind === "chat"', 'cmd.kind === "ingest"');
    assert.equal(
      /isLocalRequest\(/.test(chatArm),
      false,
      "the chat arm must stay reachable from the phone — it exposes answers, not file reads",
    );
    const hits = branchSrc.match(/isLocalRequest\(/g) ?? [];
    assert.equal(
      hits.length,
      1,
      "exactly one gate, on the ingest arm — docs listing stays LAN-usable",
    );
  });
});

/* ───────────────── FIX WAVE — the composed read loop, end to end ──────────────
 * Every unit below is already tested alone. What was NOT tested is the way
 * sendMessage COMPOSES them (src/lib/stargate-context.tsx): buildUserTurn marks
 * the ask at commit time, the read loop splits the SSE byte stream on "\n\n" and
 * feeds each `data:` payload to classifyChatFrame, and withoutPrivateTurns
 * strips the marked turns out of the NEXT outbound body.
 *
 * This drives that exact composition over a synthetic frame sequence — including
 * an abort mid-stream, which is the failure that leaked the ask in fix wave 2.
 * Pure node:test: no React, no fetch, no network.
 * ──────────────────────────────────────────────────────────────────────────── */
type DriveResult = {
  /** The read loop's silence flag. */
  privateTurn: boolean;
  /** Text accumulated from `text` frames. */
  full: string;
  /** Was the silence gate ALREADY armed when the first character existed? */
  privateAtFirstText: boolean | null;
  /** Did the loop end by abort (sendMessage's `if (name === "AbortError") return`)? */
  aborted: boolean;
};

/**
 * A byte-faithful stand-in for sendMessage's read loop
 * (src/lib/stargate-context.tsx:512-532) — same buffering, same `data:` guard,
 * same classifier, same flag. `abortAtChunk` throws an AbortError where
 * `reader.read()` would when the operator hits stop / barges in / navigates.
 */
function driveChatStream(
  chunks: string[],
  opts: { abortAtChunk?: number } = {},
): DriveResult {
  let buffer = "";
  let full = "";
  let privateTurn = false;
  let privateAtFirstText: boolean | null = null;
  let aborted = false;

  try {
    for (let i = 0; i < chunks.length; i++) {
      if (opts.abortAtChunk === i) {
        const err = new Error("The user aborted a request.");
        err.name = "AbortError";
        throw err;
      }
      buffer += chunks[i];
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const frame = classifyChatFrame(line.slice(5).trim());
        if (frame.kind === "private") {
          privateTurn = true;
        } else if (frame.kind === "text") {
          if (privateAtFirstText === null) privateAtFirstText = privateTurn;
          full += frame.text;
        }
      }
    }
  } catch (err) {
    // sendMessage's catch: an aborted turn RETURNS — no history commit, no
    // reply, no re-mark. Anything the ask needed must already be true.
    if ((err as Error).name !== "AbortError") throw err;
    aborted = true;
  }

  return { privateTurn, full, privateAtFirstText, aborted };
}

/** The route's own frame shapes (route.ts sse / sseFrame). */
const marker = () => `data: ${JSON.stringify({ private: true })}\n\n`;
const textFrame = (t: string) => `data: ${JSON.stringify({ text: t })}\n\n`;

describe("private lane — composed stream drive (marker → text → abort)", () => {
  it("arms the silence gate BEFORE the first character exists", () => {
    const res = driveChatStream([
      marker(),
      textFrame("the code "),
      textFrame("is 1234"),
      "data: [DONE]\n\n",
    ]);
    assert.equal(res.privateTurn, true);
    assert.equal(
      res.privateAtFirstText,
      true,
      "marker-before-text is the whole contract — a gate armed after one text frame protects nothing",
    );
    assert.equal(res.full, "the code is 1234");
  });

  it("holds across frames split at arbitrary byte boundaries", () => {
    // The marker itself arrives in two reads, then a text frame is torn in half.
    const res = driveChatStream([
      'data: {"priv',
      'ate": true}\n\n' + 'data: {"text": "half',
      ' a line"}\n\ndata: [DONE]\n\n',
    ]);
    assert.equal(res.privateTurn, true);
    assert.equal(res.privateAtFirstText, true);
    assert.equal(res.full, "half a line");
  });

  it("still marks and strips the ask when the stream aborts mid-reply", () => {
    const ask = "private what is my SSN";
    const priorHistory: Msg[] = [
      { role: "user", content: "hey" },
      { role: "assistant", content: "hey back" },
    ];
    // Commit time — before any fetch exists (stargate-context.tsx:461-463).
    const userMsg = buildUserTurn(ask);
    const nextHistory: Msg[] = [...priorHistory, userMsg];

    const res = driveChatStream(
      [marker(), textFrame("your SSN is "), textFrame("078-05-1120")],
      { abortAtChunk: 2 },
    );
    assert.equal(res.aborted, true, "the loop must end by abort, not by [DONE]");
    assert.equal(res.privateTurn, true);
    assert.notEqual(res.full, "your SSN is 078-05-1120");

    // The reply is never committed on an aborted turn — the ask survives, and it
    // is ALREADY marked, because the mark came from the parser and not the stream.
    assert.equal(nextHistory.at(-1)?.private, true);

    // The next NORMAL turn's outbound body, built exactly the way sendMessage
    // builds it (stargate-context.tsx:478-483).
    const outbound = {
      messages: [
        ...withoutPrivateTurns(nextHistory),
        { role: "user", content: "what's the weather" },
      ],
    };
    assert.deepEqual(outbound.messages, [
      { role: "user", content: "hey" },
      { role: "assistant", content: "hey back" },
      { role: "user", content: "what's the weather" },
    ]);
    assert.equal(
      JSON.stringify(outbound).includes("SSN"),
      false,
      "the aborted private ask must not ride the next request to the hosted brain",
    );
  });

  it("marks the ask even when the abort beats the marker frame", () => {
    // Worst case: he hits stop before private-gpt sends a single byte. Nothing
    // in the stream ever said `private` — the mark cannot depend on it.
    const ask = "private ingest /Users/work/taxes.pdf";
    const userMsg = buildUserTurn(ask);
    const res = driveChatStream([marker(), textFrame("ingesting…")], {
      abortAtChunk: 0,
    });
    assert.equal(res.aborted, true);
    assert.equal(res.privateTurn, false, "no frame was ever read");
    assert.equal(userMsg.private, true);
    assert.deepEqual(withoutPrivateTurns([userMsg]), []);
  });
});
