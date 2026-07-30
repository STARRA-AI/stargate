/**
 * Mouth-sync analysis — the pure half of viseme-sync.ts, exercised with plain
 * typed arrays (no DOM, no AudioContext, no network).
 *
 * Run: npx --yes tsx --test tests/*.test.ts   (package.json -> test:v2)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ATTACK_MS,
  MOUTH_SYNC_ENABLED,
  POSE_CONFIDENCE_FLOOR,
  RELEASE_MS,
  anchorAt,
  containRect,
  createMouthSmoother,
  frameIndexAt,
  highBandRatio,
  isPoseUsable,
  opennessFromAudio,
  parseAnchorTrack,
  parseVisemeBank,
  pickVisemeFrame,
  rmsLevel,
  type VisemeBank,
} from "../src/lib/voice/viseme-sync";

// a bank shaped exactly like the one scripts/build-viseme-bank.mjs emits
const BANK: VisemeBank = {
  version: 1,
  source: "/avatar/clips/talking.mp4",
  width: 170,
  height: 130,
  fps: 30,
  frames: [
    { id: "v00", file: "/avatar/visemes/v00.png", openness: 0.064 },
    { id: "v03", file: "/avatar/visemes/v03.png", openness: 0.434 },
    { id: "v05", file: "/avatar/visemes/v05.png", openness: 0.686 },
    { id: "v07", file: "/avatar/visemes/v07.png", openness: 0.935 },
  ],
};

const filled = (n: number, v: number) => {
  const a = new Float32Array(n);
  a.fill(v);
  return a;
};
/** alternating +/-amp — RMS == amp, like a square wave */
const tone = (n: number, amp: number) => {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = i % 2 === 0 ? amp : -amp;
  return a;
};

describe("mouth sync — level analysis", () => {
  it("silence reads as zero openness and picks the CLOSED viseme", () => {
    const o = opennessFromAudio(filled(512, 0));
    assert.equal(o, 0);
    const f = pickVisemeFrame(BANK, o);
    assert.ok(f);
    assert.equal(f.id, "v00");
  });

  it("near-silent room noise stays closed (does not twitch her mouth)", () => {
    const o = opennessFromAudio(tone(512, 0.004));
    assert.equal(o, 0);
    assert.equal(pickVisemeFrame(BANK, o)?.id, "v00");
  });

  it("loud speech reads as high openness and picks the WIDE viseme", () => {
    const o = opennessFromAudio(tone(512, 0.5));
    assert.ok(o > 0.9, `expected loud audio to open wide, got ${o}`);
    assert.equal(pickVisemeFrame(BANK, o)?.id, "v07");
  });

  it("openness rises monotonically with level", () => {
    const levels = [0.01, 0.03, 0.06, 0.12, 0.25];
    const out = levels.map((a) => opennessFromAudio(tone(512, a)));
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i] >= out[i - 1], `not monotonic at ${i}: ${out.join(",")}`);
    }
  });

  it("rmsLevel handles an empty buffer without NaN", () => {
    assert.equal(rmsLevel(new Float32Array(0)), 0);
  });

  it("sibilance (high-band energy) damps openness — an /s/ is loud but not wide", () => {
    const time = tone(512, 0.4);
    const lowHeavy = new Uint8Array(64);
    lowHeavy.fill(200, 0, 32);
    const highHeavy = new Uint8Array(64);
    highHeavy.fill(200, 32, 64);
    const openVowel = opennessFromAudio(time, lowHeavy);
    const fricative = opennessFromAudio(time, highHeavy);
    assert.ok(
      fricative < openVowel,
      `high-band energy should reduce openness (${fricative} !< ${openVowel})`,
    );
    assert.ok(fricative > 0, "but it must not slam her mouth shut mid-word");
  });

  it("highBandRatio is 0 for missing or silent spectra", () => {
    assert.equal(highBandRatio(null), 0);
    assert.equal(highBandRatio(undefined), 0);
    assert.equal(highBandRatio(new Uint8Array(64)), 0);
  });
});

