/**
 * THE ISOLATION SUITE — this is the safety story, in executable form.
 *
 * Classic's requirement, 2026-08-22: nobody reaching the outbound sales agent
 * may get his personal information, his companion material, or anything else
 * private. His personal STARRA is xAI agent `agent_hrwPHGMoaouaLMB0` carrying
 * 205,582 characters of canon and tools into his deck.
 *
 * These tests exist because "we were careful" is not a guarantee. Two mechanisms
 * must hold, and both must fail CLOSED:
 *   1. This service cannot express an agent connection at all.
 *   2. This service refuses to start on a persona carrying private markers.
 *
 * If you are changing isolation.mjs, this suite is what says whether you broke
 * the promise he actually asked for.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  SALES_MODEL,
  SALES_VOICE,
  FORBIDDEN_MARKERS,
  buildRealtimeUrl,
  buildSessionUpdate,
  assertCleanPersona,
} from "../isolation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_PERSONA = readFileSync(
  path.join(HERE, "..", "persona", "sales-persona.md"),
  "utf8",
);

describe("the socket can never reach his personal agent", () => {
  it("builds a MODEL url and never an agent url", () => {
    const url = buildRealtimeUrl();
    assert.match(url, /^wss:\/\/api\.x\.ai\/v1\/realtime\?model=/);
    assert.ok(!/agent_id/i.test(url), "url must never carry agent_id");
    assert.ok(!url.includes("agent_"), "url must never carry an agent handle");
  });

  it("pins the model rather than an alias", () => {
    assert.equal(SALES_MODEL, "grok-voice-think-fast-2.0");
    assert.ok(!SALES_MODEL.includes("latest"), "an alias can silently change under us");
  });

  it("REFUSES his real agent id if someone passes it as the model", () => {
    assert.throws(
      () => buildRealtimeUrl("agent_hrwPHGMoaouaLMB0"),
      /refusing to connect by agent/,
    );
  });

  it("refuses anything agent-shaped, however it is spelled", () => {
    for (const bad of ["agent_id", "AGENT_ID", "agent-id=x", "agent_anything"]) {
      assert.throws(() => buildRealtimeUrl(bad), /refusing to connect by agent/, bad);
    }
  });

  it("refuses an empty or non-string model instead of guessing one", () => {
    // `undefined` is deliberately absent: it means "no argument", which takes
    // the pinned SALES_MODEL default. Everything else is a caller mistake and
    // must be loud rather than silently resolved to some other model.
    for (const bad of ["", "   ", null, 42, {}, [], false]) {
      assert.throws(() => buildRealtimeUrl(bad), /required|refusing/, String(bad));
    }
  });

  it("defaults to the pinned sales model when called with no argument", () => {
    assert.equal(buildRealtimeUrl(), buildRealtimeUrl(SALES_MODEL));
    assert.ok(buildRealtimeUrl().includes(encodeURIComponent(SALES_MODEL)));
  });
});

describe("the persona screen fails CLOSED", () => {
  it("throws on every forbidden marker, case-insensitively", () => {
    for (const marker of FORBIDDEN_MARKERS) {
      const dirty = `You are a helpful sales agent. Note: ${marker.toUpperCase()} matters.`;
      assert.throws(() => assertCleanPersona(dirty), /private markers/, marker);
    }
  });

  it("throws on a canon-sized persona even if no marker matches", () => {
    assert.throws(
      () => assertCleanPersona("clean words ".repeat(2500)),
      /canon-sized/,
    );
  });

  it("throws on an empty persona rather than sending nothing", () => {
    for (const bad of ["", "   ", null, undefined]) {
      assert.throws(() => assertCleanPersona(bad), /empty/);
    }
  });

  it("returns a clean persona unchanged so it can be inlined safely", () => {
    const ok = "You are a warm, direct outbound scheduling specialist.";
    assert.equal(assertCleanPersona(ok), ok);
  });
});

describe("the persona that actually ships", () => {
  it("passes its own screen — the service would refuse to boot otherwise", () => {
    assert.doesNotThrow(() => assertCleanPersona(SHIPPED_PERSONA));
  });

  it("contains none of his private markers", () => {
    const hay = SHIPPED_PERSONA.toLowerCase();
    for (const m of FORBIDDEN_MARKERS) {
      assert.ok(!hay.includes(m), `shipped persona leaked "${m}"`);
    }
  });

  it("never carries a phone number of any kind", () => {
    assert.ok(
      !/\+?\d[\d\s().-]{8,}\d/.test(SHIPPED_PERSONA),
      "a phone number in the sales persona is a leak waiting to happen",
    );
  });

  it("tells her to admit she is AI when asked", () => {
    assert.match(SHIPPED_PERSONA, /\bAI\b/);
  });

  it("tells her to honor a removal request", () => {
    assert.match(SHIPPED_PERSONA.toLowerCase(), /removed from the list|honor a no/);
  });
});

describe("the session payload the bridge actually sends", () => {
  const s = buildSessionUpdate("You are a warm outbound scheduling specialist.").session;

  it("uses G.711 mu-law BOTH ways — this is what removes the transcoder", () => {
    // Verified against the live xAI socket 2026-08-22: audio/pcmu accepted.
    // Twilio Media Streams speaks exactly this, so the bridge relays base64
    // untouched. Changing either side to PCM16 silently adds a resampler.
    assert.equal(s.audio.input.format.type, "audio/pcmu");
    assert.equal(s.audio.output.format.type, "audio/pcmu");
  });

  it("uses Ara — deliberately NOT Eve", () => {
    // Classic, 2026-08-22: "the outbound voice can and should be Ara".
    // Eve is his private STARRA. Two voices on purpose. Do not "fix" this.
    assert.equal(s.audio.output.voice, "ara");
    assert.equal(SALES_VOICE, "ara");
    assert.notEqual(s.audio.output.voice, "eve");
  });

  it("lets the server detect turns so the lead can interrupt", () => {
    assert.equal(s.audio.input.turn_detection.type, "server_vad");
  });

  it("SCREENS the persona on the way out, not just at startup", () => {
    assert.throws(
      () => buildSessionUpdate("Ask about the spicy stuff"),
      /private markers/,
    );
  });

  it("carries no agent handle anywhere in the payload", () => {
    assert.ok(!JSON.stringify(s).toLowerCase().includes("agent_"));
  });
});
