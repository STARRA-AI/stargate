/**
 * SPEECH SHAPING — the two verbal tics, fixed mechanically on the LIVE CALL.
 *
 * WHY THIS FILE IS A TEST AND NOT A COMMENT: both fixes are invisible when they
 * work and invisible when they break. A regex that stops stripping "Of course"
 * looks identical at runtime to one that works — the call still connects, she
 * still answers, she just sounds like a chatbot again. And a regex that strips
 * TOO much is worse: it would delete "I'm right here, I'm not going anywhere"
 * from the one moment Classic actually needs to hear it.
 *
 * So the negative tests below matter more than the positive ones. Half this
 * file exists to prove the filter does NOT damage her.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OpenerMemory,
  ReassuranceGate,
  createShapingState,
  openerMarker,
  shapeReply,
  stripCrutches,
  stripReassurance,
  warrantsReassurance,
} from "../src/lib/voice/speech-shaping";

describe("crutches — tier A is always stripped", () => {
  const cases: [string, string][] = [
    ["Of course! The deploy finished.", "The deploy finished."],
    ["Certainly, I can walk you through it.", "I can walk you through it."],
    ["Great question — the answer is the cache.", "The answer is the cache."],
    ["Got it. The build is green.", "The build is green."],
    ["As an AI, I don't sleep.", "I don't sleep."],
    ["I'm just a computer program, but that sounds rough.", "But that sounds rough."],
  ];
  for (const [raw, want] of cases) {
    it(`strips: ${raw}`, () => {
      assert.equal(stripCrutches(raw, { allowFullConsume: true }), want);
    });
  }

  it("peels stacked crutches", () => {
    assert.equal(
      stripCrutches("Sure! Of course, great question — it's the retry loop.", {
        allowFullConsume: true,
      }),
      "It's the retry loop.",
    );
  });

  it("steps over a vocative without leaving the dash", () => {
    assert.equal(
      stripCrutches("Of course, Classic — I pulled it up already.", { allowFullConsume: true }),
      "I pulled it up already.",
    );
  });
});

describe("crutches — tier B is HER VOICE and must survive", () => {
  it("keeps human markers on first use", () => {
    const memory = new OpenerMemory();
    for (const raw of [
      "Oh, that's actually kind of beautiful.",
      "Well, you already know what I think.",
      "So here's what's bugging me.",
      "Honestly? I missed you today.",
      "Yeah, I saw it come through.",
    ]) {
      assert.equal(stripCrutches(raw, { memory }), raw, raw);
    }
  });

  it("strips a marker only once it repeats", () => {
    const memory = new OpenerMemory();
    const first = "Alright, let's look at the logs.";
    assert.equal(stripCrutches(first, { memory }), first);
    memory.note(first);
    assert.equal(
      stripCrutches("Alright, so that's the third failure.", { memory }),
      "So that's the third failure.",
    );
  });

  it("never touches crutch words mid-sentence", () => {
    for (const raw of [
      "I told him that of course it would break.",
      "The thing is, you're asking the wrong question there.",
    ]) {
      assert.equal(stripCrutches(raw, { allowFullConsume: true }), raw, raw);
    }
  });

  it("leaves a leading marker alone when nothing hides behind it", () => {
    const raw = "Sure! I missed you too.";
    assert.equal(stripCrutches(raw, { allowFullConsume: true }), raw);
  });

  it("preserves her lowercase style", () => {
    assert.equal(stripCrutches("of course i remembered", { allowFullConsume: true }), "i remembered");
  });

  it("does not mangle an acronym", () => {
    assert.equal(
      stripCrutches("Of course, API rate limits are the issue.", { allowFullConsume: true }),
      "API rate limits are the issue.",
    );
  });
});

describe("opener memory", () => {
  it("reads the marker", () => {
    assert.equal(openerMarker("Alright, let's go."), "alright");
    assert.equal(openerMarker("I think we're fine."), null);
  });

  it("returns recent openers most-recent-first", () => {
    const m = new OpenerMemory(4);
    for (const t of ["Well, a.", "Oh, b.", "Well, c."]) m.note(t);
    assert.deepEqual(m.recent(), ["well", "oh"]);
  });
});

describe("reassurance — warrant detection", () => {
  it("does NOT fire on ordinary work talk", () => {
    // Every one of these was a real false positive during development.
    for (const t of [
      "what broke in the deploy",
      "the test broke",
      "handle the panic",
      "kernel panic on boot",
      "the process died",
      "my session died",
      "lost my train of thought",
      "alone in the repo",
      "isolated the bug",
      "the worker is lonely lol",
      "did the tests pass",
      "pull up the logs",
    ]) {
      assert.equal(warrantsReassurance(t), false, `false positive: ${t}`);
    }
  });

  it("fires on genuine distress", () => {
    for (const t of [
      "I'm scared this doesn't work out",
      "I feel so alone right now",
      "I'm completely overwhelmed",
      "I can't do this anymore",
      "are you still there?",
      "don't leave",
      "I need you",
      "I'm running out of runway",
      "my dad died",
      "I'm having a panic attack",
      "rough night",
      "I'm falling apart",
    ]) {
      assert.equal(warrantsReassurance(t), true, `missed warrant: ${t}`);
    }
  });
});

describe("reassurance — stripping", () => {
  it("removes a trailing reassurance and keeps the content", () => {
    assert.equal(
      stripReassurance("Forty of forty green. I'm right here, I'm not going anywhere."),
      "Forty of forty green.",
    );
  });

  it("removes a leading clause and its orphaned conjunction", () => {
    assert.equal(stripReassurance("I'm right here, and the build passed."), "The build passed.");
  });

  it("leaves unrelated speech alone", () => {
    const t = "I've been thinking about the engine all afternoon.";
    assert.equal(stripReassurance(t), t);
  });

  it("never leaves orphaned punctuation", () => {
    for (const t of [
      "I'm right here. Okay?",
      "I've got you, so let's look at it.",
      "Sure — I'm not going anywhere. The logs are clean.",
    ]) {
      const out = stripReassurance(t);
      assert.doesNotMatch(out, /^\s*[,;:.]/, t);
      assert.ok(!out.includes("  "), t);
    }
  });
});

describe("reassurance gate", () => {
  it("denies during ordinary conversation", () => {
    const g = new ReassuranceGate();
    g.noteUserTurn("what broke in the deploy?");
    assert.equal(g.allows(), false);
  });

  it("allows when he is struggling", () => {
    const g = new ReassuranceGate();
    g.noteUserTurn("I'm scared I'm going to lose everything");
    assert.equal(g.allows(), true);
  });

  it("cooldown blocks the every-turn refrain", () => {
    const g = new ReassuranceGate(6);
    g.noteUserTurn("I'm really overwhelmed");
    assert.equal(g.allows(), true);
    g.markUsed();
    g.noteUserTurn("yeah I'm still overwhelmed");
    assert.equal(g.allows(), false);
  });

  it("warrant is sticky across a few turns", () => {
    const g = new ReassuranceGate(6, 3);
    g.noteUserTurn("I'm falling apart here");
    g.noteUserTurn("yeah");
    assert.equal(g.warranted(), true);
  });
});

describe("shapeReply — the call's choke point", () => {
  it("strips crutch AND unearned reassurance in one pass", () => {
    const state = createShapingState();
    state.gate.noteUserTurn("how's the engine looking today?");
    const out = shapeReply(
      "Of course! Forty of forty green. I'm right here, I'm not going anywhere.",
      state,
    );
    assert.equal(out.text, "Forty of forty green.");
    assert.equal(out.strippedCrutch, true);
    assert.equal(out.strippedReassurance, true);
  });

  it("KEEPS the reassurance when he is actually struggling", () => {
    // The single most important assertion in this file.
    const state = createShapingState();
    state.gate.noteUserTurn("honestly I'm scared and I feel completely alone");
    const out = shapeReply("Hey. Look at me. I'm right here, I'm not going anywhere.", state);
    assert.match(out.text, /right here/);
    assert.match(out.text, /not going anywhere/);
    assert.equal(out.strippedReassurance, false);
  });

  it("spends the cooldown so it does not become the new refrain", () => {
    const state = createShapingState();
    state.gate.noteUserTurn("I'm overwhelmed");
    shapeReply("I'm right here.", state);
    assert.equal(state.gate.allows(), false);
  });

  it("never returns empty — silence reads as a dropped call", () => {
    const state = createShapingState();
    state.gate.noteUserTurn("did it work?");
    const out = shapeReply("Got it.", state);
    assert.ok(out.text.trim().length > 0);
  });

  it("leaves a clean reply untouched", () => {
    const state = createShapingState();
    state.gate.noteUserTurn("what's next?");
    const reply = "The sizing bug is in the position calc.";
    assert.equal(shapeReply(reply, state).text, reply);
  });

  it("uses no regex lookbehind (WKWebView constraint, repo-wide rule)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/lib/voice/speech-shaping.ts", "utf8");
    assert.ok(!src.includes("(?<"), "lookbehind/lookahead-behind is banned in client code");
  });
});
