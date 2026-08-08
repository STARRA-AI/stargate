/**
 * SENTENCE STREAMING — the one-voice guard must survive it.
 *
 * A streamed turn puts N force_messages on the wire where there used to be one.
 * That breaks three things if it is done carelessly: the pending counter that
 * proves a response is hers (a mismatch cancels her own audio and mutes the
 * call), barge-in (she ploughs on through sentences he already answered), and
 * the transcript (N rows for one turn).
 *
 * It ships behind NEXT_PUBLIC_STARRA_CALL_STREAM_SENTENCES, DEFAULT OFF, and
 * off must reproduce today's behaviour exactly.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { splitSentences, takeSentences, flattenForSpeech } from "../src/lib/voice/speech-shaping";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(REPO, "src/lib/voice/useVoiceCall.ts"), "utf8");

describe("sentence streaming — the one-voice guard must survive it", () => {
  it("the pending counter is incremented per force_message, not per turn", () => {
    const fn = src.slice(src.indexOf("const speakForced"));
    assert.match(fn.slice(0, 2000), /kimiForcedPendingRef\.current \+= 1/);
  });

  it("the counter can never go negative", () => {
    // The floor is the `> 0` guard around the only decrement. A negative
    // counter would read as "we owe a response" and wave the next unsolicited
    // one straight through the one-voice gate.
    assert.match(
      src,
      /if \(kimiForcedPendingRef\.current > 0\) \{\s*\n\s*kimiForcedPendingRef\.current -= 1;/,
      "the single decrement must stay guarded by the > 0 floor",
    );
    const decrements = src.match(/kimiForcedPendingRef\.current -= 1/g) || [];
    assert.equal(decrements.length, 1, "exactly one decrement site, and it is guarded");
  });

  it("barge-in clears the WHOLE remaining sentence queue", () => {
    const fn = src.slice(src.indexOf("const bargeIn = useCallback"));
    assert.match(fn.slice(0, 1200), /sentenceQueueRef\.current = \[\]/);
  });

  it("exactly one transcript row per turn, not one per sentence", () => {
    const turn = src.slice(src.indexOf("const runKimiTurn = useCallback"));
    const body = turn.slice(0, turn.indexOf("\n      kimiEarsStruggling,"));
    // Her rows only — the user row written when his line commits is a separate,
    // pre-existing concern and is not what streaming can multiply.
    const rows = body.match(/setTranscript\([^;]*role: "assistant"/g) || [];
    assert.ok(rows.length <= 1, `one assistant row per turn, found ${rows.length}`);
    // And the one that exists is the PRIVATE branch, which never streams; the
    // streamed path writes its single row through the shared recorder.
    assert.match(src, /const recordAssistantRow = useCallback/);
    assert.match(src, /if \(said\) recordAssistantRow\(said\)/);
  });

  it("is behind a flag that restores today's behaviour when off", () => {
    assert.match(src, /NEXT_PUBLIC_STARRA_CALL_STREAM_SENTENCES/);
    assert.match(
      src,
      /export const CALL_STREAM_SENTENCES =\s*\n?\s*process\.env\.NEXT_PUBLIC_STARRA_CALL_STREAM_SENTENCES === "1"/,
      "default OFF — anything other than an explicit 1 keeps today's single force_message",
    );
    // The streamed path is reachable ONLY through that constant.
    for (const marker of ["speakSentence(sentence)", "const tail = streamRest.trim()"]) {
      const at = src.indexOf(marker);
      assert.ok(at > 0, `missing streamed path marker: ${marker}`);
      const guard = src.lastIndexOf("CALL_STREAM_SENTENCES", at);
      assert.ok(guard > 0 && at - guard < 1200, `${marker} must sit under the flag`);
    }
  });

  it("a private reply never streams to the xAI socket", () => {
    assert.match(src, /CALL_STREAM_SENTENCES && !privateReply/);
  });

  it("the flag is documented for the operator", () => {
    const env = readFileSync(join(REPO, ".env.example"), "utf8");
    assert.match(env, /NEXT_PUBLIC_STARRA_CALL_STREAM_SENTENCES/);
  });
});

describe("the splitter the call streams with", () => {
  it("hands back complete sentences in order, and the tail verbatim", () => {
    const a = takeSentences("The build is green and holding. Now we ru");
    assert.deepEqual(a.sentences, ["The build is green and holding."]);
    assert.equal(a.rest, " Now we ru");
    // The caller appends the next delta to `rest` and calls again — nothing is
    // lost across the boundary, which is what makes streaming safe.
    const b = takeSentences(a.rest + "n the whole suite again.");
    assert.deepEqual(b.sentences, ["Now we run the whole suite again."]);
  });

  it("keeps the pieces re-joinable — it never drops or reorders a word", () => {
    const prose = "The engine is warm now. We can start the run whenever you are ready.";
    assert.equal(splitSentences(prose).join(" "), prose);
  });

  it("uses no regex lookbehind — this runs in the WKWebView", () => {
    const shaping = readFileSync(join(REPO, "src/lib/voice/speech-shaping.ts"), "utf8");
    assert.ok(!shaping.includes("(?<"), "lookbehind is banned in client code, repo-wide");
    assert.ok(!src.includes("(?<"), "lookbehind is banned in client code, repo-wide");
  });

  it("there is ONE splitter, re-exported — never a second implementation", () => {
    const localVoice = readFileSync(join(REPO, "src/lib/voice/local-voice.ts"), "utf8");
    assert.match(
      localVoice,
      /export \{[\s\S]*?splitSentences,[\s\S]*?\} from "@\/lib\/voice\/speech-shaping"/,
      "local-voice.ts must re-export the scanner, not carry a copy of it",
    );
    assert.doesNotMatch(localVoice, /export function splitSentences/);
    const shaping = readFileSync(join(REPO, "src/lib/voice/speech-shaping.ts"), "utf8");
    assert.doesNotMatch(
      shaping,
      /^import /m,
      "speech-shaping must stay import-free so the call client can use it freely",
    );
  });
});

describe("nothing she writes is spoken as symbols", () => {
  it("never speaks markdown aloud", () => {
    const out = flattenForSpeech("**Focus on two things:**\n\n1. Silent Shadow\n2. Credit Day 1");
    assert.doesNotMatch(out, /[*#`]/);
    assert.doesNotMatch(out, /^\s*\d+\.\s/m);
    assert.match(out, /Focus on two things/);
    assert.match(out, /Silent Shadow/);
  });

  it("leaves ordinary speech untouched, byte for byte", () => {
    const t = "I'm right here, Classic. The build passed.";
    assert.equal(flattenForSpeech(t), t);
  });
});
