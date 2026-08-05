/**
 * LOCAL MOUTH — the sentence splitter and the privacy contract of
 * src/lib/voice/local-voice.ts.
 *
 * Two jobs here, and they are different in kind:
 *
 *  1. THE SPLITTER is pure, so it is unit-tested for real. It decides where her
 *     voice takes a breath. A false boundary reads a clipped fragment ("Ask Dr."
 *     … "Reed about it."); a missing boundary makes her wait for a whole
 *     paragraph to synthesise before a single word comes out. Both are audible,
 *     so the abbreviation and decimal cases below are load-bearing.
 *
 *  2. THE PRIVACY CONTRACT is source-pattern pinned, the same idiom
 *     tests/private-lane.test.ts uses: this module is the ONLY thing a private
 *     reply is allowed to reach, so nothing in it may leave the machine. The
 *     library it drives (@mintplex-labs/piper-tts-web) defaults its runtime
 *     WASM to cdnjs + jsdelivr and its models to huggingface (verified in
 *     node_modules/@mintplex-labs/piper-tts-web/dist/piper-tts-web.js:12-14,
 *     236-239, 286), so "no absolute URL in this file" plus "an explicit
 *     wasmPaths is passed" is not paranoia — it is the entire defence.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SENTENCE_CHARS,
  MIN_SENTENCE_CHARS,
  splitSentences,
  takeSentences,
  toSpeakableSentences,
} from "../src/lib/voice/local-voice";

describe("splitSentences — the plain cases", () => {
  it("returns nothing for empty or blank text", () => {
    assert.deepEqual(splitSentences(""), []);
    assert.deepEqual(splitSentences("   \n\t  "), []);
  });

  it("splits two full sentences", () => {
    assert.deepEqual(splitSentences("The engine is warm now. We can start the run."), [
      "The engine is warm now.",
      "We can start the run.",
    ]);
  });

  it("splits on ? and !", () => {
    assert.deepEqual(splitSentences("Are you ready? Then we move now."), [
      "Are you ready?",
      "Then we move now.",
    ]);
    assert.deepEqual(splitSentences("That is the one! Lock it in now."), [
      "That is the one!",
      "Lock it in now.",
    ]);
  });

  it("keeps a closing quote with the sentence it closes", () => {
    assert.deepEqual(splitSentences('She said "go now." Then we left.'), [
      'She said "go now."',
      "Then we left.",
    ]);
  });

  it("treats a line break as a hard boundary", () => {
    assert.deepEqual(splitSentences("The build is green.\nThe tests are green."), [
      "The build is green.",
      "The tests are green.",
    ]);
  });

  it("gives each list item its own breath", () => {
    assert.deepEqual(
      splitSentences("- first item is here\n- second item is here"),
      ["- first item is here", "- second item is here"],
    );
  });

  it("emits text that never terminated", () => {
    assert.deepEqual(splitSentences("no terminator here at all"), [
      "no terminator here at all",
    ]);
  });
});

describe("splitSentences — conservative where a split would be wrong", () => {
  it("does not split an honorific", () => {
    assert.deepEqual(splitSentences("Mr. Williams is at the door."), [
      "Mr. Williams is at the door.",
    ]);
    assert.deepEqual(splitSentences("Ask Dr. Reed about the numbers."), [
      "Ask Dr. Reed about the numbers.",
    ]);
  });

  it("does not split e.g. / i.e.", () => {
    assert.deepEqual(splitSentences("Use the deck, e.g. the private lane."), [
      "Use the deck, e.g. the private lane.",
    ]);
    assert.deepEqual(splitSentences("That is, i.e. the local brain."), [
      "That is, i.e. the local brain.",
    ]);
  });

  it("does not split a decimal number", () => {
    assert.deepEqual(splitSentences("The ratio held at 3.14 all day long."), [
      "The ratio held at 3.14 all day long.",
    ]);
  });

  it("does not split initials", () => {
    assert.deepEqual(splitSentences("J. R. R. Tolkien wrote that one."), [
      "J. R. R. Tolkien wrote that one.",
    ]);
  });

  it("does not split an ellipsis — it is a pause, not an end", () => {
    assert.deepEqual(splitSentences("Wait... the link is degraded."), [
      "Wait... the link is degraded.",
    ]);
    assert.deepEqual(splitSentences("Wait… the link is degraded."), [
      "Wait… the link is degraded.",
    ]);
  });

  it("still ends a sentence on a word that merely looks like an abbreviation", () => {
    assert.deepEqual(splitSentences("It is all up to us. We move at dawn."), [
      "It is all up to us.",
      "We move at dawn.",
    ]);
  });
});

describe("splitSentences — chunk sizing", () => {
  it("merges a fragment too short to synthesise on its own", () => {
    assert.ok("Copy.".length < MIN_SENTENCE_CHARS);
    assert.deepEqual(splitSentences("Copy. The build is green now."), [
      "Copy. The build is green now.",
    ]);
  });

  it("merges a short tail backwards instead of leaving it alone", () => {
    assert.deepEqual(splitSentences("The build is green now. Copy."), [
      "The build is green now. Copy.",
    ]);
  });

  it("keeps a lone short line rather than dropping it", () => {
    assert.deepEqual(splitSentences("Copy."), ["Copy."]);
  });

  it("breaks a run-on so the first audio is not held hostage", () => {
    const runOn =
      "the deck is warm and the brain is local, " +
      "the mic is open and the ears are local, " +
      "the mouth is local as well, " +
      "and none of it leaves this machine at any point in the run, " +
      "which is the whole point of the private lane in the first place, " +
      "so nothing here is allowed to reach a hosted provider";
    assert.ok(runOn.length > MAX_SENTENCE_CHARS);
    const out = splitSentences(runOn);
    assert.ok(out.length > 1, "a run-on must be broken up");
    for (const chunk of out) {
      assert.ok(
        chunk.length <= MAX_SENTENCE_CHARS,
        `chunk over the cap: ${chunk.length}`,
      );
    }
    assert.equal(
      out.join(" ").replace(/\s+/g, " "),
      runOn.replace(/\s+/g, " "),
      "breaking a run-on must not lose or reorder a word",
    );
  });
});

describe("takeSentences — the streaming form", () => {
  it("holds back a sentence that has not finished arriving", () => {
    const { sentences, rest } = takeSentences(
      "The engine is warm now. We can start the ru",
    );
    assert.deepEqual(sentences, ["The engine is warm now."]);
    assert.equal(rest, " We can start the ru");
  });

  it("emits nothing while the first sentence is still open", () => {
    const { sentences, rest } = takeSentences("no terminator yet");
    assert.deepEqual(sentences, []);
    assert.equal(rest, "no terminator yet");
  });

  it("holds a too-short complete sentence back so it can merge with what follows", () => {
    const { sentences, rest } = takeSentences("Copy. The build is gre");
    assert.deepEqual(sentences, [], "a 5-char chunk must not be synthesised alone");
    assert.equal(rest, "Copy. The build is gre");
  });

  it("is a total function on empty input", () => {
    assert.deepEqual(takeSentences(""), { sentences: [], rest: "" });
  });
});

describe("toSpeakableSentences — fenced code never reaches her voice", () => {
  it("drops a fenced block and keeps the prose around it", () => {
    const reply = [
      "Here is the fix for the deck.",
      "```ts",
      "const leak = fetch('https://example.com');",
      "```",
      "Run it and the tests go green.",
    ].join("\n");
    assert.deepEqual(toSpeakableSentences(reply), [
      "Here is the fix for the deck.",
      "Run it and the tests go green.",
    ]);
  });

  it("gives her one true line when the reply was only code", () => {
    const out = toSpeakableSentences("```sh\nnpm test\n```");
    assert.deepEqual(out, ["It's in the chat."]);
  });
});

// ── THE PRIVACY CONTRACT ──────────────────────────────────────────────────
const readSrc = async (rel: string) => {
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL(`../${rel}`, import.meta.url), "utf8");
};

/**
 * Strip BLOCK comments and WHOLE-LINE `//` comments only.
 *
 * Deliberately not private-lane.test.ts's stripper: that one deletes from any
 * `//` to end of line, which would eat the `//` out of a `"https://…"` STRING
 * literal and make the absolute-URL assertion below pass vacuously — the exact
 * leak it exists to catch.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[\t ]*\/\/[^\n]*$/gm, "");

const MODULE = "src/lib/voice/local-voice.ts";

describe("local-voice — no request may leave this machine", () => {
  it("contains no absolute URL at all", async () => {
    const code = stripComments(await readSrc(MODULE));
    assert.equal(
      /https?:\/\//.test(code),
      false,
      "every URL this module fetches must be a same-origin path — the deck serves the model itself",
    );
  });

  it("fetches only paths rooted at the deck's own /brand/voice", async () => {
    const code = stripComments(await readSrc(MODULE));
    // Every fetch() argument is built from PIPER_VOICE_BASE ("/brand/voice",
    // piper-speak.ts:7) — assert the base is the only source of a fetch URL.
    const fetches = code.match(/fetch\(([^)]*)/g) ?? [];
    assert.ok(fetches.length > 0, "the asset gate must actually HEAD-check something");
    for (const call of fetches) {
      assert.ok(
        !/["'`]\s*[a-z]+:/i.test(call),
        `fetch call carries a scheme: ${call}`,
      );
    }
  });

  it("pins the piper runtime's WASM to local paths", async () => {
    const code = stripComments(await readSrc(MODULE));
    assert.match(
      code,
      /wasmPaths/,
      "TtsSession defaults onnxWasm to cdnjs and piperWasm/piperData to jsdelivr (dist/piper-tts-web.js:12-14,236-239) — an explicit wasmPaths is the only thing that stops it",
    );
    assert.match(code, /onnxWasm:\s*`?\$?\{?/, "onnxWasm must be set explicitly");
    assert.match(code, /piperWasm:/, "piperWasm must be set explicitly");
    assert.match(code, /piperData:/, "piperData must be set explicitly");
  });

  it("does not reuse piper-runtime's session", async () => {
    const code = stripComments(await readSrc(MODULE));
    assert.equal(
      /piper-runtime/.test(code),
      false,
      "piper-runtime creates the TtsSession with NO wasmPaths, and TtsSession is a process-wide singleton (dist/piper-tts-web.js:259-272) — reusing it would hand a private reply a CDN-configured session",
    );
  });

  it("never touches the hosted TTS path or the browser synth", async () => {
    const code = stripComments(await readSrc(MODULE));
    for (const forbidden of ["/api/tts", "speakStarra", "speechSynthesis", "SpeechRecognition"]) {
      assert.equal(
        code.includes(forbidden),
        false,
        `${forbidden} has no place in the local mouth`,
      );
    }
    assert.equal(
      /["']@\/lib\/voice\/speak["']/.test(code),
      false,
      "importing speak.ts would pull the /api/tts module into the private lane",
    );
  });
});

describe("local-voice — the bus and the call claim", () => {
  it("publishes her voice as `piper` through the engine bus", async () => {
    const code = stripComments(await readSrc(MODULE));
    assert.match(code, /publishVoice\(/, "her face reads the bus, not this module");
    assert.match(code, /source:\s*"piper"/);
  });

  it("takes `playing` from the audio element, never from synthesis", async () => {
    const code = stripComments(await readSrc(MODULE));
    assert.match(
      code,
      /addEventListener\("playing"/,
      '`playing` is the event that means sound is actually being rendered — `play` fires on the attempt (speak.ts:168-170)',
    );
  });

  it("stands down while the live call owns her voice", async () => {
    const code = stripComments(await readSrc(MODULE));
    assert.match(
      code,
      /getEngineState\(\)\.callLive/,
      "ONE VOICE — the same gate speakStarra takes at speak.ts:764",
    );
  });

  it("exports the stop that stopAllSpeech has to be able to call", async () => {
    const code = await readSrc(MODULE);
    assert.match(code, /export function stopLocalStream\(/);
  });
});

describe("local-voice — macOS 12 WebKit safety", () => {
  it("uses no regex lookbehind", async () => {
    const src = await readSrc(MODULE);
    assert.equal(
      /\(\?<[=!]/.test(src),
      false,
      "lookbehind is a syntax error in the WKWebView this deck runs in",
    );
  });
});

describe("stopAllSpeech — barge-in reaches the local queue", () => {
  it("speak.ts's stopAllSpeech kills the local stream too", async () => {
    const code = stripComments(await readSrc("src/lib/voice/speak.ts"));
    const body = code.slice(
      code.indexOf("export function stopAllSpeech()"),
      code.indexOf("export function stopAllSpeech()") + 400,
    );
    assert.match(
      body,
      /stopLocalStream\(\)/,
      "a stale local utterance must never play over a new turn",
    );
    assert.match(
      code,
      /from "@\/lib\/voice\/local-voice"/,
      "the seam is a one-way import: speak.ts -> local-voice, never back",
    );
  });
});
