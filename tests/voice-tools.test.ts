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
import { GET } from "../src/app/api/voice-tools/route";

const T = "test-token-long-enough-for-the-guard-0123456789";
let saved: string | undefined;
before(() => { saved = process.env.STARRA_MCP_TOKEN; process.env.STARRA_MCP_TOKEN = T; });
after(() => { if (saved === undefined) delete process.env.STARRA_MCP_TOKEN; else process.env.STARRA_MCP_TOKEN = saved; });

const hit = async (qs: string, tok: string = T) => {
  const r = await GET(new Request(`http://x/api/voice-tools?${qs}`, {
    headers: { authorization: `Bearer ${tok}` },
  }));
  return { status: r.status, text: await r.text() };
};

describe("voice tools — she speaks, she does not serialize", () => {
  it("rejects a bad token", async () => {
    assert.equal((await hit("action=recall&query=x", "nope")).status, 401);
  });

  it("FAILS CLOSED with no token configured", async () => {
    const prev = process.env.STARRA_MCP_TOKEN;
    delete process.env.STARRA_MCP_TOKEN;
    const r = await hit("action=recall&query=x", "anything");
    process.env.STARRA_MCP_TOKEN = prev;
    assert.equal(r.status, 503);
  });

  it("recall returns speech, never a payload, never the whole store", async () => {
    const r = await hit("action=recall&query=engine");
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /^\s*[[{]/, "must not be JSON");
    assert.ok(r.text.length < 1200, `too long to say aloud: ${r.text.length} chars`);
  });

  it("an empty query asks rather than erroring", async () => {
    assert.match((await hit("action=recall&query=")).text, /Say what you want/i);
  });

  it("a miss is a sentence, not an empty result", async () => {
    assert.match((await hit("action=recall&query=zzzznothinglikethis")).text, /don't have anything/i);
  });

  it("remember confirms in her voice", async () => {
    assert.match((await hit("action=remember&text=call+Chase+Tuesday")).text, /remember that/i);
  });

  it("an unknown action explains itself speakably", async () => {
    assert.match((await hit("action=nonsense")).text, /recall something, remember something/i);
  });

  it("a missing lender answers in words, not a 404", async () => {
    const r = await hit("action=funding_status&name=zzznotreal&status=applied");
    assert.equal(r.status, 200, "a phone call has no place for a 404");
    assert.match(r.text, /don't see/i);
  });

  it("every response is plain text — nothing she has to parse", async () => {
    for (const qs of ["action=recall&query=a", "action=nonsense", "action=remember&text=x"]) {
      const r = await GET(new Request(`http://x/api/voice-tools?${qs}`, {
        headers: { authorization: `Bearer ${T}` },
      }));
      assert.match(r.headers.get("content-type") ?? "", /text\/plain/);
    }
  });
});
