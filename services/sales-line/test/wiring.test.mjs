/**
 * THE WIRING SUITE — the Twilio-facing half of the sales line.
 *
 * isolation.test.mjs pins the safety promise (nothing personal escapes). This
 * suite pins the things that decide whether a call CONNECTS AT ALL, each of
 * which has a failure mode that looks like something else:
 *
 *   - an API Key SID in TWILIO_ACCOUNT_SID authenticates fine and then 404s,
 *     which reads as "the number is wrong";
 *   - a console-formatted number `(615) 437-4490` fails at dial time, which
 *     reads as "Twilio is broken";
 *   - a rotating tunnel hostname captured at boot points every call at an
 *     address nothing answers on, which reads as "she stopped working".
 *
 * All three have bitten this project. They are tests now.
 */
import { strict as assert } from "node:assert";
import { describe, it, after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { toE164 } from "../phone.mjs";

const HERE_SRC = path.dirname(fileURLToPath(import.meta.url)) + "/..";
import { loadEnvFile } from "../env.mjs";

describe("E.164 normalisation", () => {
  it("passes through a number that is already E.164", () => {
    assert.equal(toE164("+16154374490"), "+16154374490");
  });

  it("accepts what the Twilio console actually shows you", () => {
    // This exact string was pasted into .env.local and broke the dialer.
    assert.equal(toE164("(615) 437-4490"), "+16154374490");
  });

  it("accepts the other shapes a human types", () => {
    for (const s of ["615-437-4490", "615.437.4490", "6154374490", "1 615 437 4490", "+1 (615) 437-4490"]) {
      assert.equal(toE164(s), "+16154374490", s);
    }
  });

  it("REFUSES anything ambiguous rather than dialling a guess", () => {
    for (const bad of ["", "   ", null, undefined, 42, {}, "abc", "555", "+", "12345678901234567890"]) {
      assert.equal(toE164(bad), null, String(bad));
    }
  });

  it("does not invent a country code for a short international-looking string", () => {
    // 8 digits is not a US number; guessing +1 would dial a stranger.
    assert.equal(toE164("12345678"), null);
  });
});

describe("the env file loader", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sales-env-"));
  const f = path.join(dir, ".env.local");

  it("keeps values containing spaces and parentheses", () => {
    // A loader that drops these hands back an EMPTY number, and the service
    // then reports the key as 'missing' when it is right there in the file.
    writeFileSync(f, "TWILIO_SALES_NUMBER=(615) 437-4490\nOTHER=x\n");
    assert.equal(loadEnvFile(f).TWILIO_SALES_NUMBER, "(615) 437-4490");
  });

  it("strips surrounding quotes but not inner characters", () => {
    writeFileSync(f, 'A="hello world"\nB=plain\n');
    const e = loadEnvFile(f);
    assert.equal(e.A, "hello world");
    assert.equal(e.B, "plain");
  });

  it("returns {} for a missing file instead of throwing", () => {
    assert.deepEqual(loadEnvFile(path.join(dir, "nope")), {});
  });

  it("ignores comments and blank lines", () => {
    writeFileSync(f, "# a comment\n\nREAL=1\n");
    const e = loadEnvFile(f);
    assert.equal(e.REAL, "1");
    assert.ok(!("#" in e));
  });

  // rmSync at suite-definition time deletes the directory BEFORE the async
  // tests run. Cleanup belongs in a hook.
  after(() => rmSync(dir, { recursive: true, force: true }));
});

describe("the public origin", () => {
  it("prefers a pinned SALES_PUBLIC_ORIGIN over any recorded tunnel", async () => {
    const { currentOrigin, originIsEphemeral } = await import("../origin.mjs");
    const env = { SALES_PUBLIC_ORIGIN: "https://pinned.example.com/" };
    assert.equal(currentOrigin(env), "https://pinned.example.com");
    assert.equal(originIsEphemeral(env), false, "a pinned origin is not ephemeral");
  });

  it("refuses to record a non-https origin", async () => {
    const { writeOrigin } = await import("../origin.mjs");
    for (const bad of ["http://x.com", "ftp://x", "not a url", ""]) {
      assert.throws(() => writeOrigin(bad), /non-https/, bad);
    }
  });
});

