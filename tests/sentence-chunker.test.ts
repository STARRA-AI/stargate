/**
 * SENTENCE CHUNKER — pure text splitting, no voice/DOM/network involved.
 *
 * Job: hand speak.ts the first complete sentence of a reply so it can start
 * talking before the whole answer has streamed in, and queue the remainder.
 * Deliberately DUMB: no abbreviation dictionary. A slightly early split
 * ("Mr." counted as a full sentence) is harmless; a heuristic that hangs or
 * needs a maintained word list is not. See splitFirstSentence's doc comment.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chunkForSpeech,
  MAX_SPEECH_CHUNKS,
  MIN_CHUNKABLE_CHARS,
  splitFirstSentence,
  splitSentences,
} from "../src/lib/voice/sentence-chunker";

describe("splitFirstSentence", () => {
  it("returns the empty split for an empty string", () => {
    assert.deepStrictEqual(splitFirstSentence(""), {
      first: "",
      rest: "",
      complete: false,
    });
  });

  it("treats text with no terminator as one whole sentence, rest empty", () => {
    assert.deepStrictEqual(splitFirstSentence("just some text with no end"), {
      first: "just some text with no end",
      rest: "",
      complete: false,
    });
  });

  it("splits on a period and includes the terminator in first", () => {
    assert.deepStrictEqual(splitFirstSentence("Hello world. Goodbye now."), {
      first: "Hello world.",
      rest: "Goodbye now.",
      complete: true,
    });
  });

  it("splits on an exclamation mark", () => {
    assert.deepStrictEqual(splitFirstSentence("Watch out! Behind you."), {
      first: "Watch out!",
      rest: "Behind you.",
      complete: true,
    });
  });

  it("splits on a question mark", () => {
    assert.deepStrictEqual(splitFirstSentence("Are you there? Say something."), {
      first: "Are you there?",
      rest: "Say something.",
      complete: true,
    });
  });

  it("keeps a leaving terminator at the very end, rest empty", () => {
    assert.deepStrictEqual(splitFirstSentence("Hello world."), {
      first: "Hello world.",
      rest: "",
      complete: true,
    });
    assert.deepStrictEqual(splitFirstSentence("Hello world!"), {
      first: "Hello world!",
      rest: "",
      complete: true,
    });
    assert.deepStrictEqual(splitFirstSentence("Hello world?"), {
      first: "Hello world?",
      rest: "",
      complete: true,
    });
  });

  it("keeps an ellipsis together as one terminator, not three splits", () => {
    assert.deepStrictEqual(splitFirstSentence("Wait... what happened?"), {
      first: "Wait...",
      rest: "what happened?",
      complete: true,
    });
  });

  it("trims leading and trailing whitespace around the whole text", () => {
    assert.deepStrictEqual(splitFirstSentence("  Hello world.  "), {
      first: "Hello world.",
      rest: "",
      complete: true,
    });
  });

  it("handles text starting with whitespace before the first sentence", () => {
    assert.deepStrictEqual(splitFirstSentence("   Hello there. World"), {
      first: "Hello there.",
      rest: "World",
      complete: true,
    });
  });

  it("does not build an abbreviation dictionary — a short token before a period is a fair split", () => {
    // Deliberate: "Mr." looks like an abbreviation but the spec says keep it
    // dumb. An early split here is harmless for a voice queue.
    assert.deepStrictEqual(splitFirstSentence("Mr. Smith is here."), {
      first: "Mr.",
      rest: "Smith is here.",
      complete: true,
    });
  });

  it("treats a blank line as a sentence break even with no punctuation", () => {
    assert.deepStrictEqual(splitFirstSentence("Paragraph one\n\nParagraph two."), {
      first: "Paragraph one",
      rest: "Paragraph two.",
      complete: true,
    });
  });

  it("does not treat a single newline (no blank line) as a break", () => {
    assert.deepStrictEqual(splitFirstSentence("Line one\nLine two."), {
      first: "Line one\nLine two.",
      rest: "",
      complete: true,
    });
  });
});

/**
 * THE STREAMING DISTINCTION — the reason `complete` exists.
 *
 * These two shapes were INDISTINGUISHABLE before `complete` was added, and a
 * streaming caller that cannot tell them apart speaks half a sentence out loud
 * — she gets cut off mid-word, which is worse than the latency chunking was
 * meant to remove.
 */
describe("splitFirstSentence — mid-stream vs finished", () => {
  it("marks an unfinished buffer incomplete so the caller waits instead of speaking it", () => {
    // A partial reply still arriving from the model.
    const partial = splitFirstSentence("Copy. I pulled the numbers and they");
    assert.equal(partial.first, "Copy.");
    assert.equal(partial.rest, "I pulled the numbers and they");
    assert.equal(partial.complete, true, "the FIRST sentence is finished");

    // …but its tail is not a sentence yet.
    const tail = splitFirstSentence(partial.rest);
    assert.equal(tail.complete, false, "the tail must NOT be spoken yet");
    assert.equal(tail.first, "I pulled the numbers and they");
    assert.equal(tail.rest, "");
  });

  it("marks the same text complete once its terminator arrives", () => {
    const finished = splitFirstSentence("I pulled the numbers and they hold.");
    assert.equal(finished.complete, true);
    assert.equal(finished.first, "I pulled the numbers and they hold.");
    assert.equal(finished.rest, "");
  });
});

