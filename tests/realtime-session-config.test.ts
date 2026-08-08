/**
 * /api/realtime session-config + failure-path pins.
 *
 * WHY SOURCE-LEVEL, NOT A LIVE POST() CALL: POST() in src/app/api/realtime/route.ts
 * has a real network side effect (fetch to https://api.x.ai/v1/realtime/client_secrets)
 * gated on getKey("xai"), which in turn reads real local state (data/keys.json,
 * the engine config, process.env.XAI_API_KEY) with no seam this test owns to mock.
 * Forcing that path deterministically would mean mocking modules this test does
 * not own or depending on this machine's actual key state (which, per
 * CLAUDE.md's ONE BRAIN order, is very likely LINKED here — a "no key" test would
 * be flaky by construction). tests/kimi-call-brain.test.ts already established
 * this route's test convention for exactly this reason: pin the literal source
 * shape, and exercise the shared redaction primitive (safeErrorMessage) behaviorally
 * with realistic route-shaped input. This file follows the same convention.
 *
 * WHAT WAS VERIFIED BY READING src/app/api/realtime/route.ts (157 lines) FULL, and
 * cross-checking src/lib/voice/useVoiceCall.ts (read-only, not owned by this file
 * set):
 *
 *  - model:   route.ts:34 XAI_REALTIME_DEFAULT_MODEL = "grok-voice-think-fast-1.0";
 *             route.ts:78 `process.env.XAI_REALTIME_MODEL || XAI_REALTIME_DEFAULT_MODEL`
 *             (env override precedence pinned in tests/voice-model-pin.test.ts).
 *  - voice:   route.ts:94 client_secrets POST body `{ model, voice: "eve" }`;
 *             route.ts:132 echoed back to the client as `voice: "eve"` on success.
 *  - turn_detection: NOT part of this route's minted config. route.ts's
 *             client_secrets body (line 94) is only `{ model, voice }` — the xAI
 *             REST reference for that endpoint doesn't accept a session shape
 *             that includes it, and this route never constructs one. The literal
 *             `turn_detection: null` session field is set CLIENT-SIDE, over the
 *             already-open WebSocket, in src/lib/voice/useVoiceCall.ts:2582-2590
 *             (`turn_detection: brain === "kimi" ? { type: null } : {...}`), and
 *             the server's session.updated ACK for it is read at
 *             useVoiceCall.ts:2020-2038 (`ackSession.turn_detection`), which
 *             re-asserts once via a follow-up `session.update` if the ack shows
 *             detection still on. Per the division contract this route owns the
 *             mint + callBrain report only; useVoiceCall.ts is the executive's
 *             file. ESCALATED (not edited): this is exactly the "set client-side,
 *             not in this route" case the task called out in advance.
 *  - modalities: route.ts never sends this field. useVoiceCall.ts:56 documents
 *             the omission is deliberate ("xAI's realtime endpoint rejects that
 *             field").
 *  - callBrain: route.ts:142-145, already pinned by
 *             tests/kimi-call-brain.test.ts:144-168 (not duplicated here).
 *  - failure paths (all 4 in POST()): every one returns `Response.json({ mode, ... })`
 *             — none is a bare `return;`. The two paths that can carry upstream
 *             text (`!res.ok`, the outer `catch`) run it through
 *             `safeErrorMessage(..., await liveSecrets(key)).slice(0, 200)` —
 *             scrub BEFORE truncate, matching the fixed defect documented in
 *             tests/hosted-error-redaction.test.ts's header comment ("The
 *             realtime route had the same defect and was fixed").
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { safeErrorMessage } from "@/lib/engine/redact";

const SRC = path.join(process.cwd(), "src");
const ROUTE_PATH = path.join(SRC, "app/api/realtime/route.ts");
const VOICE_CALL_PATH = path.join(SRC, "lib/voice/useVoiceCall.ts");
const route = readFileSync(ROUTE_PATH, "utf8");
const voiceCall = readFileSync(VOICE_CALL_PATH, "utf8");

describe("realtime route — the session config it actually mints", () => {
  it("sends voice eve on the client_secrets mint body", () => {
    assert.match(
      route,
      /body:\s*JSON\.stringify\(\{\s*model,\s*voice:\s*"eve"\s*\}\),/,
      "client_secrets POST body must be exactly { model, voice: \"eve\" }",
    );
  });

  it("echoes voice eve back to the browser on a live mint", () => {
    assert.match(
      route,
      /mode:\s*"live",[\s\S]{0,200}voice:\s*"eve",/,
      "the mode:\"live\" response must carry voice: \"eve\"",
    );
  });

  it("does NOT include turn_detection in this route's minted config — it is not the source of truth for it", () => {
    // The only place `turn_detection` may appear in route.ts is prose (a code
    // comment explaining where it actually lives), never as a JSON field this
    // route constructs or sends.
    const bodyLiteral = /body:\s*JSON\.stringify\(\{\s*model,\s*voice:\s*"eve"\s*\}\),/.exec(route);
    assert.ok(bodyLiteral, "client_secrets body literal not found");
    assert.doesNotMatch(
      bodyLiteral![0],
      /turn_detection/,
      "route.ts's client_secrets body must not gain a turn_detection field without executive sign-off (wire-protocol change)",
    );
  });

  it("ESCALATED EVIDENCE — turn_detection null is minted client-side in useVoiceCall.ts, not in this route", () => {
    // useVoiceCall.ts:2582-2590 — the actual session.update sent over the open
    // WebSocket after connect, not anything route.ts sends to xAI's REST endpoint.
    assert.match(
      voiceCall,
      /turn_detection:\s*\n\s*brain === "kimi"\s*\n\s*\? \{ type: null \}/,
      "useVoiceCall.ts must set turn_detection:{type:null} for the kimi brain — if this moved, update the file:line evidence above",
    );
  });

  it("ESCALATED EVIDENCE — the session.updated ack IS checked, at useVoiceCall.ts's handler for it", () => {
    // useVoiceCall.ts:2006 case "session.updated", :2020-2038 reads
    // ackSession.turn_detection and re-asserts once if the server kept VAD on.
    assert.match(voiceCall, /case "session\.updated":\s*\{/);
    assert.match(
      voiceCall,
      /const ackSession = asRecord\(evt\.session\);\s*\n\s*const td = ackSession \? ackSession\.turn_detection : undefined;/,
      "the session.updated ack must be inspected for turn_detection, not just treated as a bare liveness ping",
    );
  });

  it("never sends a modalities field — deliberate, per useVoiceCall.ts's documented omission", () => {
    assert.doesNotMatch(route, /modalities/);
    assert.match(
      voiceCall,
      /deliberately do NOT send `modalities`/,
      "the omission must stay documented, not silently true",
    );
  });
});

describe("realtime route — every failure path reports structured state, never a bare return", () => {
  const postBody = (() => {
    const start = route.indexOf("export async function POST()");
    assert.ok(start >= 0, "POST() not found in route.ts");
    return route.slice(start);
  })();

  it("POST() contains no bare `return;` on any path — every exit is a Response.json", () => {
    assert.doesNotMatch(
      postBody,
      /^\s*return;\s*$/m,
      "a bare return leaves the caller with no mode/message to surface — every failure must return Response.json({ mode, ... })",
    );
  });

  it("no-key path returns a static stub message — nothing dynamic to leak", () => {
    assert.match(
      route,
      /mode:\s*"stub",\s*\n\s*message:\s*"VOICE LINK UNAVAILABLE — link the xAI key in Settings → Link APIs\.",/,
    );
  });

  it("upstream !res.ok path scrubs BEFORE truncating, and passes the live key into the scrub set", () => {
    assert.match(
      route,
      /message:\s*safeErrorMessage\(`xAI \$\{res\.status\}: \$\{err\}`,\s*await liveSecrets\(key\)\)\.slice\(\s*\n?\s*0,\s*\n?\s*200,?\s*\n?\s*\),/,
      "must be safeErrorMessage(...).slice(0,200) — scrub-then-truncate, with the resolved key passed to liveSecrets so it scrubs even if collectSecretValues misses it",
    );
  });

  it("no-client-secret path returns a static error message — nothing dynamic to leak", () => {
    assert.match(
      route,
      /mode:\s*"error",\s*message:\s*"xAI returned no client secret\."\s*\},\s*\n\s*\{\s*status:\s*502\s*\},/,
    );
  });

  it("outer catch path scrubs BEFORE truncating, and passes the live key into the scrub set", () => {
    assert.match(
      route,
      /message:\s*safeErrorMessage\(e,\s*await liveSecrets\(key\)\)\.slice\(0,\s*200\),/,
      "must be safeErrorMessage(e, ...).slice(0,200) — the caught error itself must never be interpolated raw into the response",
    );
  });

  it("both error branches report status 502, never a silent 200 for a failure", () => {
    const matches = postBody.match(/\{ status: 502 \}/g) ?? [];
    assert.ok(
      matches.length >= 2,
      `expected at least 2 explicit 502s (upstream-not-ok, no-client-secret, and catch paths); found ${matches.length}`,
    );
  });
});

describe("realtime route — no secret value can survive into an error response body (behavioral, via the real redaction fn)", () => {
  // Exercises the EXACT transform route.ts performs on each branch, with a
  // realistic key shape, rather than trusting the source text alone.
  const FAKE_XAI_KEY = `xai-${"K9mZ7pQ2wR4tY6uI8oP1aS3dF5gH".repeat(2)}`;

  it("!res.ok branch: an upstream body that echoes the key back is fully scrubbed", () => {
    const status = 401;
    const err = `{"error":"invalid api key","key":"${FAKE_XAI_KEY}"}`;
    const message = safeErrorMessage(`xAI ${status}: ${err}`, [FAKE_XAI_KEY]).slice(0, 200);
    assert.equal(message.includes(FAKE_XAI_KEY), false, "full key leaked into the response message");
    assert.equal(message.indexOf(FAKE_XAI_KEY.slice(0, 12)), -1, "a live fragment of the key leaked");
    assert.ok(message.includes("401"), "status should still be diagnosable");
  });

  it("!res.ok branch: a key straddling the 200-char truncation boundary still cannot leak a fragment", () => {
    const status = 429;
    const pad = "x".repeat(180);
    const err = `${pad}${FAKE_XAI_KEY} rate limited`;
    const message = safeErrorMessage(`xAI ${status}: ${err}`, [FAKE_XAI_KEY]).slice(0, 200);
    assert.equal(message.indexOf(FAKE_XAI_KEY.slice(0, 10)), -1);
  });

  it("catch branch: a thrown Error whose message embeds the key is fully scrubbed", () => {
    const thrown = new Error(`fetch failed: Authorization Bearer ${FAKE_XAI_KEY} rejected`);
    const message = safeErrorMessage(thrown, [FAKE_XAI_KEY]).slice(0, 200);
    assert.equal(message.includes(FAKE_XAI_KEY), false);
  });

  it("catch branch: even with no explicit key in scope, the shape rule still catches an xai- prefixed value", () => {
    // Mirrors what happens if `key` were somehow undefined when liveSecrets()
    // runs — SHAPE_RULES in redact.ts is the second layer of defense.
    const thrown = new Error(`socket closed while sending ${FAKE_XAI_KEY}`);
    const message = safeErrorMessage(thrown, []).slice(0, 200);
    assert.equal(message.includes(FAKE_XAI_KEY), false, "shape-based redaction must catch an xai- key even with an empty scrub list");
  });

  it("the static stub and no-client-secret messages never interpolate anything, so there is nothing for a key to hide inside", () => {
    assert.doesNotMatch(
      route,
      /mode:\s*"stub",\s*\n\s*message:\s*`/,
      "the stub message must stay a plain string literal, not a template literal that could later interpolate a secret",
    );
  });
});
