/**
 * THE CHUNK QUEUE — the contract for streaming her reply chunk-by-chunk
 * under ONE utterance generation, before speak.ts builds it.
 *
 * WHY THIS FILE EXISTS FIRST (TDD, not after-the-fact coverage). speak.ts
 * today only knows how to speak ONE whole string per call (speakStarra). The
 * division contract calls for a "queue primitive in speak.ts that accepts
 * ordered chunk texts under ONE utterance generation" so a long reply can
 * start sounding before the whole thing has streamed in. This file is that
 * primitive's spec, written before the primitive exists, per
 * superpowers:test-driven-development — every test below MUST fail against
 * current speak.ts, and does (see the run output quoted in the report).
 *
 * ── THE PROPOSED CONTRACT ───────────────────────────────────────────────
 *
 *   export async function speakStarraChunks(
 *     chunks: string[],
 *     signal?: AbortSignal,
 *   ): Promise<SpeakEngine>
 *
 * Same shape as speakStarra(text, signal) — same return type, same ONE
 * VOICE gate, same generation stamping via the EXISTING, already-exported
 * beginUtterance()/isCurrentUtterance() (this file imports and drives those
 * for real; it does not reinvent them) — but takes an ARRAY of chunk texts
 * belonging to a single utterance instead of one string. Each chunk is
 * synthesized (presumably via the same /api/tts POST speakAra already uses)
 * and PLAYED strictly in submission order, even when a later chunk's
 * synthesis resolves before an earlier one's — never overlapping, never
 * reordered. A mid-queue synthesis failure follows the SAME one-voice policy
 * a single-utterance failure already does (voice-fallback-policy.ts,
 * UNMODIFIED, imported nowhere by this file): silence, never a fallback
 * engine. stopAllSpeech() cuts the queue exactly where speakStarra's own
 * barge-in already cuts a single utterance. A newer speakStarraChunks (or
 * speakStarra) call superseding this one drops whatever of the old queue
 * had not yet played, the same way a superseded single utterance's stale
 * `playing` publishes are already suppressed by isCurrentUtterance().
 *
 * ── COORDINATION NOTE ────────────────────────────────────────────────────
 * ListAgents returned no reachable agents when this file was written, so the
 * shape above is a reasoned default (documented, not guessed at silently),
 * not a synchronously agreed one. Every test below calls the not-yet-real
 * export through ONE alias:
 *
 *   import { speakStarraChunks as speakChunks } from "../src/lib/voice/speak";
 *
 * If the executive lands a different exported name or signature, only that
 * import line (and the @ts-expect-error above it) needs to change — every
 * test body below already calls the local alias `speakChunks`, not the
 * export name directly.
 *
 * ── WHY THIS FAILS RIGHT NOW ─────────────────────────────────────────────
 * `speakStarraChunks` does not exist yet, so the import resolves to
 * `undefined` (verified: Node's ESM loader under tsx does not statically
 * enforce named-export existence — an unresolved named import silently
 * binds to `undefined` rather than throwing at load time). Every test below
 * therefore fails at its very first line — `speakChunks(...)` — with
 * `TypeError: speakChunks is not a function`. That IS "fail-to-import the
 * not-yet-existing queue API" in spirit: nothing about the queue can be
 * exercised because the queue does not exist. Once the executive adds the
 * export, these tests start running for real and define GREEN.
 *
 * STUBBING APPROACH — copied from tests/one-voice-call-gate.test.ts, which
 * is the file in this repo that already drives speakStarra() for real
 * against a minimal browser (stub `window`/`localStorage`/`fetch`, restore
 * in `finally`). This file extends that same minimal-browser pattern with a
 * controllable `Audio` stub (needed here, not there, because that file's
 * fetch always 404s before any `new Audio()` is ever reached) so play-start
 * / play-end order can actually be recorded and asserted on.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { resetEngineBus } from "../src/lib/engine/bus";
import {
  beginUtterance,
  isCurrentUtterance,
  stopAllSpeech,
  subscribeTtsAudio,
  VOICE_FAILURE_EVENT,
} from "../src/lib/voice/speak";
// THE NOT-YET-BUILT API. See the CONTRACT note above. Once speak.ts exports
// this for real, delete the @ts-expect-error and every test below runs
// against the real implementation unchanged.
import { speakStarraChunks as speakChunks } from "../src/lib/voice/speak";

// ── Harness ─────────────────────────────────────────────────────────────

interface LogEntry {
  event: "play-start" | "play-end:ended" | "play-end:error";
  text: string;
}

type FireEvent = "playing" | "timeupdate" | "pause" | "ended" | "error";

interface FakeAudioHandle {
  text: string;
  paused: boolean;
  fire(type: FireEvent): void;
}

/**
 * Installs the minimal browser speak.ts needs (window/localStorage/fetch,
 * same as one-voice-call-gate.test.ts) PLUS a controllable `Audio` so play
 * order can be observed and driven by the test instead of a real decoder.
 * Every stub is restored in `teardown()`.
 */