describe("splitSentences", () => {
  it("returns an empty array for an empty string", () => {
    assert.deepStrictEqual(splitSentences(""), []);
  });

  it("returns a single-element array when there is no terminator", () => {
    assert.deepStrictEqual(splitSentences("just some text"), ["just some text"]);
  });

  it("splits a run of sentences with mixed terminators, in order", () => {
    assert.deepStrictEqual(splitSentences("One. Two! Three?"), [
      "One.",
      "Two!",
      "Three?",
    ]);
  });

  it("splits on blank-line paragraph breaks too", () => {
    assert.deepStrictEqual(
      splitSentences("Para one\n\nPara two."),
      ["Para one", "Para two."],
    );
  });

  it("never produces empty-string entries from repeated blank lines", () => {
    assert.deepStrictEqual(splitSentences("Hi.\n\n\n\nBye."), ["Hi.", "Bye."]);
  });
});

/**
 * chunkForSpeech is what stands between a reply and speakStarraChunks, and the
 * property that matters is not the exact split — it is that the split is
 * LOSSLESS and BOUNDED. Lossless because a dropped chunk is a reply she never
 * finishes saying; bounded because chunk count is simultaneous /api/tts calls,
 * and a rate-limited chunk halfway through is her stopping dead mid-answer.
 */
describe("chunkForSpeech", () => {
  // Long enough to clear MIN_CHUNKABLE_CHARS, and unambiguous to split.
  const SIX = [
    "The engine took a position at the open.",
    "It sized to two percent of the sleeve.",
    "The stop sits under yesterday's low.",
    "Nothing else triggered before lunch.",
    "The afternoon session was quiet.",
    "Everything is flat into the close.",
  ];
  const LONG = SIX.join(" ");

  it("returns an empty array for empty or whitespace-only text", () => {
    assert.deepStrictEqual(chunkForSpeech(""), []);
    assert.deepStrictEqual(chunkForSpeech("   \n  "), []);
  });

  it("does not split a reply shorter than MIN_CHUNKABLE_CHARS", () => {
    const short = "Copy. The order is in.";
    assert.ok(short.length < MIN_CHUNKABLE_CHARS);
    assert.deepStrictEqual(chunkForSpeech(short), [short]);
  });

  it("does not split a single long sentence — there is no seam to split on", () => {
    const oneSentence = `${"a".repeat(MIN_CHUNKABLE_CHARS + 50)} and then some`;
    assert.deepStrictEqual(chunkForSpeech(oneSentence), [oneSentence]);
  });

  it("makes the FIRST chunk exactly one sentence — that is the whole latency win", () => {
    const out = chunkForSpeech(LONG);
    assert.ok(out.length > 1, "a six-sentence reply must actually split");
    assert.strictEqual(out[0], SIX[0]);
  });

  it("never exceeds MAX_SPEECH_CHUNKS, however many sentences arrive", () => {
    const many = Array.from({ length: 40 }, (_, i) => `Sentence number ${i}.`).join(" ");
    assert.ok(chunkForSpeech(many).length <= MAX_SPEECH_CHUNKS);
  });

  it("is LOSSLESS — every sentence survives, in order, exactly once", () => {
    for (const n of [2, 3, 4, 5, 6, 9, 17]) {
      const sentences = Array.from(
        { length: n },
        (_, i) => `This is sentence ${i} of the reply.`,
      );
      const text = sentences.join(" ");
      const out = chunkForSpeech(text);
      assert.strictEqual(
        out.join(" "),
        text,
        `rejoining the chunks must reproduce the reply (n=${n})`,
      );
    }
  });

  it("never emits an empty chunk — an empty chunk is a wasted TTS round trip", () => {
    const out = chunkForSpeech(LONG);
    assert.ok(out.every((c) => c.trim().length > 0));
  });

  it("honours a caller-supplied cap, and a cap of 1 means do not split", () => {
    assert.deepStrictEqual(chunkForSpeech(LONG, 1), [LONG]);
    assert.strictEqual(chunkForSpeech(LONG, 2).length, 2);
    assert.strictEqual(chunkForSpeech(LONG, 2)[0], SIX[0]);
  });

  it("splits a two-sentence reply into exactly two, not one padded chunk", () => {
    const a = `Copy. ${"The position is open and sized. ".repeat(6)}`.trim();
    const out = chunkForSpeech(a);
    assert.strictEqual(out[0], "Copy.");
    assert.strictEqual(out.join(" "), a);
  });
});
