/**
 * useCosmetics — the client-side door to /api/engine/cosmetics.
 *
 * THE RULE THIS FILE ENFORCES: cosmetics are BEST-EFFORT. The deck must render,
 * and her mouth must run, with the engine absent, the operator logged out, or the
 * network down. So the hook returns its defaults SYNCHRONOUSLY and every failure
 * mode is a silent no-op — never a throw, never a retry storm, never an await on
 * anything her face is waiting for.
 *
 * It also proves the hook cannot become a credential leak: it is imported by
 * StarraClipFace (a client component), so anything it imports is public. It may
 * reach "react" and the client-safe bus, and nothing else.
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  COSMETICS_URL,
  DEFAULT_LIVE_COSMETICS,
  normalizeLiveCosmetics,
  readLiveCosmetics,
  type CosmeticsFetch,
} from "../src/lib/engine/useCosmetics";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(REPO, p), "utf8");
/** Strip comments so a doc block naming a module cannot pass or fail a check. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const HOOK_PATH = "src/lib/engine/useCosmetics.ts";
const HOOK = read(HOOK_PATH);
const FACE = read("src/components/bridge/StarraClipFace.tsx");

type Shared = typeof import("../src/app/api/engine/_shared");
let S: Shared;
before(async () => {
  S = await import("../src/app/api/engine/_shared");
});

/** A fake response that satisfies exactly the shape the hook consumes. */
const res = (status: number, body: unknown): ReturnType<CosmeticsFetch> =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

describe("defaults are the fallback, and they match the server's", () => {
  it("mirrors the engine's DEFAULT_COSMETICS field for field", () => {
    // Third copy of the defaults by necessity (this module is client-side, the
    // schema is server-only). Deliberate duplication needs a guard or it drifts.
    assert.deepEqual(
      { ...DEFAULT_LIVE_COSMETICS },
      { ...S.DEFAULT_COSMETICS },
      "client cosmetics defaults drifted from the server's",
    );
  });

  it("defaults mouthSync ON and carries the three vetted idle clips", () => {
    assert.equal(DEFAULT_LIVE_COSMETICS.mouthSync, true);
    assert.deepEqual(DEFAULT_LIVE_COSMETICS.idlePool, ["idle_a1", "idle_c1", "idle_a2"]);
  });

  it("the hook's initial state IS the default, so first paint never waits", () => {
    // React state initialised from the frozen default = a synchronous first
    // value. There is no loading branch her face has to survive.
    assert.match(
      code(HOOK),
      /useState<LiveCosmetics>\(DEFAULT_LIVE_COSMETICS\)/,
      "the hook must seed its state with DEFAULT_LIVE_COSMETICS",
    );
  });

  it("points at the real route", () => {
    assert.equal(COSMETICS_URL, "/api/engine/cosmetics");
  });
});

