/**
 * G4 — the mic-state machine (SHARED CONTRACT §1).
 *
 * The assertions that matter here are the SAFETY ones. "open" means the
 * microphone is live and transcribing with no wake phrase in front of it, so
 * the tests below exist to make sure it can never be the state a page comes
 * back in: not the initial value, and never written to any storage that
 * outlives the page.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MIC_MODE_EVENT,
  getMicMode,
  setMicMode,
  subscribeMicMode,
  __resetMicModeForTests,
  type MicMode,
} from "@/lib/voice/mic-state";

/** Records every storage write attempted by anything, so a test can prove none happened. */
type Write = { store: string; key: string; value: string };
const writes: Write[] = [];

function spyStorage(name: string) {
  return {
    getItem: () => null,
    setItem: (key: string, value: string) => {
      writes.push({ store: name, key, value: String(value) });
    },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
}

const target = new EventTarget();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: spyStorage("localStorage"),
  sessionStorage: spyStorage("sessionStorage"),
  dispatchEvent: (e: Event) => target.dispatchEvent(e),
  addEventListener: (t: string, f: EventListener) => target.addEventListener(t, f),
  removeEventListener: (t: string, f: EventListener) => target.removeEventListener(t, f),
};

describe("mic state", () => {
  beforeEach(() => {
    __resetMicModeForTests();
    writes.length = 0;
  });

  it("defaults to wake", () => {
    assert.equal(getMicMode(), "wake");
  });

  it("is never initially open", () => {
    assert.notEqual(getMicMode(), "open");
  });

  it("moves between all three modes", () => {
    setMicMode("muted");
    assert.equal(getMicMode(), "muted");
    setMicMode("open");
    assert.equal(getMicMode(), "open");
    setMicMode("wake");
    assert.equal(getMicMode(), "wake");
  });

  /**
   * THE HARD RULE. If this ever fails, an armed open mic can survive a reload
   * and the deck comes back listening to the room on its own.
   */
  it("writes NOTHING to any storage, even when armed to open", () => {
    setMicMode("open");
    setMicMode("muted");
    setMicMode("wake");
    assert.deepEqual(writes, [], `mic-state wrote to storage: ${JSON.stringify(writes)}`);
  });

  /**
   * Belt and braces: no storage API in the module's CODE.
   *
   * Comments are stripped first and deliberately — the file has to NAME
   * localStorage and sessionStorage to explain why it must never use them, and
   * a check that forbade saying so would just get the explanation deleted.
   */
  it("contains no storage API reference in its code", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/lib/voice/mic-state.ts"),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /localStorage|sessionStorage|document\.cookie|indexedDB/);
    // and the stripping actually left the implementation behind
    assert.match(code, /export function setMicMode/);
  });

  it("a fresh module state always comes back to wake", () => {
    setMicMode("open");
    assert.equal(getMicMode(), "open");
    __resetMicModeForTests(); // stands in for a reload discarding module scope
    assert.equal(getMicMode(), "wake");
  });

  it("notifies subscribers and returns a working unsubscribe", () => {
    const seen: MicMode[] = [];
    const off = subscribeMicMode((m) => seen.push(m));
    setMicMode("muted");
    setMicMode("open");
    off();
    setMicMode("wake");
    assert.deepEqual(seen, ["muted", "open"]);
  });

  it("dispatches MIC_MODE_EVENT on window with the new mode", () => {
    const seen: MicMode[] = [];
    const handler = (e: Event) => {
      seen.push((e as CustomEvent<{ mode: MicMode }>).detail.mode);
    };
    target.addEventListener(MIC_MODE_EVENT, handler);
    setMicMode("open");
    target.removeEventListener(MIC_MODE_EVENT, handler);
    assert.deepEqual(seen, ["open"]);
  });

  it("no-ops when set to the mode it is already in", () => {
    let calls = 0;
    const off = subscribeMicMode(() => calls++);
    setMicMode("wake"); // already wake
    assert.equal(calls, 0);
    setMicMode("open");
    assert.equal(calls, 1);
    off();
  });

  it("one throwing subscriber does not stop the others", () => {
    const seen: MicMode[] = [];
    const offBad = subscribeMicMode(() => {
      throw new Error("bad subscriber");
    });
    const offGood = subscribeMicMode((m) => seen.push(m));
    setMicMode("muted");
    assert.deepEqual(seen, ["muted"]);
    offBad();
    offGood();
  });
});