describe("mouth sync — attack/release smoothing", () => {
  it("a single loud block cannot snap her mouth fully open (no flapping)", () => {
    const s = createMouthSmoother(ATTACK_MS, RELEASE_MS);
    const afterOneFrame = s.step(1, 16);
    assert.ok(
      afterOneFrame < 0.5,
      `one 16ms frame should move partway, not jump (got ${afterOneFrame})`,
    );
  });

  it("a one-frame dropout cannot snap her mouth shut", () => {
    const s = createMouthSmoother(ATTACK_MS, RELEASE_MS);
    for (let i = 0; i < 30; i++) s.step(1, 16);
    const held = s.value();
    assert.ok(held > 0.9, `should have opened over 30 frames (got ${held})`);
    const afterDropout = s.step(0, 16);
    assert.ok(
      afterDropout > 0.7,
      `a single silent frame should barely move it (got ${afterDropout})`,
    );
  });

  it("alternating loud/silent blocks settle instead of oscillating fully", () => {
    const s = createMouthSmoother(ATTACK_MS, RELEASE_MS);
    let min = 1;
    let max = 0;
    for (let i = 0; i < 60; i++) {
      const v = s.step(i % 2 === 0 ? 1 : 0, 16);
      if (i > 20) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    assert.ok(max - min < 0.35, `chatter should be damped, swing was ${(max - min).toFixed(3)}`);
  });

  it("converges to the target and clamps to 0..1", () => {
    const s = createMouthSmoother();
    for (let i = 0; i < 200; i++) s.step(1, 16);
    assert.ok(s.value() <= 1 && s.value() > 0.99);
    for (let i = 0; i < 400; i++) s.step(0, 16);
    assert.ok(s.value() >= 0 && s.value() < 0.01);
  });

  it("ignores non-finite input rather than poisoning the value", () => {
    const s = createMouthSmoother();
    s.step(Number.NaN, 16);
    assert.equal(Number.isFinite(s.value()), true);
    s.step(1, Number.NaN);
    assert.equal(Number.isFinite(s.value()), true);
  });

  it("reset returns it to closed", () => {
    const s = createMouthSmoother();
    for (let i = 0; i < 30; i++) s.step(1, 16);
    s.reset();
    assert.equal(s.value(), 0);
  });
});

describe("mouth sync — malformed assets degrade to null, never throw", () => {
  it("rejects empty / wrong-typed / wrong-version bank.json", () => {
    for (const bad of [
      null,
      undefined,
      {},
      [],
      "not json",
      42,
      { version: 2, width: 1, height: 1, fps: 30, frames: [{ id: "a", file: "b", openness: 0 }] },
      { version: 1, width: 170, height: 130, fps: 30, frames: [] },
      { version: 1, width: 170, height: 130, fps: 30 },
      { version: 1, width: 0, height: 130, fps: 30, frames: [{ id: "a", file: "b", openness: 0 }] },
      { version: 1, width: 170, height: 130, fps: 0, frames: [{ id: "a", file: "b", openness: 0 }] },
      { version: 1, width: 170, height: 130, fps: 30, frames: [{ id: "a", file: "b" }] },
      { version: 1, width: 170, height: 130, fps: 30, frames: [{ id: "", file: "b", openness: 0 }] },
      { version: 1, width: 170, height: 130, fps: 30, frames: [{ id: "a", file: "b", openness: "x" }] },
      { version: 1, width: 170, height: 130, fps: 30, frames: ["nope"] },
    ]) {
      assert.equal(parseVisemeBank(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it("accepts a good bank and sorts it by openness", () => {
    const parsed = parseVisemeBank({
      version: 1,
      source: "/avatar/clips/talking.mp4",
      width: 170,
      height: 130,
      fps: 30,
      frames: [
        { id: "hi", file: "/b.png", openness: 0.9 },
        { id: "lo", file: "/a.png", openness: 0.1 },
      ],
    });
    assert.ok(parsed);
    assert.deepEqual(parsed.frames.map((f) => f.id), ["lo", "hi"]);
  });

  it("picking from an empty or missing bank returns null, not a crash", () => {
    assert.equal(pickVisemeFrame(null, 0.5), null);
    assert.equal(pickVisemeFrame(undefined, 0.5), null);
    assert.equal(pickVisemeFrame({ ...BANK, frames: [] }, 0.5), null);
  });

  it("picking with a non-finite openness still returns a frame", () => {
    assert.equal(pickVisemeFrame(BANK, Number.NaN)?.id, "v00");
  });

  it("rejects malformed anchor.json", () => {
    for (const bad of [
      null,
      {},
      { fps: 30 },
      { fps: 30, frames: [] },
      { fps: 0, frames: [{ x: 1, y: 1, w: 1, h: 1 }] },
      { fps: 30, frames: [{ x: 1, y: 1, w: 0, h: 1 }] },
      { fps: 30, frames: [{ x: 1, y: 1, w: 1 }] },
      { fps: 30, frames: [7] },
    ]) {
      assert.equal(parseAnchorTrack(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it("defaults missing confidence to fully-confident", () => {
    const t = parseAnchorTrack({ fps: 30, frames: [{ x: 1, y: 2, w: 3, h: 4 }] });
    assert.ok(t);
    assert.equal(t.frames[0].confidence, 1);
  });
});

describe("mouth sync — anchor lookup", () => {
  const track = parseAnchorTrack({
    fps: 30,
    frames: [
      { x: 10, y: 20, w: 170, h: 130, confidence: 0.99 },
      { x: 11, y: 21, w: 170, h: 130, confidence: 0.5 },
      { x: 12, y: 22, w: 170, h: 130, confidence: 0.97 },
    ],
  });

  it("clamps an index below the start", () => {
    assert.equal(anchorAt(track, -5)?.x, 10);
    assert.equal(anchorAt(track, -1)?.x, 10);
  });

  it("clamps an index past the end", () => {
    assert.equal(anchorAt(track, 3)?.x, 12);
    assert.equal(anchorAt(track, 99999)?.x, 12);
  });

  it("clamps non-finite indices instead of returning undefined", () => {
    assert.equal(anchorAt(track, Number.NaN)?.x, 10);
    assert.equal(anchorAt(track, Number.POSITIVE_INFINITY)?.x, 12);
  });

  it("returns null for a missing or empty track", () => {
    assert.equal(anchorAt(null, 0), null);
    assert.equal(anchorAt(undefined, 0), null);
  });

  it("gates on pose confidence so a turned head is not patched", () => {
    assert.equal(isPoseUsable(anchorAt(track, 0)), true);
    assert.equal(isPoseUsable(anchorAt(track, 1)), false, "0.5 is below the floor");
    assert.equal(isPoseUsable(anchorAt(track, 2)), true);
    assert.equal(isPoseUsable(null), false);
    assert.ok(POSE_CONFIDENCE_FLOOR > 0 && POSE_CONFIDENCE_FLOOR < 1);
  });
});

describe("mouth sync — playback time mapping", () => {
  it("maps seconds to a frame index at the clip's fps", () => {
    assert.equal(frameIndexAt(0, 30, 354), 0);
    assert.equal(frameIndexAt(1, 30, 354), 30);
    assert.equal(frameIndexAt(4, 30, 354), 120);
  });

  it("clamps past the end of the clip", () => {
    assert.equal(frameIndexAt(99, 30, 354), 353);
  });

  it("survives garbage input", () => {
    assert.equal(frameIndexAt(Number.NaN, 30, 354), 0);
    assert.equal(frameIndexAt(1, 0, 354), 0);
    assert.equal(frameIndexAt(1, 30, 0), 0);
    assert.equal(frameIndexAt(-5, 30, 354), 0);
  });
});

describe("mouth sync — object-fit: contain mapping", () => {
  it("letterboxes a tall video in a wide box", () => {
    const r = containRect(832, 1248, 832, 2496);
    assert.ok(r);
    assert.equal(r.scale, 1);
    assert.equal(r.left, 0);
    assert.equal(r.top, 624);
  });

  it("scales down to fit and centres", () => {
    const r = containRect(832, 1248, 416, 624);
    assert.ok(r);
    assert.equal(r.scale, 0.5);
    assert.equal(r.left, 0);
    assert.equal(r.top, 0);
  });

  it("returns null for a zero-sized box or video (element not laid out yet)", () => {
    assert.equal(containRect(0, 1248, 416, 624), null);
    assert.equal(containRect(832, 1248, 0, 624), null);
    assert.equal(containRect(832, 1248, 416, 0), null);
  });
});

describe("mouth sync — feature flag", () => {
  it("is ON by default (it is free: local PNGs + an AnalyserNode, no API)", () => {
    assert.equal(MOUTH_SYNC_ENABLED, true);
  });
});
