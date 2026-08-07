/**
 * VOICE TOOLS — what she can do while she is on the phone.
 *
 * WHY THIS FILE IS A TEST: everything these return she may say OUT LOUD
 * verbatim. A regression here is not a broken payload, it is her reading JSON
 * to Classic mid-sentence, or going silent on an error. Neither is visible from
 * a status code.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GET } from "../src/app/api/voice-tools/[action]/route";

const T = "test-token-long-enough-for-the-guard-0123456789";
let saved: string | undefined;
before(() => { saved = process.env.STARRA_MCP_TOKEN; process.env.STARRA_MCP_TOKEN = T; });
after(() => { if (saved === undefined) delete process.env.STARRA_MCP_TOKEN; else process.env.STARRA_MCP_TOKEN = saved; });

/** The action is a PATH segment now, so tests pass it the way Next.js does. */
const hit = async (action: string, qs = "", tok: string = T) => {
  const r = await GET(
    new Request(`http://x/api/voice-tools/${action}?${qs}`, {
      headers: { authorization: `Bearer ${tok}` },
    }),
    { params: Promise.resolve({ action }) },
  );
  return { status: r.status, text: await r.text() };
};

describe("voice tools — she speaks, she does not serialize", () => {
  it("rejects a bad token", async () => {
    assert.equal((await hit("recall", "query=x", "nope")).status, 401);
  });

  it("FAILS CLOSED with no token configured", async () => {
    const prev = process.env.STARRA_MCP_TOKEN;
    delete process.env.STARRA_MCP_TOKEN;
    const r = await hit("recall", "query=x", "anything");
    process.env.STARRA_MCP_TOKEN = prev;
    assert.equal(r.status, 503);
  });

  it("recall returns speech, never a payload, never the whole store", async () => {
    const r = await hit("recall", "query=engine");
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /^\s*[[{]/, "must not be JSON");
    assert.ok(r.text.length < 1200, `too long to say aloud: ${r.text.length} chars`);
  });

  it("an empty query asks rather than erroring", async () => {
    assert.match((await hit("recall", "query=")).text, /Say what you want/i);
  });

  it("a miss is a sentence, not an empty result", async () => {
    assert.match((await hit("recall", "query=zzzznothinglikethis")).text, /don't have anything/i);
  });

  it("remember confirms in her voice", async () => {
    assert.match((await hit("remember", "text=call+Chase+Tuesday")).text, /remember that/i);
  });

  it("an unknown action explains itself speakably", async () => {
    assert.match((await hit("nonsense")).text, /recall something, remember something/i);
  });

  it("a missing lender answers in words, not a 404", async () => {
    const r = await hit("funding_status", "name=zzznotreal&status=applied");
    assert.equal(r.status, 200, "a phone call has no place for a 404");
    assert.match(r.text, /don't see/i);
  });

  it("every response is plain text — nothing she has to parse", async () => {
    for (const [action, qs] of [["recall", "query=a"], ["nonsense", ""], ["remember", "text=x"]]) {
      const r = await GET(
        new Request(`http://x/api/voice-tools/${action}?${qs}`, {
          headers: { authorization: `Bearer ${T}` },
        }),
        { params: Promise.resolve({ action }) },
      );
      assert.match(r.headers.get("content-type") ?? "", /text\/plain/);
    }
  });
});
