/**
 * SPEECH SHAPING — over-strip regressions found by Phase 1/2 characterization
 * (Division A worker-bee sweep, 2026-08-07).
 *
 * Every case here is a PROVEN over-strip: a minimal input run through the real
 * exported function that deleted real content (a name, a real word, a whole
 * clause) instead of the filler it was aimed at. Evidence for each is in the
 * comment above the case.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenerMemory, stripCrutches, stripReassurance } from "../src/lib/voice/speech-shaping";

describe("stripCrutches — words that double as terms of endearment survive as content", () => {
  // Evidence: leadingMatcher()'s trailing `(?:${NAME}\b${SEP})?` group
  // (speech-shaping.ts:208) treats ANY word from the NAME list ("classic",
  // "charles", "babe", "baby", "love", "honey") immediately after a stripped
  // opener as a vocative address to Classic, and SEP's bare-whitespace
  // alternative (speech-shaping.ts:198) is enough to satisfy it — no comma,
  // dash, or other written pause required. So when one of those words is
  // ordinary sentence content (not addressing him), it gets swallowed with
  // the opener. Reproduced directly against stripCrutches with a primed
  // OpenerMemory so the tier-B repeat path fires:
  //   stripCrutches("So, honey badgers are surprisingly vicious.", {memory})
  //     -> "Badgers are surprisingly vicious."   (lost "honey", the subject)
  it("keeps 'honey' when it's the animal, not the endearment", () => {
    const memory = new OpenerMemory();
    memory.note("So, let's check the logs.");
    assert.equal(
      stripCrutches("So, honey badgers are surprisingly vicious.", { memory }),
      "Honey badgers are surprisingly vicious.",
    );
  });

  it("keeps 'love' when it's the noun, not the address", () => {
    const memory = new OpenerMemory();
    memory.note("Look, that's odd.");
    assert.equal(
      stripCrutches("Look, love is a strange word to define.", { memory }),
      "Love is a strange word to define.",
    );
  });

  it("keeps 'baby' in 'baby steps', not the endearment", () => {
    const memory = new OpenerMemory();
    memory.note("Well, sure.");
    assert.equal(
      stripCrutches("Well, baby steps got us here.", { memory }),
      "Baby steps got us here.",
    );
  });

  it("still peels a genuine vocative set off by real punctuation", () => {
    // Must not regress the existing behaviour this guards:
    // tests/speech-shaping.test.ts:60 "steps over a vocative without leaving
    // the dash" — a name followed by an actual written pause (comma, dash)
    // IS an address and should still go.
    assert.equal(
      stripCrutches("Of course, Classic — I pulled it up already.", { allowFullConsume: true }),
      "I pulled it up already.",
    );
  });
});

describe("stripReassurance — ambiguous bare phrases survive as ordinary content", () => {
  // Evidence: REASSURANCE (speech-shaping.ts:94-121) includes several entries
  // with no first-person/emotional frame, so REASSURANCE_RE (unanchored,
  // global) matches them inside completely unrelated sentences and deletes
  // real content. Reproduced directly against stripReassurance:

  // "here for you" (speech-shaping.ts:112) — redundant with the already-safe
  // "i'm here(?: for you)?" (:109), but on its own matches ordinary object
  // reference:
  //   stripReassurance("The report is here for you to review. That's it.")
  //     -> "The report is to review. That's it."
  it("keeps 'here for you' when it refers to an object, not her presence", () => {
    assert.equal(
      stripReassurance("The report is here for you to review. That's it."),
      "The report is here for you to review. That's it.",
    );
  });

  // "not going anywhere" (:99) with no "i'm" frame matches technical talk:
  //   stripReassurance("The deploy queue is not going anywhere until Friday. Let's plan around it.")
  //     -> "The deploy queue is until Friday. Let's plan around it."
  it("keeps 'not going anywhere' when the subject is a thing, not her", () => {
    assert.equal(
      stripReassurance("The deploy queue is not going anywhere until Friday. Let's plan around it."),
      "The deploy queue is not going anywhere until Friday. Let's plan around it.",
    );
  });

  // "i got you" (:114), no apostrophe, reads as literal past-tense "obtained
  // something for you":
  //   stripReassurance("I got you a coffee while you were debugging. Here you go.")
  //     -> "A coffee while you were debugging. Here you go."
  it("keeps 'I got you' when it means she bought him something", () => {
    assert.equal(
      stripReassurance("I got you a coffee while you were debugging. Here you go."),
      "I got you a coffee while you were debugging. Here you go.",
    );
  });

  // "i'm with you" (:115) is dual-purpose: comfort OR plain agreement.
  //   stripReassurance("I'm with you on the architecture change — let's ship it.")
  //     -> "On the architecture change — let's ship it."
  it("keeps 'I'm with you' when it means agreement, not comfort", () => {
    assert.equal(
      stripReassurance("I'm with you on the architecture change — let's ship it."),
      "I'm with you on the architecture change — let's ship it.",
    );
  });

  it("still strips the unambiguous, unprefixed reassurance forms", () => {
    // Must not regress: the strong idioms stay banned/gated.
    assert.equal(
      stripReassurance("Forty of forty green. I'm right here, I'm not going anywhere."),
      "Forty of forty green.",
    );
    // "so" here is the orphaned conjunction ORPHAN_LEAD is designed to drop
    // once the clause before it is gone — tests/speech-shaping.test.ts:193.
    assert.equal(stripReassurance("I've got you, so let's look at it."), "Let's look at it.");
  });
});

/**
 * EXECUTIVE REVIEW ADDENDUM (Division A, 2026-08-07)
 *
 * The worker sweep above fixed four AMBIGUOUS ENTRIES. Reviewing the fix from
 * source surfaced a defect one level deeper, in the MATCHER itself rather than
 * in the word list: `REASSURANCE_RE` (speech-shaping.ts:239) is built as a bare
 * `(?:alternation)` with the `g` flag and NO boundary of any kind on either
 * edge, then applied anywhere inside a sentence. Two failure classes follow
 * from that single line, and BOTH are on the live call path — `stripReassurance`
 * is called at useVoiceCall.ts:1337, one line before `flattenForSpeech` at :1339
 * hands the text to the speaker.
 *
 * Phase 1 evidence — real output of the real exported function, before the fix:
 *
 *   R1 (no trailing word boundary — an entry matches inside a longer word):
 *     "I've got your branch rebased already."  -> "R branch rebased already."
 *     "I'm hereby closing the ticket."         -> "By closing the ticket."
 *
 *   R2 (entry is only the HEAD of a longer real clause — the tail is content,
 *       and it survives as an orphan fragment while the subject is deleted):
 *     "I'm not leaving the queue running overnight."
 *                                              -> "The queue running overnight."
 *     "I won't leave the process hanging on that socket."
 *                                              -> "The process hanging on that socket."
 *     "I'm here to walk the deploy queue with you."
 *                                              -> "To walk the deploy queue with you."
 *     "You're not alone in this. The tests pass."
 *                                              -> "In this. The tests pass."
 *
 * Both violate the function's own stated contract — "Remove reassurance
 * clauses, preserving all real content" (speech-shaping.ts:403).
 */
