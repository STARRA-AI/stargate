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
  isForeignSession,
  MAX_SENTENCE_CHARS,
  MIN_SENTENCE_CHARS,
  seedComplete,
  splitSentences,
  takeSentences,
  toSpeakableSentences,
} from "../src/lib/voice/local-voice";
import { PIPER_VOICE_ID } from "../src/lib/voice/piper-speak";

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

/**
 * FIX WAVE — the two load-chain holes and the cross-lane kill.
 *
 * The DECISIONS are unit-tested for real (both predicates are pure and
 * exported for exactly that reason); the WIRING — that the predicates are the
 * thing the load path actually consults — is source-pattern pinned, because
 * the branches around them need OPFS, WebAssembly and a browser.
 */
describe("isForeignSession — a session we did not build is not ours to trust", () => {
  it("is false when there is no singleton yet", () => {
    assert.equal(isForeignSession(null, null), false);
    assert.equal(isForeignSession(undefined, null), false);
  });

  it("is false for the session we created ourselves", () => {
    const ours = { voiceId: "en_GB-cori-high" };
    assert.equal(isForeignSession(ours, ours), false);
  });

  it("is TRUE when somebody else built the singleton first", () => {
    // The real case: speak.ts's normal-lane Piper leg ran, piper-runtime built
    // the process-wide instance, and its #wasmPaths cannot be read from here.
    const theirs = { voiceId: "en_GB-cori-high" };
    assert.equal(isForeignSession(theirs, null), true);
    assert.equal(isForeignSession(theirs, { voiceId: "other" }), true);
  });
});

describe("seedComplete — a half-seeded OPFS is not a seed", () => {
  it("accepts only both files, both non-empty", () => {
    assert.equal(seedComplete(1024, 512), true);
  });

  it("rejects the interrupted seed that used to pass", () => {
    // THE BUG: `<voice>.onnx` written, `.onnx.json` not yet. The old guard saw
    // one non-empty file and declared victory; the library then fetched the
    // config from huggingface.co — on a private turn.
    assert.equal(seedComplete(1024, 0), false);
    assert.equal(seedComplete(0, 512), false);
    assert.equal(seedComplete(0, 0), false);
  });

  it("rejects a size that is not a real number", () => {
    assert.equal(seedComplete(Number.NaN, 512), false);
    assert.equal(seedComplete(1024, Number.NaN), false);
    assert.equal(seedComplete(Number.POSITIVE_INFINITY, 512), false);
  });
});

