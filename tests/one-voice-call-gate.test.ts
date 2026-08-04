/**
 * ONE VOICE — THE CALL'S (Classic's order, 2026-08-04).
 *
 * While the live call is up (bus `callLive`, raised by VoiceCallOverlay for
 * the whole open call), the chat-side TTS stack — speakStarra and every engine
 * under it (Ara/Piper/Web Speech) — must be structurally unable to make a
 * sound. Two voices at once — her call leg plus a chat TTS engine reading a
 * brain reply over it — is the failure that reached Classic; this pins the
 * gate that makes it impossible at the source.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  getEngineState,
  publishCallLive,
  resetEngineBus,
} from "../src/lib/engine/bus";

describe("engine bus — callLive", () => {
  beforeEach(() => {
    resetEngineBus();
  });

  it("starts with the call NOT owning her voice", () => {
    assert.equal(getEngineState().callLive, false);
  });

  it("publishCallLive claims and releases ownership", () => {
    publishCallLive(true);
    assert.equal(getEngineState().callLive, true);
    publishCallLive(false);
    assert.equal(getEngineState().callLive, false);
  });

  it("only a strict `true` claims her voice — truthy junk does not", () => {
    publishCallLive(1 as unknown as boolean);
    assert.equal(getEngineState().callLive, false);
  });

  it("reset releases the claim", () => {
    publishCallLive(true);
    resetEngineBus();
    assert.equal(getEngineState().callLive, false);
  });
});

describe("speakStarra — the call gate", () => {
  it("refuses to start ANY engine while the call owns her voice", async () => {
    resetEngineBus();

    // Minimal browser: enough for speakStarra to run its engine chain, with no
    // speechSynthesis so the chain ends silently in node.
    let fetches = 0;
    const storageStub = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    (globalThis as Record<string, unknown>).window = {
      speechSynthesis: undefined,
      localStorage: storageStub,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    // voice-select.ts reads the BARE `localStorage` global, not
    // window.localStorage — stub both, restore both.
    (globalThis as Record<string, unknown>).localStorage = storageStub;
    const realFetch = globalThis.fetch;
    // Every engine's first move is a fetch (Ara → /api/tts, Piper → model
    // HEAD-check). 404 tells each one "unavailable" — so the fetch COUNT is
    // the honest tell of whether an engine was ever consulted at all.
    globalThis.fetch = (async () =>
      new Response(null, { status: 404 })) as typeof globalThis.fetch;
    const countingFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
      fetches += 1;
      return countingFetch(...args);
    }) as typeof globalThis.fetch;

    try {
      const { speakStarra } = await import("../src/lib/voice/speak");

      // GATED: call live — no engine may even be consulted.
      publishCallLive(true);
      const engine = await speakStarra("hello there");
      assert.equal(engine, "none", "gated utterance must report no engine");
      assert.equal(
        fetches,
        0,
        "no TTS network call may fire while the call owns her voice",
      );

      // CONTROL: same utterance with the call down DOES consult the engines —
      // proof the gate above was the only thing standing in the way.
      publishCallLive(false);
      await speakStarra("hello there");
      assert.ok(
        fetches > 0,
        "with the call down, the engine chain must run again",
      );
    } finally {
      globalThis.fetch = realFetch;
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });
});