describe("normalizeLiveCosmetics — total, never throws", () => {
  it("fills every missing field from the defaults", () => {
    assert.deepEqual(normalizeLiveCosmetics({}), { ...DEFAULT_LIVE_COSMETICS });
    assert.deepEqual(normalizeLiveCosmetics({ mouthSync: false }), {
      ...DEFAULT_LIVE_COSMETICS,
      mouthSync: false,
    });
  });

  it("accepts anything at all without throwing", () => {
    for (const raw of [null, undefined, 0, "", [], "nope", true, Number.NaN, () => {}]) {
      assert.doesNotThrow(() => normalizeLiveCosmetics(raw));
      assert.deepEqual(normalizeLiveCosmetics(raw), { ...DEFAULT_LIVE_COSMETICS });
    }
  });

  it("CLAMPS to the narrow authoritative bounds, not the store's wider ones", () => {
    // src/lib/engine/config.ts RawCosmeticsSchema accepts glowIntensity up to 3
    // and fontScale 0.5-2, while the panel + _shared cap them at 1.6 and
    // 0.85-1.35. A hand-edited engine.json can therefore hand the client a value
    // the UI can never produce. Clamp it here rather than render it.
    assert.equal(normalizeLiveCosmetics({ glowIntensity: 3 }).glowIntensity, 1.6);
    assert.equal(normalizeLiveCosmetics({ glowIntensity: -1 }).glowIntensity, 0);
    assert.equal(normalizeLiveCosmetics({ fontScale: 2 }).fontScale, 1.35);
    assert.equal(normalizeLiveCosmetics({ fontScale: 0.1 }).fontScale, 0.85);
    assert.equal(normalizeLiveCosmetics({ accentHue: 999 }).accentHue, 360);
    assert.equal(normalizeLiveCosmetics({ accentHue: -5 }).accentHue, 0);
  });

  it("drops a non-boolean toggle rather than coercing it", () => {
    assert.equal(normalizeLiveCosmetics({ mouthSync: "off" }).mouthSync, true);
    assert.equal(normalizeLiveCosmetics({ reduceMotion: 1 }).reduceMotion, false);
  });

  it("never yields an EMPTY idlePool", () => {
    assert.deepEqual(normalizeLiveCosmetics({ idlePool: [] }).idlePool, [
      ...DEFAULT_LIVE_COSMETICS.idlePool,
    ]);
    assert.deepEqual(normalizeLiveCosmetics({ idlePool: "idle_a1" }).idlePool, [
      ...DEFAULT_LIVE_COSMETICS.idlePool,
    ]);
    assert.deepEqual(normalizeLiveCosmetics({ idlePool: [1, null] }).idlePool, [
      ...DEFAULT_LIVE_COSMETICS.idlePool,
    ]);
  });

  it("keeps a valid idlePool exactly as given (narrowing is the face's job)", () => {
    assert.deepEqual(normalizeLiveCosmetics({ idlePool: ["idle_c1"] }).idlePool, ["idle_c1"]);
  });

  it("returns a FRESH array each time — no shared mutable default", () => {
    const a = normalizeLiveCosmetics({});
    const b = normalizeLiveCosmetics({});
    a.idlePool.push("mutated");
    assert.deepEqual(b.idlePool, [...DEFAULT_LIVE_COSMETICS.idlePool]);
    assert.deepEqual(DEFAULT_LIVE_COSMETICS.idlePool, ["idle_a1", "idle_c1", "idle_a2"]);
  });
});

describe("readLiveCosmetics — every failure is silent", () => {
  it("returns the parsed cosmetics on 200", async () => {
    const got = await readLiveCosmetics(() =>
      res(200, { cosmetics: { mouthSync: false, idlePool: ["idle_c1"] } }),
    );
    assert.ok(got);
    assert.equal(got.mouthSync, false);
    assert.deepEqual(got.idlePool, ["idle_c1"]);
  });

  it("returns null on 401 (logged out) without throwing", async () => {
    assert.equal(await readLiveCosmetics(() => res(401, { error: "auth" })), null);
  });

  it("returns null on 404 (engine route absent) without throwing", async () => {
    assert.equal(await readLiveCosmetics(() => res(404, null)), null);
  });

  it("returns null on 500 without throwing", async () => {
    assert.equal(await readLiveCosmetics(() => res(500, { error: "fault" })), null);
  });

  it("returns null when the network REJECTS", async () => {
    assert.equal(
      await readLiveCosmetics(() => Promise.reject(new Error("offline"))),
      null,
    );
  });

  it("returns null when fetch THROWS synchronously", async () => {
    assert.equal(
      await readLiveCosmetics((() => {
        throw new Error("blocked");
      }) as CosmeticsFetch),
      null,
    );
  });

  it("returns null when the body is not JSON", async () => {
    assert.equal(
      await readLiveCosmetics(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error("not json")),
        }),
      ),
      null,
    );
  });

  it("returns null when the body carries no cosmetics object", async () => {
    assert.equal(await readLiveCosmetics(() => res(200, { ok: true })), null);
    assert.equal(await readLiveCosmetics(() => res(200, null)), null);
    assert.equal(await readLiveCosmetics(() => res(200, "nope")), null);
  });

  it("normalizes a partial / hostile body instead of trusting it", async () => {
    const got = await readLiveCosmetics(() =>
      res(200, { cosmetics: { glowIntensity: 99, idlePool: [], fontScale: "big" } }),
    );
    assert.ok(got);
    assert.equal(got.glowIntensity, 1.6);
    assert.equal(got.fontScale, 1);
    assert.deepEqual(got.idlePool, [...DEFAULT_LIVE_COSMETICS.idlePool]);
  });
});

