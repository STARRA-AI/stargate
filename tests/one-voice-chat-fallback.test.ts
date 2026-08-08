/**
 * ONE VOICE IN THE CHAT / OPERATOR CONSOLE — the regression bank for
 * 2026-08-08.
 *
 * Classic, again: "an error occured when she was answering a question and she
 * started using that other british voice that wasn't xai's... there's two of
 * her in there."
 *
 * He is right, and the reason I kept calling it fixed is in the source. On
 * 2026-07-30 the answer to "multiple voices" was to give Ara ONE RETRY before a
 * fallback engine may speak (speak.ts). That made the second voice RARER. It
 * never made it impossible. Two consecutive /api/tts failures still handed the
 * rest of his answer to:
 *
 *   - Piper `en_GB-cori-medium`   — a British voice, by name, or
 *   - Web Speech, whose voice picker (voice-select.ts GB_FEMALE) matches
 *     "google uk english female" / kate / serena / martha / stephanie / hazel /
 *     sonia — also British.
 *
 * Hence "that other british voice". Reducing the frequency of a wrong voice is
 * not the same as having one voice, and reporting it as fixed was wrong.
 *
 * THE RULE THIS ENCODES: a TRANSIENT failure of her real voice must never be
 * answered by a DIFFERENT voice. She goes quiet and says so, loudly. The only
 * case where a local voice may speak a chat turn is when her hosted voice was
 * never available in the first place (no key / not configured) — the documented
 * offline lane in CLAUDE.md — and even then it is announced, never silent.
 *
 * The policy lives in a pure function precisely so this is a REAL test and not
 * a source grep. speakStarra's audio path needs window/Audio/fetch and cannot
 * be unit-tested; the DECISION can.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  mayAnotherVoiceSpeak,
  type AraOutcome,
} from "../src/lib/voice/voice-fallback-policy";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

describe("a transient failure of her voice is answered by SILENCE, not a stranger", () => {
  it("refuses any other engine when Ara was selected and FAILED", () => {
    assert.equal(
      mayAnotherVoiceSpeak({ outcome: "failed", araSelected: true }),
      false,
      "this is the exact bug he reported: an error mid-answer, then a British voice",
    );
  });

  it("still refuses after a retry — the retry was never the fix", () => {
    // Two attempts both failing is precisely the 2026-07-30 'fixed' path.
    const first = mayAnotherVoiceSpeak({ outcome: "failed", araSelected: true });
    const afterRetry = mayAnotherVoiceSpeak({
      outcome: "failed",
      araSelected: true,
    });
    assert.equal(first, false);
    assert.equal(afterRetry, false, "a second failure is still not permission");
  });

  it("allows the local voice ONLY when her hosted voice was never configured", () => {
    // 204 from /api/tts = no key. This is the documented offline lane, not a
    // mid-answer error, and it is the one case a local voice is correct.
    assert.equal(
      mayAnotherVoiceSpeak({ outcome: "unconfigured", araSelected: true }),
      true,
    );
  });

  it("honors the operator explicitly choosing a non-Ara voice", () => {
    // If Classic picked a Web Speech voice in Settings, that IS his choice and
    // nothing here overrides it.
    assert.equal(
      mayAnotherVoiceSpeak({ outcome: "not-attempted", araSelected: false }),
      true,
    );
  });

  it("never lets an aborted utterance summon a second voice", () => {
    // Barge-in / new turn. Silence is correct; another engine here is how she
    // talks over herself.
    assert.equal(
      mayAnotherVoiceSpeak({ outcome: "aborted", araSelected: true }),
      false,
    );
  });

  it("treats an unknown outcome as failure — fail CLOSED, never into a voice", () => {
    assert.equal(
      mayAnotherVoiceSpeak({
        outcome: "something-new" as AraOutcome,
        araSelected: true,
      }),
      false,
      "a new outcome added later must not silently re-open the second voice",
    );
  });
});

describe("speakStarra actually routes through the policy", () => {
  const src = read("src/lib/voice/speak.ts");

  it("imports and calls the policy rather than falling through unguarded", () => {
    assert.match(src, /mayAnotherVoiceSpeak/);
  });

  it("no longer claims Piper is the preferred voice", () => {
    // The file header used to read "prefers Piper Cori". Her voice is Ara/eve.
    assert.doesNotMatch(
      src,
      /prefers Piper Cori/,
      "the doc comment contradicted the one-voice rule and misled every reader",
    );
  });

  it("does not tell itself a second-choice voice beats silence", () => {
    assert.doesNotMatch(
      src,
      /better a\s*\n?\s*\*?\s*second-choice voice than silence/,
      "that comment IS the bug's rationale, stated in the source",
    );
  });
});