describe("Twilio credentials — the SK-vs-AC trap", () => {
  it("REFUSES an API Key SID in the account-sid slot", async () => {
    const { setVoiceWebhook } = await import("../twilio-admin.mjs");
    await assert.rejects(
      () => setVoiceWebhook("https://x.example.com", {
        TWILIO_ACCOUNT_SID: "SKb4370000000000000000000000000000",
        TWILIO_API_KEY_SECRET: "s".repeat(32),
        TWILIO_SALES_NUMBER: "+16154374490",
      }),
      /must be the ACCOUNT sid/,
      "an SK sid in TWILIO_ACCOUNT_SID authenticates and then 404s — catch it early",
    );
  });

  it("refuses a non-https webhook origin before touching the network", async () => {
    const { setVoiceWebhook } = await import("../twilio-admin.mjs");
    await assert.rejects(
      () => setVoiceWebhook("http://insecure.example.com", {
        TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
        TWILIO_AUTH_TOKEN: "t".repeat(32),
        TWILIO_SALES_NUMBER: "+16154374490",
      }),
      /non-https/,
    );
  });

  it("refuses when no credential is configured at all", async () => {
    const { findSalesNumber } = await import("../twilio-admin.mjs");
    await assert.rejects(
      () => findSalesNumber({ TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32), TWILIO_SALES_NUMBER: "+1615" }),
      /no Twilio credential/,
    );
  });
});

describe("tunnel policy — the 502 trap", () => {
  it("a 502 means the TUNNEL IS UP and the bridge is not answering", async () => {
    // THE BUG THIS PINS. The supervisor starts bridge and tunnel together, so
    // the first probe routinely lands while the bridge is still booting. The
    // original probe required res.ok, read that 502 as "tunnel dead", killed a
    // healthy tunnel and requested another — ~15 quick tunnels in an hour,
    // which tripped trycloudflare's per-IP creation limit and then looked
    // exactly like a Cloudflare outage. It was self-inflicted.
    const { edgeIsUp, originIsHealthy } = await import("../tunnel-policy.mjs");
    assert.equal(edgeIsUp({ status: 502 }), true, "502 = the edge answered = tunnel serving");
    assert.equal(originIsHealthy({ status: 502 }), false, "502 = the bridge is not healthy");
  });

  it("only a thrown fetch means the tunnel itself is down", async () => {
    const { edgeIsUp } = await import("../tunnel-policy.mjs");
    assert.equal(edgeIsUp(null), false);
    assert.equal(edgeIsUp(undefined), false);
    assert.equal(edgeIsUp({}), false, "a result with no status is not an answer");
  });

  it("treats every real http status as the edge being up", async () => {
    const { edgeIsUp } = await import("../tunnel-policy.mjs");
    for (const status of [200, 204, 301, 401, 404, 500, 502, 503, 530]) {
      assert.equal(edgeIsUp({ status }), true, `HTTP ${status} came from the edge`);
    }
  });

  it("healthy means 2xx and nothing else", async () => {
    const { originIsHealthy } = await import("../tunnel-policy.mjs");
    for (const s of [200, 204, 299]) assert.equal(originIsHealthy({ status: s }), true, String(s));
    for (const s of [199, 301, 404, 500, 502]) assert.equal(originIsHealthy({ status: s }), false, String(s));
  });

  it("describes the three states distinguishably", async () => {
    const { describe: d } = await import("../tunnel-policy.mjs");
    const a = d(null), b = d({ status: 502 }), c = d({ status: 200 });
    assert.equal(new Set([a, b, c]).size, 3, "the three states must not read the same");
    assert.match(b, /tunnel fine/);
  });
});

describe("/dial dry run — the guard that rings nobody", () => {
  // WHY THIS EXISTS. A `dryRun` flag was passed to a /dial that did not
  // implement one. The flag was silently ignored and a real call went out. It
  // cost $0 and reached nobody (918-555-0123 is in the reserved fictional
  // range), but against a lead list the same slip dials a real person. So dry
  // run is a real mode now, and these tests pin the ONE property that matters:
  // it must return BEFORE any Twilio client is constructed.
  const SERVER = readFileSync(path.join(HERE_SRC, "server.mjs"), "utf8");

  it("short-circuits before the Twilio client is built", () => {
    const dryIdx = SERVER.indexOf("payload.dryRun === true");
    // The CALL SITE, not the function definition — twilioClient is declared
    // near the top of the file, so a bare indexOf("twilioClient()") matches
    // that and the ordering assertion becomes meaningless.
    const clientIdx = SERVER.indexOf("const client = twilioClient();");
    assert.ok(dryIdx > 0, "dryRun branch missing");
    assert.ok(clientIdx > 0, "the twilioClient() call site moved — update this test");
    assert.ok(
      dryIdx < clientIdx,
      "the dryRun branch must come BEFORE twilioClient() — otherwise it dials and then reports",
    );
  });

  it("requires an explicit boolean true, so a stray truthy value cannot skip a real call", () => {
    // `dryRun: "false"` is truthy. If the check were loose, an operator meaning
    // to place calls would silently place none — the opposite failure, equally bad.
    assert.match(SERVER, /payload\.dryRun === true/);
  });

  it("still validates the number before reporting what it would do", () => {
    const toE164Idx = SERVER.indexOf("const dialTo = toE164(payload.to)");
    const dryIdx = SERVER.indexOf("payload.dryRun === true");
    assert.ok(toE164Idx > 0 && toE164Idx < dryIdx, "a dry run must not report a number it never validated");
  });
});