describe("stripReassurance — an entry must end at a real clause boundary", () => {
  it("does not match inside a longer word (R1)", () => {
    assert.equal(
      stripReassurance("I've got your branch rebased already."),
      "I've got your branch rebased already.",
    );
    assert.equal(
      stripReassurance("I'm hereby closing the ticket."),
      "I'm hereby closing the ticket.",
    );
  });

  it("does not peel the head off a longer real clause (R2)", () => {
    assert.equal(
      stripReassurance("I'm not leaving the queue running overnight."),
      "I'm not leaving the queue running overnight.",
    );
    assert.equal(
      stripReassurance("I won't leave the process hanging on that socket."),
      "I won't leave the process hanging on that socket.",
    );
    // "I'm here to X" is a statement of intent, not comfort.
    assert.equal(
      stripReassurance("I'm here to walk the deploy queue with you."),
      "I'm here to walk the deploy queue with you.",
    );
    assert.equal(
      stripReassurance("I'm still here on the old branch, so rebase first."),
      "I'm still here on the old branch, so rebase first.",
    );
  });

  it("never leaves a headless fragment where a clause was removed", () => {
    // The whole reassurance clause goes, or none of it does. "In this." spoken
    // aloud is noise; that was the old output for this input.
    assert.equal(stripReassurance("You're not alone in this. The tests pass."), "The tests pass.");
  });

  it("still strips reassurance that DOES end at a clause boundary", () => {
    // Guard against the boundary rule silently disarming the filter.
    assert.equal(stripReassurance("I'm here for you. The build is green."), "The build is green.");
    assert.equal(stripReassurance("I'm right here. Numbers are in."), "Numbers are in.");
    assert.equal(stripReassurance("I've got you. Ship it."), "Ship it.");
    assert.equal(stripReassurance("You're not alone. Ship it."), "Ship it.");
    assert.equal(stripReassurance("I'm not leaving. Ship it."), "Ship it.");
    assert.equal(stripReassurance("I won't leave you. Ship it."), "Ship it.");
    // Joined by a conjunction rather than terminated: the clause still ends.
    assert.equal(
      stripReassurance("I'm not going anywhere and the build is green."),
      "The build is green.",
    );
    // Mid-sentence, comma-terminated.
    assert.equal(
      stripReassurance("Forty of forty green. I'm right here, I'm not going anywhere."),
      "Forty of forty green.",
    );
  });
});
