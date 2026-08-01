/**
 * G2/G3 — deck prefs (SHARED CONTRACT §2).
 *
 * The defaults are the contract. SYNC REPLIES defaulting to FALSE is the one
 * that matters most: OFF is byte-for-byte today's reply behaviour, so anyone
 * who never opens settings must not be able to tell G3 shipped.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
/**
 * Static import is safe despite the shim below being assigned after it:
 * deck-prefs touches `window` only inside its functions, never at module
 * evaluation, so the shim is in place by the time any test calls one.
 */
import {
  DECK_PREFS_EVENT,
  DEFAULT_BOOT_GREETING,
  getBootGreeting,
  setBootGreeting,
  getBootGreetingMuted,
  setBootGreetingMuted,
  getSyncReplies,
  setSyncReplies,
} from "@/lib/voice/deck-prefs";

/** Minimal localStorage + window, installed before the module reads them. */
const backing = new Map<string, string>();
const target = new EventTarget();

(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
  },
  dispatchEvent: (e: Event) => target.dispatchEvent(e),
  addEventListener: (t: string, f: EventListener) => target.addEventListener(t, f),
  removeEventListener: (t: string, f: EventListener) => target.removeEventListener(t, f),
};

describe("deck prefs defaults", () => {
  beforeEach(() => backing.clear());

  it("boot greeting defaults to Evening, Classic.", () => {
    assert.equal(getBootGreeting(), "Evening, Classic.");
    assert.equal(DEFAULT_BOOT_GREETING, "Evening, Classic.");
  });

  it("boot greeting is NOT muted by default", () => {
    assert.equal(getBootGreetingMuted(), false);
  });

  /** THE CONTRACT DEFAULT — OFF means today's behaviour, unchanged. */
  it("SYNC REPLIES defaults to FALSE", () => {
    assert.equal(getSyncReplies(), false);
  });
});

describe("deck prefs round-trip", () => {
  beforeEach(() => backing.clear());

  it("stores and reads back a custom greeting", () => {
    setBootGreeting("Morning, Classic.");
    assert.equal(getBootGreeting(), "Morning, Classic.");
    assert.equal(backing.get("stargate.bootGreeting"), "Morning, Classic.");
  });

  /**
   * Clearing the field is far more likely to be a slip than an intent to go
   * silent — muting has its own switch that says so unambiguously.
   */
  it("an empty or whitespace greeting falls back to the default", () => {
    setBootGreeting("");
    assert.equal(getBootGreeting(), DEFAULT_BOOT_GREETING);
    setBootGreeting("   ");
    assert.equal(getBootGreeting(), DEFAULT_BOOT_GREETING);
  });

  it("mute round-trips as the wake-word-style 1/0 string", () => {
    setBootGreetingMuted(true);
    assert.equal(backing.get("stargate.bootGreetingMuted"), "1");
    assert.equal(getBootGreetingMuted(), true);
    setBootGreetingMuted(false);
    assert.equal(backing.get("stargate.bootGreetingMuted"), "0");
    assert.equal(getBootGreetingMuted(), false);
  });

  it("sync replies round-trips as the wake-word-style 1/0 string", () => {
    setSyncReplies(true);
    assert.equal(backing.get("stargate.syncReplies"), "1");
    assert.equal(getSyncReplies(), true);
    setSyncReplies(false);
    assert.equal(backing.get("stargate.syncReplies"), "0");
    assert.equal(getSyncReplies(), false);
  });

  it("uses the exact contract key names", () => {
    setBootGreeting("x");
    setBootGreetingMuted(true);
    setSyncReplies(true);
    assert.deepEqual(
      [...backing.keys()].sort(),
      ["stargate.bootGreeting", "stargate.bootGreetingMuted", "stargate.syncReplies"],
    );
  });

  it("dispatches DECK_PREFS_EVENT on every write", () => {
    let fired = 0;
    const handler = () => fired++;
    target.addEventListener(DECK_PREFS_EVENT, handler);
    setBootGreeting("a");
    setBootGreetingMuted(true);
    setSyncReplies(true);
    target.removeEventListener(DECK_PREFS_EVENT, handler);
    assert.equal(fired, 3);
  });

  /** A malformed stored value must never win over a safe default. */
  it("treats any non-\"1\" stored value as false", () => {
    backing.set("stargate.syncReplies", "yes");
    assert.equal(getSyncReplies(), false);
    backing.set("stargate.bootGreetingMuted", "true");
    assert.equal(getBootGreetingMuted(), false);
  });
});
