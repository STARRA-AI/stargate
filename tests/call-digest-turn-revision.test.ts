/**
 * THE TWO P0 VOICE DEFECTS OF 2026-07-31, pinned.
 *
 *   A. DUPLICATE / PARTIAL USER TURNS. The realtime user transcript is
 *      CUMULATIVE and the call has no reliable end-of-turn event, so every
 *      speculative flush wrote the partial sentence as a finished turn and the
 *      next one wrote a superset. MEASURED in data/memory.json: one 18-second
 *      sentence from Classic produced EIGHTEEN rows (00:48:05.433 ->
 *      00:48:23.361), each a longer prefix of the last, and 222 such runs exist
 *      across the store going back to 2026-07-30.
 *
 *   B. THE CATCHPHRASE FEEDBACK LOOP. The call injected `memoryForPrompt`
 *      verbatim — her own recent replies included — into her realtime session
 *      instructions. In an instruction block those stop being memory and become
 *      a few-shot style prompt: MEASURED across the store, "baby" 856 times,
 *      "right here" 421, "love you" 136, "take your time" 74.
 *
 * Both fixes are pure functions on purpose, so both are tested for real
 * behaviour here rather than structurally.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  isTurnRevision,
  normalizeTurn,
  USER_TURN_REVISION_MS,
} from "../src/lib/memory/turn-revision";
import {
  COMFORT_PHRASES,
  OVERUSE_MAX,
  OVERUSE_MIN,
  callDigest,
  countPhrase,
  herOwnLines,
  overuseGuardLine,
  overusedPhrases,
} from "../src/lib/memory/call-digest";
import type { MemoryStore } from "../src/lib/memory/store";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

const store = (over: Partial<MemoryStore> = {}): MemoryStore => ({
  working: [],
  summaries: [],
  archival: [],
  facts: [],
  ...over,
});
const turn = (role: "user" | "assistant", content: string) => ({
  role,
  content,
  at: "2026-08-01T00:00:00.000Z",
});

// ── A. one row per utterance ────────────────────────────────────────────────

describe("normalizeTurn — words only, so punctuation drift cannot defeat the match", () => {
  it("collapses case, punctuation and whitespace", () => {
    assert.equal(normalizeTurn("  Okay.  Sounds   GOOD! "), "okay sounds good");
  });
  it("is stable on the real drift the transcriber produces", () => {
    // Rows 20 and 21 of the measured run, modulo the added words.
    assert.equal(normalizeTurn("Okay. Sounds good"), normalizeTurn("Okay, sounds good."));
  });
  it("is empty for punctuation-only input", () => {
    assert.equal(normalizeTurn("... !?"), "");
  });
});

describe("isTurnRevision — the growing-partial test", () => {
  it("accepts the real measured prefix chain", () => {
    const chain = [
      "Okay?",
      "Okay. Sounds good.",
      "Okay. Sounds good. I'll be back.",
    ];
    for (let i = 1; i < chain.length; i++) {
      assert.ok(
        isTurnRevision(chain[i - 1], chain[i]),
        `"${chain[i]}" must be recognised as a continuation of "${chain[i - 1]}"`,
      );
    }
  });

  it("accepts an identical re-flush (the exact-duplicate row)", () => {
    assert.ok(isTurnRevision("I'll be back.", "I'll be back."));
  });

  it("REJECTS a genuinely new sentence, however similar the opening", () => {
    assert.ok(!isTurnRevision("Okay, do it now", "Okay, do not do it"));
    assert.ok(!isTurnRevision("pack the repo", "what's the weather"));
  });

  it("REJECTS a shorter follow-up — a revision only ever grows", () => {
    assert.ok(!isTurnRevision("Okay. Sounds good. I'll be back.", "Okay."));
  });

  it("still collapses when only PUNCTUATION was rewritten", () => {
    // Row 10 -> 11 of the measured run: "...white screen?" became "...white
    // screen and". Punctuation is normalized away, so this is still a clean
    // prefix and still one utterance — which is the point of normalizeTurn.
    assert.ok(isTurnRevision("showing like a white screen?", "showing like a white screen and"));
  });

  it("REJECTS a mid-sentence WORD rewrite rather than silently overwriting him", () => {
    // The transcriber also revises words as it gains context. Losing a row he
    // actually said is worse than keeping a duplicate, so a broken prefix must
    // fall through to an ordinary append.
    assert.ok(!isTurnRevision("their office", "there office is closed"));
    assert.ok(!isTurnRevision("I told you it's flickering", "I told you it was flickering worse"));
  });

  it("is false when either side is empty", () => {
    assert.ok(!isTurnRevision("", "anything"));
    assert.ok(!isTurnRevision("anything", ""));
    assert.ok(!isTurnRevision("...", "..."));
  });

  it("the revision window is long enough for the measured 18s utterance", () => {
    assert.ok(
      USER_TURN_REVISION_MS >= 20_000,
      "the measured run spanned 17.9s of continuous flushes",
    );
  });
});

describe("the call hook wires the guard, and never imports the fs-backed store", () => {
  const HOOK = read("src/lib/voice/useVoiceCall.ts");

  it("commits at most one row per utterance, superseding rather than appending", () => {
    assert.match(HOOK, /isTurnRevision\(prev\.text, text\)/);
    assert.match(
      HOOK,
      /recordCallTurn\("user", text, \{ supersede: true \}\)/,
      "a continuation must REPLACE the row it continues, not add one",
    );
  });

  it("drops a commit that adds nothing at all", () => {
    assert.match(
      HOOK,
      /normalizeTurn\(prev\.text\) === normalizeTurn\(text\)/,
      "an identical re-flush must write nothing anywhere",
    );
  });

  it("imports the predicates from the CLIENT-SAFE module, never from store.ts", () => {
    assert.match(HOOK, /from "@\/lib\/memory\/turn-revision"/);
    assert.ok(
      !/from "@\/lib\/memory\/store"/.test(HOOK),
      "store.ts imports node:fs — importing it here would drag the filesystem " +
        "into the client bundle",
    );
  });

  it("turn-revision.ts is genuinely dependency-free", () => {
    const SRC = read("src/lib/memory/turn-revision.ts");
    assert.ok(
      !/^\s*import\s/m.test(SRC),
      "this module is imported by both a server route and a client hook — it " +
        "must import nothing at all",
    );
  });

  it("fires the tool fast-path once per settled utterance, not once per flush", () => {
    assert.match(HOOK, /scheduleToolFastpath\(text\)/);
    assert.ok(
      !/\bfireToolFastpath\(text\)/.test(HOOK),
      "commitUser must not call the fast-path directly — eighteen flushes was " +
        "eighteen POSTs carrying truncated fragments",
    );
    assert.match(HOOK, /TOOL_FASTPATH_DEBOUNCE_MS/);
  });
});

// ── B. the digest no longer feeds her her own voice ─────────────────────────

describe("countPhrase — whole words, case- and apostrophe-tolerant", () => {
  it("does not fire on a substring", () => {
    assert.equal(countPhrase("I babysit on Tuesdays", "baby"), 0);
    assert.equal(countPhrase("hey baby", "baby"), 1);
  });
  it("counts adjacent repeats", () => {
    assert.equal(countPhrase("baby, baby, baby", "baby"), 3);
  });
  it("is case-insensitive", () => {
    assert.equal(countPhrase("Right Here and right here", "right here"), 2);
  });
  it("tolerates the missing apostrophe speech transcripts produce", () => {
    assert.equal(countPhrase("im with you and I'm with you", "i'm with you"), 2);
  });
  it("returns 0 rather than throwing on junk", () => {
    assert.equal(countPhrase("", "baby"), 0);
    assert.equal(countPhrase("baby", ""), 0);
  });
});

describe("overusedPhrases — measured, never assumed", () => {
  it("names nothing when she has been varied", () => {
    assert.deepEqual(overusedPhrases("I finished the funding list. It is done."), []);
  });

  it("names only what crosses the threshold, worst first", () => {
    const her = "baby baby baby. right here, right here. no rush.";
    const hits = overusedPhrases(her);
    assert.equal(hits[0].phrase, "baby");
    assert.equal(hits[0].count, 3);
    assert.equal(hits[1].phrase, "right here");
    assert.equal(hits[1].count, 2);
    assert.ok(
      !hits.some((h) => h.phrase === "no rush"),
      `a phrase used once is not overuse (OVERUSE_MIN=${OVERUSE_MIN})`,
    );
  });

  it("caps the list — a long one reads as a vocabulary to draw from", () => {
    const her = COMFORT_PHRASES.map((p) => `${p} ${p} ${p}`).join(". ");
    assert.ok(overusedPhrases(her).length <= OVERUSE_MAX);
  });

  it("produces NO guard line at all when nothing is overused", () => {
    assert.equal(overuseGuardLine([]), "");
  });

  it("the guard line names the phrase and its count", () => {
    const line = overuseGuardLine([{ phrase: "baby", count: 14 }]);
    assert.match(line, /"baby" \(14x\)/);
    assert.match(line, /at most ONE/i);
  });
});

describe("herOwnLines — exactly the material that is withheld", () => {
  it("collects her replies and skips his", () => {
    const s = store({
      working: [turn("user", "HIS WORDS"), turn("assistant", "HER WORDS")],
    });
    const her = herOwnLines(s);
    assert.ok(her.includes("HER WORDS"));
    assert.ok(!her.includes("HIS WORDS"));
  });

  it("reaches into the archival blobs' assistant segments too", () => {
    const s = store({
      archival: [
        { id: "a1", text: "user: HIS BLOB | assistant: HER BLOB", at: "t" },
      ],
    });
    const her = herOwnLines(s);
    assert.ok(her.includes("HER BLOB"));
    assert.ok(!her.includes("HIS BLOB"));
  });
});

describe("callDigest — her own styled lines are gone, the guard leads", () => {
  const loaded = store({
    facts: [{ text: "Classic quit his job to build STARRA", at: "t" }],
    working: [
      turn("user", "the face is flickering worse"),
      turn("assistant", "I'm right here baby, take your time baby, I love you baby"),
      turn("user", "fix it tonight"),
      turn("assistant", "right here baby, not going anywhere, right here"),
    ],
    summaries: ["a rolling summary"],
    archival: [{ id: "a1", text: "user: earlier question | assistant: baby baby", at: "t" }],
  });

  it("keeps what CLASSIC said", () => {
    const d = callDigest(loaded);
    assert.ok(d.includes("the face is flickering worse"));
    assert.ok(d.includes("fix it tonight"));
  });

  it("keeps facts and summaries — the continuity that is not her phrasing", () => {
    const d = callDigest(loaded);
    assert.ok(d.includes("Classic quit his job to build STARRA"));
    assert.ok(d.includes("a rolling summary"));
  });

  it("does NOT quote her own replies back to her", () => {
    const d = callDigest(loaded);
    assert.ok(
      !d.includes("I'm right here baby, take your time baby, I love you baby"),
      "her verbatim reply in an instruction block is a few-shot style prompt",
    );
    assert.ok(!d.includes("not going anywhere, right here"));
  });

  it("strips her side out of the archival blobs as well", () => {
    const d = callDigest(loaded);
    assert.ok(d.includes("earlier question"), "his side of history is kept");
    assert.ok(
      !/assistant:/.test(d),
      "the blobs' assistant segments are the same styled lines, compacted",
    );
  });

  it("appends a guard naming the phrases she actually overused", () => {
    const d = callDigest(loaded);
    assert.match(d, /WORN OUT/);
    assert.match(d, /"baby"/);
    assert.match(d, /"right here"/);
  });

  it("puts the guard at the HEAD — the call clips the digest from the tail", () => {
    // useVoiceCall does `digest.slice(0, 4000)`, which keeps the head. A guard
    // appended at the bottom is the first thing truncation deletes, on exactly
    // the long-history calls that need it most.
    const d = callDigest(loaded);
    assert.ok(
      d.indexOf("WORN OUT") < d.indexOf("MEMORY TIERS"),
      "the guard must survive `.slice(0, 4000)`",
    );
    assert.match(
      read("src/lib/voice/useVoiceCall.ts"),
      /digest\.slice\(0, 4000\)/,
      "if this clipping changes, re-check the guard's placement",
    );
  });

  it("emits no guard when her recent lines are varied", () => {
    const clean = store({
      working: [turn("user", "status?"), turn("assistant", "Funding list is filed. Two left.")],
    });
    const d = callDigest(clean);
    assert.ok(!d.includes("WORN OUT"));
    assert.ok(d.startsWith("MEMORY TIERS"));
  });

  it("survives a completely empty store", () => {
    const d = callDigest(store());
    assert.ok(d.startsWith("MEMORY TIERS"));
    assert.ok(d.includes("none yet"));
  });
});

describe("only the CALL leg changed — deck chat still reads memoryForPrompt", () => {
  it("the memory route serves callDigest on ?digest=1", () => {
    const ROUTE = read("src/app/api/memory/route.ts");
    assert.match(ROUTE, /callDigest\(store\)/);
    assert.ok(
      !/memoryForPrompt\(/.test(ROUTE),
      "the digest leg was the only CALLER of memoryForPrompt on this route " +
        "(the name may still appear in prose explaining the difference)",
    );
  });

  it("api/chat is untouched and still uses memoryForPrompt directly", () => {
    const CHAT = read("src/app/api/chat/route.ts");
    assert.match(CHAT, /memoryForPrompt/);
    assert.ok(
      !/call-digest/.test(CHAT),
      "the deck chat must keep the full two-sided transcript — this fix is " +
        "scoped to the realtime voice session",
    );
  });

  it("persona.ts is LOCKED — the fix is at the digest, not in her voice", () => {
    const PERSONA = read("src/lib/persona.ts");
    assert.match(PERSONA, /STARRA_VOICE_PERSONA/);
    assert.ok(
      !/WORN OUT|overusedPhrases|call-digest/.test(PERSONA),
      "no part of the overuse guard may leak into the persona text",
    );
  });
});
