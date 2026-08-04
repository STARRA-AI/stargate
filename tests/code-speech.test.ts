/**
 * CODE ON THE CALL — pure decisions (src/lib/voice/code-speech.ts).
 *
 * isCodeAsk routes typed mid-call code asks to the brain (the realtime
 * session answers in audio and cannot carry a fenced block); speakableText
 * decides what TTS may say of a brain reply. The fence rule must match
 * markdown.tsx's toBlocks (`^```` at line start) so what the deck sections
 * off and what the voice skips never disagree.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCodeAsk, speakableText } from "../src/lib/voice/code-speech";

describe("isCodeAsk", () => {
  it("routes plain code requests", () => {
    assert.equal(isCodeAsk("write me a python script that renames files"), true);
    assert.equal(isCodeAsk("give me the code for the login page"), true);
    assert.equal(isCodeAsk("what's the command to restart the server"), true);
    assert.equal(isCodeAsk("fix this function real quick"), true);
    assert.equal(isCodeAsk("show me the SQL for that"), true);
  });

  it("routes file-extension and backtick talk", () => {
    assert.equal(isCodeAsk("open deck.css and change the border"), true);
    assert.equal(isCodeAsk("what does `--effort` do"), true);
    assert.equal(isCodeAsk("here's what I have\n```\nls -la\n```"), true);
  });

  it("lets normal conversation ride the voice call", () => {
    assert.equal(isCodeAsk("hey baby how you doing"), false);
    assert.equal(isCodeAsk("what time is my meeting tomorrow"), false);
    assert.equal(isCodeAsk("tell me about the foundation plan"), false);
    assert.equal(isCodeAsk("I love you"), false);
    assert.equal(isCodeAsk(""), false);
    assert.equal(isCodeAsk("   "), false);
  });
});

describe("speakableText", () => {
  it("speaks the prose and drops the fence", () => {
    const reply =
      "Here's the script, baby — it's in the chat.\n```python\nprint('hi')\nx = 1\n```\nRun it from the engine folder.";
    assert.equal(
      speakableText(reply),
      "Here's the script, baby — it's in the chat.\nRun it from the engine folder.",
    );
  });

  it("drops an unterminated (still-streaming) fence like the renderer does", () => {
    const reply = "One sec.\n```bash\ncurl http://x";
    assert.equal(speakableText(reply), "One sec.");
  });

  it("reads inline backticks silently", () => {
    assert.equal(speakableText("set `LLM_PROVIDER` to `kimi`"), "set LLM_PROVIDER to kimi");
  });

  it("never leaves her with dead air on a code-only reply", () => {
    assert.equal(speakableText("```js\nconsole.log(1)\n```"), "It's in the chat.");
  });

  it("passes a plain reply through untouched", () => {
    assert.equal(speakableText("Copy. On it."), "Copy. On it.");
  });

  it("collapses the blank line a removed block leaves behind", () => {
    const reply = "Before.\n\n```sh\nls\n```\n\nAfter.";
    assert.equal(speakableText(reply), "Before.\nAfter.");
  });
});