describe("the load chain consults those decisions", () => {
  it("getSession refuses a foreign singleton instead of synthesising through it", async () => {
    const code = stripComments(await readSrc(MODULE));
    const body = code.slice(code.indexOf("async function getSession("));
    assert.match(
      body,
      /isForeignSession\(\s*TtsSession\._instance\s*,\s*ownedSession\s*\)/,
      "identity is the only thing provable from outside — #wasmPaths is a private field (dist:357)",
    );
    assert.match(
      body.slice(0, body.indexOf("TtsSession.create")),
      /throw new Error\(/,
      "the refusal must happen BEFORE create() — predict() re-creates the phonemizer from #wasmPaths on every call (dist:301-315)",
    );
    assert.match(
      body,
      /ownedSession\s*=\s*session/,
      "the session we build must be recorded, or we would refuse our own on the next call",
    );
  });

  it("both OPFS seeds check BOTH files", async () => {
    for (const [file, fn] of [
      [MODULE, "seedOpfs"],
      ["src/lib/voice/piper-runtime.ts", "seedOpfsFromPublic"],
    ] as const) {
      const code = stripComments(await readSrc(file));
      const body = code.slice(code.indexOf(`function ${fn}(`));
      assert.match(
        body,
        /getFileHandle\(`\$\{[A-Za-z_]+\}\.onnx`\)/,
        `${fn} must handle the model`,
      );
      assert.match(
        body,
        /getFileHandle\(`\$\{[A-Za-z_]+\}\.onnx\.json`\)/,
        `${fn} must ALSO handle the config — a missing json is what reaches huggingface`,
      );
      assert.match(
        body,
        /seedComplete\([A-Za-z]+\.size,\s*[A-Za-z]+\.size\)/,
        `${fn} must decide on both sizes through the shared predicate`,
      );
    }
  });

  it("piper-runtime pins its session to the same local WASM", async () => {
    const code = stripComments(await readSrc("src/lib/voice/piper-runtime.ts"));
    assert.match(
      code,
      /TtsSession\.create\(\{[\s\S]{0,200}?wasmPaths:\s*LOCAL_WASM_PATHS/,
      "a CDN-configured singleton built by the NORMAL lane arms every later private synthesis (dist:259-263)",
    );
    assert.match(
      code,
      /from "@\/lib\/voice\/local-voice"/,
      "one definition of the local paths, shared — not a second copy to drift",
    );
  });
});

/**
 * N1 — THE OWNERSHIP-CAPTURE RACE.
 *
 * `TtsSession.create` is `new TtsSession(...)` then `await waitReady`
 * (dist:265-269), and the CONSTRUCTOR assigns `_instance` synchronously
 * (dist:272). So between the constructor and a failed `init()`, the singleton
 * is ours while our `ownedSession` is still null — and `isForeignSession` then
 * reports our OWN session as foreign, forever, silencing her local voice for
 * the life of the page over one transient failure.
 *
 * Behavioural: the library's ordering is simulated exactly (constructor sets
 * the instance, then the promise rejects), and both capture orders are run
 * against the real predicate.
 */
describe("ownership capture — a failed init must not poison the singleton", () => {
  /** Stands in for the library: `_instance` set synchronously, then init fails. */
  const libraryWithFailingInit = () => {
    const lib: { _instance: unknown } = { _instance: null };
    const create = () => {
      lib._instance = { voiceId: "en_GB-cori-high" }; // constructor, dist:272
      return Promise.reject(new Error("init failed")); // await waitReady
    };
    return { lib, create };
  };

  it("capturing BEFORE the await keeps our own session ours", async () => {
    const { lib, create } = libraryWithFailingInit();
    let owned: unknown = null;
    const creating = create().catch(() => undefined);
    owned = lib._instance; // THE FIX
    await creating;
    assert.equal(
      isForeignSession(lib._instance, owned),
      false,
      "a session we built must stay ours even when its init threw",
    );
  });

  it("capturing only AFTER the await is what poisoned it", async () => {
    const { lib, create } = libraryWithFailingInit();
    let owned: unknown = null;
    try {
      owned = await create(); // never runs — this is the old order
    } catch {
      /* init failed, so ownership was never recorded */
    }
    assert.equal(
      isForeignSession(lib._instance, owned),
      true,
      "this is the bug: our own session reads as foreign, and every retry refuses",
    );
  });

  it("getSession captures ownership before awaiting create", async () => {
    const code = stripComments(await readSrc(MODULE));
    const body = code.slice(code.indexOf("async function getSession("));
    const capture = body.indexOf("ownedSession = TtsSession._instance");
    const awaited = body.indexOf("await creating");
    assert.ok(capture > 0, "ownership must be captured from the singleton itself");
    assert.ok(
      awaited > capture,
      "the capture must precede the await, or a rejected init skips it entirely",
    );
    assert.equal(
      /await TtsSession\.create\(/.test(body),
      false,
      "awaiting create() inline is exactly the order that loses ownership",
    );
  });
});

describe("the call gate refuses without side effects", () => {
  it("declines during a live call but does not stop the stream", async () => {
    const code = stripComments(await readSrc(MODULE));
    const gate = code.slice(
      code.indexOf("if (!options?.allowDuringCall && getEngineState().callLive)"),
    );
    const block = gate.slice(0, gate.indexOf("}") + 1);
    assert.match(block, /return "none";/, "the chat lane stays silent during a call");
    assert.equal(
      /stopLocalStream\(\)/.test(block),
      false,
      "once the private call speaks with allowDuringCall, stopping here would kill the CALL'S utterance mid-sentence — a chat turn does not own the call's stream",
    );
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

  /**
   * The scoping half of the same rule. The behavioural proof — that the call's
   * local voice actually survives a gated chat turn — lives in
   * tests/one-voice-call-gate.test.ts, which drives speakStarra for real. This
   * pins the SHAPE so the two stops cannot silently re-merge.
   */
  it("stopHostedSpeech stops only what speak.ts owns", async () => {
    const code = stripComments(await readSrc("src/lib/voice/speak.ts"));
    const start = code.indexOf("export function stopHostedSpeech()");
    assert.ok(start > 0, "the hosted-only stop must exist");
    const body = code.slice(start, code.indexOf("export function stopAllSpeech()"));
    assert.equal(
      /stopLocalStream\(\)/.test(body),
      false,
      "the hosted stop must not reach the local mouth — during a call that stream may be HER CALL VOICE",
    );
    for (const owned of ["stopAraAudio()", "stopPiperAudio()", "speechSynthesis.cancel()"]) {
      assert.ok(body.includes(owned), `the hosted stop must still stop ${owned}`);
    }
  });

  it("speakStarra's callLive gate stands down without stopping the local stream", async () => {
    const code = stripComments(await readSrc("src/lib/voice/speak.ts"));
    const gate = code.slice(code.indexOf("if (getEngineState().callLive)"));
    const block = gate.slice(0, gate.indexOf("}") + 1);
    assert.match(block, /stopHostedSpeech\(\);/);
    assert.equal(
      /stopAllSpeech\(\);/.test(block),
      false,
      "stopAllSpeech now includes stopLocalStream — using it here kills the call's own utterance",
    );
    assert.match(block, /return "none";/);
  });
});

/* ───────────────── TASK 6 — the default tier is the one she can speak in ─────
 * Same speaker either way — `medium` and `high` are both Cori, so Book 1 §7's
 * "one consistent voice" is untouched. What changed is the TIER, and it changed
 * on a measurement, not a preference (.superpowers/sdd/p2-task-4-report.md §7,
 * real browser, same page, same code path):
 *
 *   RTF (wall / audio produced)   high 3.14 / 2.78    medium 0.39 / 0.36
 *   TtsSession.create             high 7 783 ms       medium 3 753 ms
 *   OPFS seed                     high 2 369 ms       medium 1 387 ms
 *
 * RTF > 1 means she takes longer to say a sentence than the sentence lasts. On
 * a live private call that is not a voice, it is a wait — so the default is the
 * tier that runs faster than speech, and `high` stays one override away.
 * ──────────────────────────────────────────────────────────────────────────── */
describe("local voice — the default Piper voice", () => {
  it("is Cori at the medium tier", () => {
    assert.equal(PIPER_VOICE_ID, "en_GB-cori-medium");
  });

  it("is still CORI — the tier moved, the voice did not", () => {
    assert.match(PIPER_VOICE_ID, /^en_GB-cori-/);
  });

  it("is a shape getLocalVoiceId would itself accept", () => {
    // The override validator (local-voice.ts) refuses ids it cannot resolve, so
    // a default it would reject is a default that could not be re-selected.
    assert.match(
      PIPER_VOICE_ID,
      /^[a-z]{2}_[A-Z]{2}-[a-z0-9_]+-(x_low|low|medium|high)$/,
    );
  });

  it("keeps the fetch script and the code pointed at the same file", async () => {
    // A default the bootstrap script does not fetch is a silent mouth on a
    // fresh checkout: localAssetsAvailable() HEAD-checks THIS id's files.
    const { readFile } = await import("node:fs/promises");
    const sh = await readFile(
      new URL("../scripts/bootstrap-piper-assets.sh", import.meta.url),
      "utf8",
    );
    assert.match(sh, new RegExp(`VOICE_ID="\\$\\{1:-${PIPER_VOICE_ID}\\}"`));
    const py = await readFile(
      new URL("../scripts/download_voice.py", import.meta.url),
      "utf8",
    );
    assert.ok(
      py.includes(`"${PIPER_VOICE_ID}.onnx"`),
      "scripts/download_voice.py must fetch the voice the code actually loads",
    );
  });
});
