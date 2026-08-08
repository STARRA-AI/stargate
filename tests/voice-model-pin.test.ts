/**
 * G12 — the xAI voice model pin, and the reconnect budget that has to survive
 * the session cap.
 *
 * WHY THIS FILE IS A TEST AND NOT A COMMENT: `grok-voice-latest` is an ALIAS.
 * Per xAI, on 2026-08-05 it repoints from Think Fast 1.0 to 2.0, and audio goes
 * from "$0.05 / min ($3.00 / hr)" to "$0.08 / min ($4.80 / hr)"
 * (https://docs.x.ai/docs/models, fetched 2026-07-31). Nothing about that
 * failure is visible at runtime — the call still connects, still sounds the
 * same, and just bills 60% more. Only a test catches a regression like that
 * before the invoice does.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { XAI_REALTIME_DEFAULT_MODEL, xaiRealtimeWsUrl } from "@/app/api/realtime/route";
import { VOICE_RATE_PER_MIN } from "@/lib/voice/voiceCost";

const SRC = path.join(process.cwd(), "src");

/** Every .ts/.tsx under src/. Excludes the .bak.* snapshots by extension. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("xAI realtime model pin", () => {
  it("defaults to the versioned Think Fast 1.0 id, never an alias", () => {
    assert.equal(XAI_REALTIME_DEFAULT_MODEL, "grok-voice-think-fast-1.0");
    assert.doesNotMatch(
      XAI_REALTIME_DEFAULT_MODEL,
      /-latest$/,
      "the default model must be a pinned version, not a moving alias",
    );
  });

  /**
   * THE ONE THAT ACTUALLY MATTERS. xAI selects the realtime model from the
   * WebSocket query parameter — the Voice Agent guide says "Pass model as a
   * query parameter; use a versioned name to pin to a specific release", and
   * the REST reference documents the WS `model` param as "(string, optional,
   * default: grok-voice-latest)". POST /v1/realtime/client_secrets accepts only
   * `expires_after`/`session`, so a `model` in that body does NOT pin anything.
   * A socket opened without ?model= therefore rides the alias.
   */
  it("puts the pin on the socket URL, which is what selects the model", () => {
    const url = xaiRealtimeWsUrl(XAI_REALTIME_DEFAULT_MODEL);
    assert.ok(url.startsWith("wss://api.x.ai/v1/realtime?"), `no query string: ${url}`);
    assert.equal(new URL(url).searchParams.get("model"), "grok-voice-think-fast-1.0");
  });

  it("url-encodes the model so a bad override cannot forge query params", () => {
    const url = xaiRealtimeWsUrl("evil&foo=bar");
    assert.equal(new URL(url).searchParams.get("model"), "evil&foo=bar");
    assert.equal(new URL(url).searchParams.get("foo"), null);
  });

  /**
   * Scans for the alias used as a VALUE — a single- or double-quoted string
   * literal. Prose references stay legal on purpose: route.ts and voiceCost.ts
   * both have to NAME the alias to explain why it is banned, and a test that
   * forbids documenting the hazard would just get the documentation deleted.
   */
  it("no source file uses the grok-voice-latest alias as a value", () => {
    const offenders = sourceFiles(SRC)
      .map((f) => ({ f, hit: /["']grok-voice-latest["']/.exec(readFileSync(f, "utf8")) }))
      .filter((r) => r.hit)
      .map((r) => path.relative(process.cwd(), r.f));
    assert.deepEqual(
      offenders,
      [],
      `grok-voice-latest is used as a literal in: ${offenders.join(", ")}`,
    );
  });

  /** The meter and the pin are one decision — see voiceCost.ts. */
  it("the rate meter matches the pinned model's published rate", () => {
    assert.equal(
      VOICE_RATE_PER_MIN,
      0.05,
      "grok-voice-think-fast-1.0 is $0.05/min; if the pin moves to 2.0 this must become 0.08",
    );
  });

  /**
   * route.ts:78 — `process.env.XAI_REALTIME_MODEL || XAI_REALTIME_DEFAULT_MODEL`.
   * The default constant above is only what ships when the env override is
   * unset; this pins the precedence itself so a future edit can't silently
   * drop the override or (worse) invert it to prefer the constant.
   */
  it("XAI_REALTIME_MODEL, when set, outranks the pinned default — pins the override precedence, not just the fallback", () => {
    const route = readFileSync(
      path.join(SRC, "app/api/realtime/route.ts"),
      "utf8",
    );
    assert.match(
      route,
      /const model = process\.env\.XAI_REALTIME_MODEL \|\| XAI_REALTIME_DEFAULT_MODEL;/,
      "model selection must read the env override first, falling back to the pinned default",
    );
  });
});

/**
 * G12 step 5 — a clean session cap-out must reconnect with a FULL budget.
 *
 * These are source-level assertions on purpose. The behaviour lives inside a
 * React hook's WebSocket callbacks, which cannot be driven without a browser,
 * and the code was verified CORRECT as written — so this locks the invariants
 * in place rather than rewriting working call code to make it mockable.
 */
describe("voice call reconnect budget vs the session cap", () => {
  const call = readFileSync(path.join(SRC, "lib/voice/useVoiceCall.ts"), "utf8");

  it("keeps a finite reconnect budget", () => {
    const m = /const MAX_RECONNECT_ATTEMPTS = (\d+);/.exec(call);
    assert.ok(m, "MAX_RECONNECT_ATTEMPTS not found");
    assert.equal(Number(m[1]), 5);
  });

  /**
   * The refill is what makes a 30-minute cap-out survivable: the dwell fires
   * ~10s into a healthy session and zeroes the attempt counter, so by the time
   * the cap arrives the budget is untouched. If this dwell ever grew past the
   * cap, a capped session would reconnect on a partly-spent budget.
   */
  it("refills the budget after a stability dwell far shorter than the 30-min cap", () => {
    const m = /stableTimerRef\.current = window\.setTimeout\(\s*\(\) => \{[\s\S]{0,200}?reconnectAttemptsRef\.current = 0;[\s\S]{0,120}?\},\s*([\d_]+)\)/.exec(
      call,
    );
    assert.ok(m, "stability-dwell reset of reconnectAttemptsRef not found");
    const dwellMs = Number(m[1].replace(/_/g, ""));
    assert.equal(dwellMs, 10_000);
    assert.ok(dwellMs < 30 * 60 * 1000, "dwell must fire long before the session cap");
  });

  /**
   * ws.onclose must not branch on the close code. xAI's cap-out code is not
   * documented, so any code-specific "this one is fatal" logic would be a guess
   * — and guessing wrong ends the call instead of reconnecting it.
   */
  it("treats every unexpected close as reconnectable, not fatal", () => {
    const onclose = /ws\.onclose = \(ev\) => \{([\s\S]*?)\n      \};/.exec(call);
    assert.ok(onclose, "ws.onclose handler not found");
    const body = onclose[1];
    assert.doesNotMatch(body, /ev\.code/, "onclose must not special-case a close code");
    assert.match(body, /reconnectAttemptsRef\.current \+= 1;/);
    assert.match(body, /connectRef\.current\?\.\(\)/);
  });

  it("backs off but stays bounded", () => {
    const m = /Math\.min\((\d+), (\d+) \* 2 \*\* \(reconnectAttemptsRef\.current - 1\)\)/.exec(call);
    assert.ok(m, "reconnect backoff formula not found");
    assert.equal(Number(m[1]), 4000);
    assert.equal(Number(m[2]), 400);
  });
});
