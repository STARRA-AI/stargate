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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GET } from "../src/app/api/voice-tools/[action]/route";

// Denials are reported through captureError (shared invariant: no bare return
// on a failure path), which writes to sqlite. Point that at a temp DB so this
// suite never drops test noise into the real deck's errors table. getDb() is
// lazy, so setting it after the static import is still in time.
process.env.STARGATE_DB_PATH = join(
  tmpdir(),
  `voice-tools-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
);

const T = "test-token-long-enough-for-the-guard-0123456789";
/** Writes need their OWN key now, and it must differ from the read key. */
const W = "write-token-long-enough-for-the-guard-012345678";
const WRITE_ACTIONS = new Set(["remember", "note", "funding_status"]);
let saved: string | undefined;
let savedW: string | undefined;
before(() => {
  saved = process.env.STARRA_MCP_TOKEN;
  savedW = process.env.STARRA_MCP_WRITE_TOKEN;
  process.env.STARRA_MCP_TOKEN = T;
  process.env.STARRA_MCP_WRITE_TOKEN = W;
});
after(() => {
  if (saved === undefined) delete process.env.STARRA_MCP_TOKEN; else process.env.STARRA_MCP_TOKEN = saved;
  if (savedW === undefined) delete process.env.STARRA_MCP_WRITE_TOKEN; else process.env.STARRA_MCP_WRITE_TOKEN = savedW;
});

/** The action is a PATH segment now, so tests pass it the way Next.js does.
 *  The default token is whichever one that action legitimately needs. */
const hit = async (action: string, qs = "", tok: string = WRITE_ACTIONS.has(action) ? W : T) => {
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
          headers: {
            authorization: `Bearer ${WRITE_ACTIONS.has(action as string) ? W : T}`,
          },
        }),
        { params: Promise.resolve({ action }) },
      );
      assert.match(r.headers.get("content-type") ?? "", /text\/plain/);
    }
  });

  // ── the split itself, driven through the real route ──────────────────────
  it("the READ token cannot remember — a stranger must not rewrite her", async () => {
    const r = await hit("remember", "text=she+loves+brussels+sprouts", T);
    assert.equal(r.status, 403, "read access leaks; write access rewrites her");
  });

  it("the READ token cannot take a note or move a funding lead either", async () => {
    assert.equal((await hit("note", "text=x", T)).status, 403);
    assert.equal((await hit("funding_status", "name=a&status=b", T)).status, 403);
  });

  it("the WRITE token still reads — it is the stronger key, not a parallel one", async () => {
    assert.equal((await hit("recall", "query=engine", W)).status, 200);
  });

  it("with NO write token configured, writes are denied and reads survive", async () => {
    const prev = process.env.STARRA_MCP_WRITE_TOKEN;
    delete process.env.STARRA_MCP_WRITE_TOKEN;
    const write = await hit("remember", "text=x", T);
    const read = await hit("recall", "query=engine", T);
    process.env.STARRA_MCP_WRITE_TOKEN = prev;
    assert.equal(write.status, 403, "absent must never mean open");
    assert.equal(read.status, 200, "a missing variable costs capability, not the read surface");
  });

  it("a denial is still speech — never JSON, never a stack", async () => {
    const r = await hit("remember", "text=x", T);
    assert.doesNotMatch(r.text, /^\s*[[{]/);
    assert.doesNotMatch(r.text, /\n\s+at /);
  });
});
