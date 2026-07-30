/**
 * STARRA Engine — client state bus.
 *
 * HER VOICE OUTRANKS EVERYTHING: the bus is best-effort OBSERVATION. It is
 * synchronous, it never awaits, and a broken subscriber must not be able to
 * break — or even slow — the publisher that is inside her audio path.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  getEngineState,
  publishActiveProviders,
  publishEngineError,
  publishEngineState,
  publishVoice,
  resetEngineBus,
  subscribeEngine,
} from "../src/lib/engine/bus";

beforeEach(() => {
  resetEngineBus();
});

describe("engine bus — state", () => {
  it("starts silent, with no source and no analyser", () => {
    const s = getEngineState();
    assert.equal(s.speaking, false);
    assert.equal(s.source, null);
    assert.equal(s.analyser, null);
    assert.equal(s.hudState, "idle");
    assert.equal(s.lastError, null);
    assert.deepEqual(s.activeProviders, {});
    assert.equal(typeof s.affect.valence, "number");
  });

  it("publishes synchronously — the state is updated before the call returns", () => {
    const out = publishEngineState({ hudState: "thinking" });
    assert.equal(out, undefined, "publish returns nothing to await");
    assert.equal(getEngineState().hudState, "thinking");
  });

  it("returns a stable snapshot object until something changes (useSyncExternalStore)", () => {
    const a = getEngineState();
    publishEngineState({ hudState: "idle" }); // same value → no-op
    assert.equal(getEngineState(), a, "identity must be preserved on a no-op patch");
    publishEngineState({ hudState: "speaking" });
    assert.notEqual(getEngineState(), a);
  });

  it("merges patches instead of replacing the world", () => {
    publishEngineState({ hudState: "speaking" });
    publishEngineState({ speaking: true });
    const s = getEngineState();
    assert.equal(s.hudState, "speaking");
    assert.equal(s.speaking, true);
  });
});

describe("engine bus — subscribe / unsubscribe", () => {
  it("notifies subscribers on change only", () => {
    const seen: number[] = [];
    subscribeEngine(() => seen.push(1));
    publishEngineState({ hudState: "listening" });
    publishEngineState({ hudState: "listening" });
    assert.equal(seen.length, 1, "no notification for an unchanged patch");
  });

  it("stops notifying after unsubscribe", () => {
    let n = 0;
    const off = subscribeEngine(() => {
      n += 1;
    });
    publishEngineState({ hudState: "wake" });
    off();
    publishEngineState({ hudState: "thinking" });
    assert.equal(n, 1);
    assert.doesNotThrow(() => off(), "double unsubscribe is safe");
  });

  it("A THROWING SUBSCRIBER CANNOT BREAK THE PUBLISHER", () => {
    let reached = 0;
    subscribeEngine(() => {
      throw new Error("subscriber exploded");
    });
    subscribeEngine(() => {
      reached += 1;
    });
    assert.doesNotThrow(() => publishEngineState({ speaking: true }));
    assert.equal(reached, 1, "later subscribers still run");
    assert.equal(getEngineState().speaking, true, "state still committed");
  });

  it("survives a subscriber that unsubscribes itself mid-notify", () => {
    let n = 0;
    const off = subscribeEngine(() => {
      n += 1;
      off();
    });
    assert.doesNotThrow(() => publishEngineState({ hudState: "streaming" }));
    publishEngineState({ hudState: "idle" });
    assert.equal(n, 1);
  });
});

describe("engine bus — voice truth", () => {
  it("publishVoice records speaking, source and the analyser together", () => {
    const fakeAnalyser = { fftSize: 2048 } as unknown as AnalyserNode;
    publishVoice({ speaking: true, source: "ara", analyser: fakeAnalyser });
    const s = getEngineState();
    assert.equal(s.speaking, true);
    assert.equal(s.source, "ara");
    assert.equal(s.analyser, fakeAnalyser);
  });

  it("clears the source when speech ends", () => {
    publishVoice({ speaking: true, source: "realtime", analyser: null });
    publishVoice({ speaking: false, source: null, analyser: null });
    const s = getEngineState();
    assert.equal(s.speaking, false);
    assert.equal(s.source, null);
  });

  it("never throws for any argument shape (it sits in her audio path)", () => {
    assert.doesNotThrow(() => publishVoice({ speaking: true }));
    assert.doesNotThrow(() => publishEngineState({}));
    assert.doesNotThrow(() =>
      publishEngineState({ hudState: "error" } as Parameters<typeof publishEngineState>[0]),
    );
  });
});

describe("engine bus — errors and active providers", () => {
  it("stores a redacted error message, never a raw credential", () => {
    const secretish = "gsk_busSecretValue_ABCDEFGH12345678";
    publishEngineError("tts", new Error(`failed with ${secretish}`));
    const e = getEngineState().lastError;
    assert.ok(e);
    assert.equal(e!.where, "tts");
    assert.ok(!e!.message.includes(secretish), "CREDENTIAL LEAKED INTO THE CLIENT BUS");
    assert.equal(typeof e!.at, "number");
  });

  it("accepts a thrown non-Error", () => {
    assert.doesNotThrow(() => publishEngineError("chat", "plain string failure"));
    assert.ok(getEngineState().lastError!.message.length > 0);
    assert.doesNotThrow(() => publishEngineError("chat", undefined));
  });

  it("tracks which provider is live per capability", () => {
    publishActiveProviders({ brain: "groq", voice: "piper" });
    const s = getEngineState();
    assert.equal(s.activeProviders.brain, "groq");
    assert.equal(s.activeProviders.voice, "piper");
    publishActiveProviders({ voice: "webspeech" });
    assert.equal(getEngineState().activeProviders.brain, "groq", "merges, does not reset");
    assert.equal(getEngineState().activeProviders.voice, "webspeech");
  });

  it("contains no secret-bearing exports (client-safe module)", async () => {
    const mod = await import("../src/lib/engine/bus");
    const names = Object.keys(mod).join(" ");
    assert.ok(!/resolveSecret|keyOverride|readEngineConfig|probeProvider/.test(names));
  });
});