function installHarness() {
  const playLog: LogEntry[] = [];
  const createdAudios: (FakeAudioHandle & { src: string })[] = [];
  const urlToText = new Map<string, string>();
  const blobToText = new Map<Blob, string>();
  const pendingFetches: { text: string; resolve: (r: Response) => void }[] = [];
  const speechSynthesisSpeakCalls: unknown[] = [];
  const failureEvents: { notice: unknown; outcome: unknown }[] = [];
  const onnxFetchCount = { count: 0 };

  class FakeAudio implements FakeAudioHandle {
    src: string;
    text: string;
    currentTime = 0;
    duration = 0;
    paused = true;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private listeners = new Map<string, Set<() => void>>();

    constructor(url?: string) {
      this.src = url ?? "";
      this.text = urlToText.get(this.src) ?? "?";
      createdAudios.push(this);
    }
    addEventListener(type: string, fn: () => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(fn);
    }
    removeEventListener(type: string, fn: () => void) {
      this.listeners.get(type)?.delete(fn);
    }
    play(): Promise<void> {
      this.paused = false;
      playLog.push({ event: "play-start", text: this.text });
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    fire(type: FireEvent) {
      if (type === "ended" || type === "error") {
        playLog.push({ event: `play-end:${type}`, text: this.text });
      }
      this.listeners.get(type)?.forEach((fn) => fn());
      if (type === "ended") this.onended?.();
      if (type === "error") this.onerror?.();
    }
  }

  const realFetch = globalThis.fetch;
  const hadAudio = "Audio" in globalThis;
  const realAudio = (globalThis as Record<string, unknown>).Audio;
  const realCreateObjectURL = URL.createObjectURL.bind(URL);
  const hadWindow = "window" in globalThis;
  const realWindow = (globalThis as Record<string, unknown>).window;
  const hadLocalStorage = "localStorage" in globalThis;
  const realLocalStorage = (globalThis as Record<string, unknown>).localStorage;

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : ((input as { url?: string })?.url ?? String(input));
    if (url.includes(".onnx") || url.includes("/brand/voice")) {
      onnxFetchCount.count += 1; // Piper's HEAD-check — must stay 0 on the failure path
      return new Response(null, { status: 404 });
    }
    if (url.includes("/api/tts")) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return new Promise<Response>((resolve) => {
        pendingFetches.push({ text: body.text, resolve });
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  (globalThis as Record<string, unknown>).Audio = FakeAudio;

  URL.createObjectURL = ((blob: Blob) => {
    const url = realCreateObjectURL(blob);
    const text = blobToText.get(blob);
    if (text !== undefined) urlToText.set(url, text);
    return url;
  }) as typeof URL.createObjectURL;

  const listeners = new Map<string, Set<(e: Event) => void>>();
  const storageStub = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  const windowStub = {
    speechSynthesis: {
      speak: (u: unknown) => {
        speechSynthesisSpeakCalls.push(u);
      },
      cancel: () => {},
      resume: () => {},
    },
    localStorage: storageStub,
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
    addEventListener: (type: string, fn: (e: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: Event) => void) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (ev: Event) => {
      listeners.get(ev.type)?.forEach((fn) => fn(ev));
      return true;
    },
  };
  windowStub.addEventListener(VOICE_FAILURE_EVENT, ((e: CustomEvent) => {
    failureEvents.push(e.detail);
  }) as (e: Event) => void);

  (globalThis as Record<string, unknown>).window = windowStub;
  (globalThis as Record<string, unknown>).localStorage = storageStub;

  function respondOk(text: string) {
    const entry = pendingFetches.find((p) => p.text === text);
    if (!entry) throw new Error(`no pending /api/tts fetch for "${text}" yet`);
    const blob = new Blob([`audio:${text}`], { type: "audio/mpeg" });
    blobToText.set(blob, text);
    // NOT `new Response(blob)`. A real Response re-wraps the body, so
    // `await res.blob()` hands back a DIFFERENT Blob instance (verified:
    // `new Response(b).blob()` !== `b`). This harness identifies which chunk
    // an Audio is playing by looking the object-URL's Blob up in blobToText,
    // and both chunk payloads are the same byte length, so content/size can
    // not disambiguate them — identity is the only key that works. The
    // production code only ever reads `.ok` and `.blob()`, so a stub that
    // preserves the instance is a faithful stand-in and NOT a weakened
    // contract: ordering, barge-in and the failure policy are still asserted
    // against the real speak.ts.
    entry.resolve({
      ok: true,
      status: 200,
      blob: async () => blob,
    } as unknown as Response);
  }
  function respondFail(text: string, status = 500) {
    const entry = pendingFetches.find((p) => p.text === text);
    if (!entry) throw new Error(`no pending /api/tts fetch for "${text}" yet`);
    entry.resolve(new Response(null, { status }));
  }
  function getAudio(text: string): FakeAudioHandle {
    const found = createdAudios.find((a) => a.text === text);
    if (!found) throw new Error(`no Audio ever constructed for "${text}"`);
    return found;
  }
  async function waitFor(pred: () => boolean, label: string, timeoutMs = 2000) {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for: ${label}`);
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  function teardown() {
    globalThis.fetch = realFetch;
    if (hadAudio) (globalThis as Record<string, unknown>).Audio = realAudio;
    else delete (globalThis as Record<string, unknown>).Audio;
    URL.createObjectURL = realCreateObjectURL;
    if (hadWindow) (globalThis as Record<string, unknown>).window = realWindow;
    else delete (globalThis as Record<string, unknown>).window;
    if (hadLocalStorage)
      (globalThis as Record<string, unknown>).localStorage = realLocalStorage;
    else delete (globalThis as Record<string, unknown>).localStorage;
  }

  return {
    playLog,
    pendingFetches,
    respondOk,
    respondFail,
    getAudio,
    waitFor,
    teardown,
    failureEvents,
    speechSynthesisSpeakCalls,
    onnxFetchCount,
  };
}

/**
 * ── RESOLVED: the hold is over, this suite RUNS ──────────────────────────
 *
 * HISTORY, kept because the reasoning is the reason the fix looks the way it
 * does. On 2026-08-08 this spec was written correct and `skip`ped: test (2)
 * requires the queue to notice a bare `stopAllSpeech()`, and at the time
 * `stopAllSpeech()` mutated NO observable state — it called `stopHostedSpeech()`
 * + `stopLocalStream()` and nothing else. The only generation mutator was
 * `beginUtterance()`, which `stopAllSpeech` never calls. So a queue had no way
 * to learn the operator barged in between chunk N and chunk N+1, and it would
 * keep talking over the new turn. Reachable in the shipped app:
 * VoicePanel.tsx previews a voice with `stopAllSpeech(); await speakStarra(...)`,
 * which mid-queue would put her chat reply on top of the preview — two voices,
 * the exact incident the one-voice doctrine exists to prevent.
 *
 * THE FIX THAT UNBLOCKED IT is the stop-epoch the verdict asked for, now built:
 * `stopEpoch` in speak.ts, bumped by `stopAllSpeech()` (speak.ts:670-674) and
 * read via the exported `getStopEpoch()` (speak.ts:666-668). The queue snapshots
 * it at birth (`epochAtBirth`, speak.ts:1397) and re-checks it at all three
 * advance points — before claiming a chunk's blob, after the await where a real
 * barge-in lands, and after playback returns (speak.ts:1430, 1442, 1479). A
 * moved epoch means the queue dies silently instead of finishing its sentence.
 *
 * ONE CLAIM FROM THE ORIGINAL VERDICT, CORRECTED on re-reading the source: a
 * mid-queue Ara failure does NOT produce two voices. `mayAnotherVoiceSpeak`
 * fails closed (voice-fallback-policy.ts:62-75) — only `unconfigured` (a 204,
 * i.e. no key at all) hands the turn to another engine, and that cannot appear
 * on chunk 2 having been absent on chunk 1. Test (3) therefore encodes a real
 * but LESSER risk than first stated: not a second voice, a HALF-SPOKEN reply.
 */
describe("speakStarraChunks — the chunk queue contract", () => {
  beforeEach(() => resetEngineBus());
  afterEach(() => resetEngineBus());

  // ── (1) ORDERING ─────────────────────────────────────────────────────
  it("plays chunks in submission order even when a later chunk's synthesis resolves first", async () => {
    const h = installHarness();
    try {
      const enginePromise = speakChunks(["chunk one", "chunk two"]);

      await h.waitFor(
        () =>
          h.pendingFetches.some((p) => p.text === "chunk one") &&
          h.pendingFetches.some((p) => p.text === "chunk two"),
        "both chunks submitted for synthesis",
      );

      // OUT OF ORDER ON PURPOSE: the SECOND chunk's synthesis resolves first.
      h.respondOk("chunk two");
      h.respondOk("chunk one");

      await h.waitFor(
        () => h.playLog.some((e) => e.event === "play-start" && e.text === "chunk one"),
        "chunk one begins playing",
      );
      assert.equal(
        h.playLog.some((e) => e.text === "chunk two"),
        false,
        "chunk two must not start before chunk one, even though it synthesized first",
      );

      h.getAudio("chunk one").fire("playing");
      h.getAudio("chunk one").fire("ended");

      await h.waitFor(
        () => h.playLog.some((e) => e.event === "play-start" && e.text === "chunk two"),
        "chunk two begins playing only after chunk one ends",
      );
      h.getAudio("chunk two").fire("playing");
      h.getAudio("chunk two").fire("ended");

      const engine = await enginePromise;
      assert.equal(engine, "ara");
      assert.deepEqual(
        h.playLog.map((e) => `${e.event}:${e.text}`),
        [
          "play-start:chunk one",
          "play-end:ended:chunk one",
          "play-start:chunk two",
          "play-end:ended:chunk two",
        ],
        "chunks must never overlap and never reorder",
      );
    } finally {
      h.teardown();
    }
  });

  // ── (2) BARGE-IN MID-QUEUE ───────────────────────────────────────────
  it("stopAllSpeech() between chunk N and N+1 silences every later chunk, permanently", async () => {
    const h = installHarness();
    const snapshots: { playing: boolean; afterBargeIn: boolean }[] = [];
    let bargedIn = false;
    const unsubscribe = subscribeTtsAudio((s) => {
      snapshots.push({ playing: s.playing, afterBargeIn: bargedIn });
    });
    try {
      const enginePromise = speakChunks(["one", "two", "three"]);

      await h.waitFor(() => h.pendingFetches.some((p) => p.text === "one"), "chunk one synthesizing");
      h.respondOk("one");
      await h.waitFor(
        () => h.playLog.some((e) => e.event === "play-start" && e.text === "one"),
        "chunk one playing",
      );
      h.getAudio("one").fire("playing");

      // Chunk two finishes synthesizing WHILE chunk one is still speaking —
      // it is fully ready to play, which is exactly what must be refused.
      await h.waitFor(() => h.pendingFetches.some((p) => p.text === "two"), "chunk two synthesizing");
      h.respondOk("two");

      // THE SEAM: chunk one ends, and the barge-in lands in the very next
      // line — before any microtask can advance the queue to chunk two.
      h.getAudio("one").fire("ended");
      stopAllSpeech();
      bargedIn = true;

      // A brand-new turn claims her voice, same as any real next utterance.
      const freshGeneration = beginUtterance();
      assert.equal(isCurrentUtterance(freshGeneration), true);

      // Chunk three resolves LATE — after both the barge-in and the fresh
      // generation exist. It must still never play.
      await h.waitFor(() => h.pendingFetches.some((p) => p.text === "three"), "chunk three synthesizing");
      h.respondFail("three", 500); // whether it "fails" or "succeeds" must not matter — it's dead either way

      await enginePromise;

      assert.equal(
        h.playLog.some((e) => e.text === "two"),
        false,
        "chunk two was fully synthesized and ready, but must never play after the barge-in",
      );
      assert.equal(
        h.playLog.some((e) => e.text === "three"),
        false,
        "chunk three must never play either",
      );
      assert.equal(
        snapshots.some((s) => s.afterBargeIn && s.playing === true),
        false,
        "no publishTtsFor from the dead generation may land after the fresh beginUtterance()",
      );
    } finally {
      unsubscribe();
      h.teardown();
    }
  });

  // ── (3) MID-QUEUE FAILURE ────────────────────────────────────────────
  it("goes silent from a mid-queue synthesis failure onward — no Piper, no Web Speech", async () => {
    const h = installHarness();
    try {
      const enginePromise = speakChunks(["one", "two", "three"]);

      await h.waitFor(() => h.pendingFetches.some((p) => p.text === "one"), "chunk one synthesizing");
      h.respondOk("one");
      await h.waitFor(
        () => h.playLog.some((e) => e.event === "play-start" && e.text === "one"),
        "chunk one playing",
      );
      h.getAudio("one").fire("playing");
      h.getAudio("one").fire("ended");

      await h.waitFor(() => h.pendingFetches.some((p) => p.text === "two"), "chunk two synthesizing");
      // xAI non-ok — the exact transient-failure shape voice-fallback-policy.ts governs.
      h.respondFail("two", 500);

      const engine = await enginePromise;

      assert.ok(
        engine === "ara" || engine === "none",
        `a mid-queue failure must resolve to a one-voice outcome only, got "${engine}"`,
      );
      assert.notEqual(engine, "piper", "no retry into Piper after a mid-queue miss");
      assert.notEqual(engine, "webspeech", "no retry into Web Speech after a mid-queue miss");
      assert.equal(
        h.playLog.some((e) => e.text === "three"),
        false,
        "the turn goes silent from the failure forward — chunk three never plays",
      );
      assert.equal(
        h.speechSynthesisSpeakCalls.length,
        0,
        "Web Speech must never be invoked as a fallback engine",
      );
      assert.equal(
        h.onnxFetchCount.count,
        0,
        "Piper must never even be probed as a fallback engine on this path",
      );
      assert.ok(
        h.failureEvents.length <= 1,
        "VOICE_FAILURE_EVENT fires at most once per the one-voice policy",
      );
    } finally {
      h.teardown();
    }
  });

  // ── (3b) CHUNK-0 PLAYBACK FAILURE ────────────────────────────────────
  it("a chunk-0 PLAYBACK failure delegates the whole reply, like a chunk-0 synthesis failure", async () => {
    // FOUND IN REVIEW 2026-09-09. Synthesis returning null at i===0 already
    // delegated to speakStarra; playback returning false did not. So a rejected
    // play() (autoplay/gesture policy), a decode error, or the WebAudio stall
    // the watchdog catches ended her reply in SILENCE — while the very same
    // fault on a reply one sentence shorter would have been retried by
    // speakStarra and then run through the one-voice gate. Any reply long
    // enough to chunk was strictly more fragile than a short one.
    const h = installHarness();
    try {
      const enginePromise = speakChunks(["one", "two", "three"]);

      await h.waitFor(() => h.pendingFetches.some((p) => p.text === "one"), "chunk one synthesizing");
      h.respondOk("one");
      await h.waitFor(
        () => h.playLog.some((e) => e.event === "play-start" && e.text === "one"),
        "chunk one playing",
      );

      // It never sounds. `error` without a preceding `playing` is exactly the
      // autoplay-refusal / decode-failure shape: zero audio came out.
      h.getAudio("one").fire("error");

      // THE DELEGATION IS THE ASSERTION: speakStarra re-requests the WHOLE
      // reply as one utterance. Without the fix nothing further is ever
      // fetched and the turn dies here.
      await h.waitFor(
        () => h.pendingFetches.some((p) => p.text === "one two three"),
        "the joined reply must be handed to speakStarra",
      );
      h.respondOk("one two three");
      await h.waitFor(
        () => h.playLog.some((e) => e.event === "play-start" && e.text === "one two three"),
        "the delegated utterance plays",
      );
      h.getAudio("one two three").fire("playing");
      h.getAudio("one two three").fire("ended");

      const engine = await enginePromise;
      assert.equal(engine, "ara", "the delegated path is still HER voice");
      assert.equal(
        h.speechSynthesisSpeakCalls.length,
        0,
        "delegating must not open a second voice",
      );
      assert.equal(h.onnxFetchCount.count, 0, "Piper must not be probed on this path");
    } finally {
      h.teardown();
    }
  });

  // ── (4) SUPERSESSION ─────────────────────────────────────────────────
  it("a new utterance's first chunk starting playback drops every pending chunk of the old one", async () => {
    const h = installHarness();
    try {
      const firstPromise = speakChunks(["a1", "a2", "a3"]);

      await h.waitFor(() => h.pendingFetches.some((p) => p.text === "a1"), "a1 synthesizing");
      h.respondOk("a1");
      await h.waitFor(
        () => h.playLog.some((e) => e.event === "play-start" && e.text === "a1"),
        "a1 playing",
      );
      h.getAudio("a1").fire("playing");

      // a2 finishes synthesizing and is fully READY while a1 is still speaking.
      await h.waitFor(() => h.pendingFetches.some((p) => p.text === "a2"), "a2 synthesizing");
      h.respondOk("a2");

      // A brand-new utterance starts before a1 finishes.
      const secondPromise = speakChunks(["b1", "b2"]);

      await h.waitFor(() => h.pendingFetches.some((p) => p.text === "b1"), "b1 synthesizing");
      h.respondOk("b1");
      await h.waitFor(
        () => h.playLog.some((e) => e.event === "play-start" && e.text === "b1"),
        "b1 playing — the new utterance's first chunk",
      );
      h.getAudio("b1").fire("playing");
      h.getAudio("b1").fire("ended");

      await h.waitFor(() => h.pendingFetches.some((p) => p.text === "b2"), "b2 synthesizing");
      h.respondOk("b2");
      await h.waitFor(
        () => h.playLog.some((e) => e.event === "play-start" && e.text === "b2"),
        "b2 playing",
      );
      h.getAudio("b2").fire("playing");
      h.getAudio("b2").fire("ended");

      const secondEngine = await secondPromise;
      assert.equal(secondEngine, "ara");

      assert.equal(
        h.playLog.some((e) => e.text === "a2"),
        false,
        "a2 was fully synthesized and ready, but must be dropped by the newer generation",
      );
      assert.equal(
        h.playLog.some((e) => e.text === "a3"),
        false,
        "a3 was still queued and must be dropped too",
      );
      assert.deepEqual(
        h.playLog.filter((e) => e.text === "a1").map((e) => e.event),
        ["play-start"],
        "a1 was interrupted mid-speech by the newer utterance and never resumed",
      );

      // The superseded call must still SETTLE — never hang the caller.
      const firstEngine = await firstPromise;
      assert.ok(
        firstEngine === "ara" || firstEngine === "none",
        `a superseded utterance must resolve to a one-voice outcome, got "${firstEngine}"`,
      );
    } finally {
      h.teardown();
    }
  });
});
