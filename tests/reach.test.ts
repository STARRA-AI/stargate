/**
 * AGENT REACH — parsing and URL safety.
 *
 * Pins the two things that must not regress: only EXPLICIT operator commands
 * enter the fast-path (free-form intent belongs to the LLM), and only http/https
 * URLs ever reach a spawned process.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseReachCommand, safeUrl } from "../src/lib/tools/reach";

describe("agent reach — url safety", () => {
  it("accepts http and https", () => {
    assert.ok(safeUrl("https://example.com"));
    assert.ok(safeUrl("http://example.com/a?b=c"));
  });

  it("refuses every non-web scheme", () => {
    for (const bad of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>",
      "ftp://example.com",
      "not a url",
      "",
    ]) {
      assert.equal(safeUrl(bad), null, bad);
    }
  });

  it("does not let shell metacharacters change the target", () => {
    // spawn() takes an argv array so this can never become a second command;
    // it either parses as one URL or is refused outright.
    const u = safeUrl("https://example.com/a;rm -rf ~");
    assert.ok(u === null || u.startsWith("https://example.com/"), u ?? "null");
  });
});

describe("agent reach — command parsing", () => {
  it("parses the explicit verbs", () => {
    assert.deepEqual(parseReachCommand("reach read https://example.com"), {
      kind: "read",
      url: "https://example.com",
    });
    assert.deepEqual(parseReachCommand("reach video https://youtu.be/x"), {
      kind: "video",
      url: "https://youtu.be/x",
    });
    assert.deepEqual(parseReachCommand("reach watch https://youtu.be/x"), {
      kind: "video",
      url: "https://youtu.be/x",
    });
    assert.deepEqual(parseReachCommand("reach feed https://hnrss.org/frontpage"), {
      kind: "feed",
      url: "https://hnrss.org/frontpage",
    });
    assert.deepEqual(parseReachCommand("reach status"), { kind: "status" });
  });

  it("ignores conversation that merely contains the word", () => {
    // The fast-path must not hijack ordinary speech — this is why the regex is
    // anchored to the start of the message.
    for (const nope of [
      "can you reach out to him",
      "that's out of reach",
      "I'll reach read later", // no url
      "",
    ]) {
      assert.equal(parseReachCommand(nope), null, nope);
    }
  });

  it("requires a target for everything except status", () => {
    assert.equal(parseReachCommand("reach read"), null);
    assert.equal(parseReachCommand("reach video"), null);
  });
});