describe("bus wiring — publishEngineError / clearEngineError now have real callers", () => {
  // Board finding MAJOR 4(c): four bus publishers had ZERO callers. These two now
  // fire from a real error path. resetEngineBus() keeps the cases independent.
  let BUS: typeof import("../src/lib/engine/bus");
  before(async () => {
    BUS = await import("../src/lib/engine/bus");
  });

  it("a 5xx FAULT is published to the bus, redacted, and scoped to this module", async () => {
    BUS.resetEngineBus();
    assert.equal(BUS.getEngineState().lastError, null, "bus should start clean");
    await readLiveCosmetics(() => res(503, { error: "fault" }));
    const err = BUS.getEngineState().lastError;
    assert.ok(err, "a server fault must reach the bus");
    assert.equal(err.where, "engine/cosmetics");
    assert.match(err.message, /503/);
    assert.ok(err.at > 0);
  });

  it("401 and 404 are EXPECTED states, not faults — nothing is published", async () => {
    for (const status of [401, 404]) {
      BUS.resetEngineBus();
      await readLiveCosmetics(() => res(status, null));
      assert.equal(
        BUS.getEngineState().lastError,
        null,
        `HTTP ${status} must not raise an engine fault (logged out / engine absent are normal)`,
      );
    }
  });

  it("an offline network publishes nothing", async () => {
    BUS.resetEngineBus();
    await readLiveCosmetics(() => Promise.reject(new Error("offline")));
    assert.equal(BUS.getEngineState().lastError, null);
  });

  it("a later SUCCESS clears this module's own fault", async () => {
    BUS.resetEngineBus();
    await readLiveCosmetics(() => res(500, null));
    assert.ok(BUS.getEngineState().lastError, "precondition: a fault is on the bus");
    await readLiveCosmetics(() => res(200, { cosmetics: {} }));
    assert.equal(BUS.getEngineState().lastError, null, "the resolved fault must clear");
  });

  it("a success does NOT clear somebody ELSE's fault", async () => {
    // clearEngineError() is global. Clearing indiscriminately would erase a fault
    // the operator still needs — e.g. a dead voice provider.
    BUS.resetEngineBus();
    BUS.publishEngineError("voice/tts", new Error("upstream refused"));
    await readLiveCosmetics(() => res(200, { cosmetics: {} }));
    const err = BUS.getEngineState().lastError;
    assert.ok(err, "another module's fault must survive");
    assert.equal(err.where, "voice/tts");
  });

  it("the hook module actually calls both publishers", () => {
    const c = code(HOOK);
    assert.match(c, /publishEngineError\(/, "publishEngineError has no caller");
    assert.match(c, /clearEngineError\(\)/, "clearEngineError has no caller");
  });
});

describe("client-bundle safety and voice safety, proven on the source", () => {
  it("the hook imports ONLY react and the client-safe bus", () => {
    const specifiers: string[] = [];
    const re = /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm;
    let m: RegExpExecArray | null = re.exec(HOOK);
    while (m) {
      specifiers.push(m[1]);
      m = re.exec(HOOK);
    }
    for (const spec of specifiers) {
      assert.ok(
        spec === "react" || spec === "./bus",
        `${HOOK_PATH} imports ${spec} — client modules may only reach react and the bus`,
      );
    }
  });

  it("never reaches the SERVER-ONLY barrel or any secret-bearing engine module", () => {
    const c = code(HOOK);
    for (const forbidden of [
      '"@/lib/engine"',
      "./config",
      "./providers",
      "./router",
      "./health",
      "./index",
      "@/lib/keys",
      "_shared",
      "process.env",
    ]) {
      assert.ok(!c.includes(forbidden), `${HOOK_PATH} references ${forbidden}`);
    }
  });

  it("names no credential and no key material", () => {
    assert.doesNotMatch(
      HOOK,
      /\b(XAI_API_KEY|GROQ_API_KEY|HF_TOKEN|REPLICATE_API_TOKEN|STARRA_PASSWORD|ANTHROPIC_API_KEY|keyOverride)\b/,
    );
  });

  it("uses no regex lookbehind (macOS 12 WKWebView)", () => {
    const lookbehind = "(?" + "<";
    assert.ok(!code(HOOK).includes(lookbehind));
    assert.ok(!code(FACE).includes(lookbehind));
  });

  it("touches no audio API at all", () => {
    for (const api of ["AudioContext", "createAnalyser", "new Audio(", "AnalyserNode"]) {
      assert.ok(!HOOK.includes(api), `the cosmetics hook touches the audio path via ${api}`);
    }
  });

  it("her rAF tick gained NO await — the mouth loop never waits on cosmetics", () => {
    const start = FACE.indexOf("const tick = (now: number)");
    assert.ok(start > 0, "the mouth-sync tick was not found");
    // Bound the tick at the `void loadMouth…Assets()` call that follows it.
    // Matched on the PREFIX on purpose: the loader was renamed
    // loadMouthSyncAssets -> loadMouthPatchAssets when the v4 fallback chain
    // landed (2026-07-30), and a guard this load-bearing must not silently stop
    // guarding because a symbol was renamed. It asserts the bound was found.
    // Searched AFTER `start` on purpose: the mount-time prime effect (item C,
    // 2026-07-30) added an EARLIER `void loadMouthPatchAssets()` call above the
    // tick to warm the bank at call-open, so the first match in the whole file
    // no longer bounds the tick — the first match after the tick still does.
    const endRel = FACE.slice(start).search(/void\s+loadMouth\w*Assets\(/);
    const end = endRel < 0 ? -1 : start + endRel;
    assert.ok(end > start, "could not bound the tick body");
    const tick = code(FACE.slice(start, end));
    assert.ok(!/\bawait\b/.test(tick), "an await entered the rAF tick");
    assert.ok(!/\bfetch\(/.test(tick), "a fetch entered the rAF tick");
    assert.ok(!/useCosmetics\(/.test(tick), "the hook is called inside the tick");
    assert.ok(
      !/readLiveCosmetics/.test(tick),
      "the cosmetics read entered the rAF tick",
    );
  });

  it("the mouth effect is gated by the EFFECTIVE switch, not the raw env const", () => {
    const c = code(FACE);
    assert.match(
      c,
      /effectiveMouthSync\(/,
      "the face must compute the effective gate",
    );
    // The bare build-time const must no longer be the gate in the effect.
    assert.ok(
      !/if\s*\(\s*!MOUTH_SYNC_ENABLED\b/.test(c),
      "the face still gates on the raw build-time const",
    );
  });

  it("a cosmetics update cannot restart playback — the clip effect reads no cosmetics at all", () => {
    // SUPERSEDED MECHANISM (2026-07-30). This used to pin idlePoolRef: the pool
    // came from cosmetics, so it had to be read through a ref to keep pool
    // changes out of the clip effect's dependency list. Classic's order ("No
    // test video, no fallback to idle") removed idle-pool playback from the
    // face entirely, which satisfies this test's real invariant a stronger way:
    // the video layer plays ONE clip, gated on [active] alone, so NO cosmetics
    // value can tear her face down mid-call.
    const c = code(FACE);
    assert.ok(
      !/\bidlePoolRef\b/.test(c) && !/\bpickIdle\b/.test(c),
      "idle-pool playback must stay out of the face (no test video, no idle fallback)",
    );
    // The clip effect's dependency list is [active] — cosmetics cannot reach it.
    assert.match(
      c,
      /startContinuousBody\(\);[\s\S]{0,600}?\}, \[active\]\);/,
      "the continuous-body effect must depend on [active] only",
    );
  });
});
