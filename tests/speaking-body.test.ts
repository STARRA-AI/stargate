/**
 * THE SPEAKING BODY — she has two bodies now, and the mouth composites onto either.
 *
 * WHAT THIS PROTECTS (2026-09-22). Classic's goal: a face alive like a person's.
 * base_loop.mp4 is her LISTENING (an InfiniteTalk render on silence); speak_loop.mp4
 * is her SPEAKING (a render of her talking). StarraClipFace crossfades between
 * them on her speech state. Each body has its own measured drift table, and the
 * speaking body also carries the tracker's per-frame confidence: below the pose
 * floor the patch fades and her own talking mouth shows. Every number here was
 * measured by scripts/cut-idle-base.py and written by scripts/apply-base-measure.py.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  BASE_LOOP_FPS,
  BASE_LOOP_FRAMES,
  SPEAK_CONF_FLOOR,
  SPEAK_CONF_FULL,
  baseBoxAt,
  baseDriftAt,
  bodyBoxAt,
  bodyDriftAt,
  bodyPatchConfidence,
} from "../src/lib/voice/viseme-sync";
import {
  CONTINUOUS_BODY_CLIP,
  IDLE_POOL,
  SPEAKING_BODY_CLIP,
  SPEAKING_BODY_HOLD_MS,
  SPEAKING_BODY_POLL_MS,
  STARRA_CLIPS,
  isIdlePoolMember,
} from "../src/lib/voice/starra-clip-map";

const REPO = resolve(import.meta.dirname, "..");
const PUB = join(REPO, "public");
const face = readFileSync(join(REPO, "src/components/bridge/StarraClipFace.tsx"), "utf8");
const sync = readFileSync(join(REPO, "src/lib/voice/viseme-sync.ts"), "utf8");

function jpegSize(p: string): { w: number; h: number } | null {
  const b = readFileSync(p);
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
function arr(name: string): number[] {
  const m = new RegExp(`const ${name}: readonly number\\[\\] = \\[([^\\]]*)\\]`).exec(sync);
  assert.ok(m, `${name} not found in viseme-sync.ts`);
  return m![1].split(/[,\s]+/).filter(Boolean).map(Number);
}

describe("the two bodies exist and share one geometry", () => {
  it("both clips are registered, loop forever, and are not idle-pool members", () => {
    const base = STARRA_CLIPS[CONTINUOUS_BODY_CLIP];
    const speak = STARRA_CLIPS[SPEAKING_BODY_CLIP];
    assert.equal(base.file, "/avatar/body/base_loop.mp4");
    assert.equal(speak.file, "/avatar/body/speak_loop.mp4");
    assert.equal(base.loop, true);
    assert.equal(speak.loop, true);
    assert.equal(speak.durationMs, base.durationMs, "same length: same drift-table contract");
    assert.equal(base.durationMs, Math.round((BASE_LOOP_FRAMES / BASE_LOOP_FPS) * 1000));
    assert.equal(isIdlePoolMember(SPEAKING_BODY_CLIP), false);
    assert.ok(!(IDLE_POOL as readonly string[]).includes(SPEAKING_BODY_CLIP));
  });

  it("both files ship, and the hero still is the full-frame waist-up size", () => {
    assert.ok(existsSync(join(PUB, "avatar/body/base_loop.mp4")));
    assert.ok(existsSync(join(PUB, "avatar/body/speak_loop.mp4")));
    const still = jpegSize(join(PUB, "avatar/body/base_loop_frame0.jpg"));
    assert.deepEqual(still, { w: 552, h: 840 }, "the hero still must be frame 0 of the 552x840 base");
  });

  it("the timing constants are sane: poll fast enough for speech onset, hold long enough for a breath", () => {
    assert.ok(SPEAKING_BODY_POLL_MS >= 50 && SPEAKING_BODY_POLL_MS <= 250, `poll ${SPEAKING_BODY_POLL_MS}ms`);
    assert.ok(SPEAKING_BODY_HOLD_MS >= 400 && SPEAKING_BODY_HOLD_MS <= 1500, `hold ${SPEAKING_BODY_HOLD_MS}ms`);
  });
});

describe("the speaking body's tables are measured, complete and honest", () => {
  const sx = arr("SPEAK_DRIFT_X");
  const sy = arr("SPEAK_DRIFT_Y");
  const sc = arr("SPEAK_CONF");

  it("266 entries each, frame 0 is the identity, confidence is a probability", () => {
    assert.equal(sx.length, BASE_LOOP_FRAMES);
    assert.equal(sy.length, BASE_LOOP_FRAMES);
    assert.equal(sc.length, BASE_LOOP_FRAMES);
    assert.equal(sx[0], 0);
    assert.equal(sy[0], 0);
    for (const c of sc) assert.ok(c >= 0 && c <= 1, `confidence ${c} outside 0..1`);
  });

  it("the loop closes and no single frame jumps further than a real nod", () => {
    // A talking head genuinely moves ~10px/frame on a nod; a 30px step would be
    // a tracker glitch. The wrap is a head-consuming dissolve, so it must close.
    assert.ok(Math.abs(sx[0] - sx[sx.length - 1]) <= 3 && Math.abs(sy[0] - sy[sy.length - 1]) <= 3,
      `wrap jumps ${sx[0] - sx[sx.length - 1]},${sy[0] - sy[sy.length - 1]}px`);
    let worst = 0;
    for (let i = 1; i < sx.length; i++) worst = Math.max(worst, Math.abs(sx[i] - sx[i - 1]), Math.abs(sy[i] - sy[i - 1]));
    assert.ok(worst <= 14, `a ${worst}px single-frame step is a glitch, not a nod`);
  });

  it("most of the window is frontal, and the low-confidence frames are a minority", () => {
    const shown = sc.filter((c) => c >= 0.93).length;
    assert.ok(shown / sc.length >= 0.7, `${shown}/${sc.length} frames at >= 0.93 — the speaking body is too turned to use`);
  });
});

describe("bodyDriftAt / bodyBoxAt / bodyPatchConfidence — total, and the base case is unchanged", () => {
  it("kind 'base' is exactly baseDriftAt / baseBoxAt", () => {
    const box = { x: 248, y: 278, w: 152, h: 102 };
    for (const i of [0, 1, 41, 132, 265, 999, -5, NaN]) {
      assert.deepEqual(bodyDriftAt("base", i), baseDriftAt(i));
      assert.deepEqual(bodyBoxAt("base", box, i), baseBoxAt(box, i));
      assert.equal(bodyPatchConfidence("base", i), 1);
    }
  });

  it("kind 'speak' clamps at the ends and never returns NaN", () => {
    const box = { x: 248, y: 278, w: 152, h: 102 };
    for (const i of [0, 265, 300, -1, NaN, Infinity]) {
      const d = bodyDriftAt("speak", i);
      assert.ok(Number.isFinite(d.dx) && Number.isFinite(d.dy), `NaN drift at ${i}`);
      const b = bodyBoxAt("speak", box, i);
      assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
      const c = bodyPatchConfidence("speak", i);
      assert.ok(c >= 0 && c <= 1, `confidence ${c} at ${i}`);
    }
    assert.deepEqual(bodyDriftAt("speak", 0), { dx: 0, dy: 0 });
  });

  it("the confidence ramp is 1 above FULL, 0 at or below FLOOR, linear between", () => {
    assert.ok(SPEAK_CONF_FLOOR < SPEAK_CONF_FULL);
    const sc = arr("SPEAK_CONF");
    const iHigh = sc.findIndex((c) => c >= SPEAK_CONF_FULL);
    const iLow = sc.findIndex((c) => c <= SPEAK_CONF_FLOOR);
    assert.ok(iHigh >= 0, "no fully-confident frame in the speaking window");
    assert.equal(bodyPatchConfidence("speak", iHigh), 1);
    if (iLow >= 0) assert.equal(bodyPatchConfidence("speak", iLow), 0);
    const iMid = sc.findIndex((c) => c > SPEAK_CONF_FLOOR && c < SPEAK_CONF_FULL);
    if (iMid >= 0) {
      const v = bodyPatchConfidence("speak", iMid);
      assert.ok(v > 0 && v < 1, `mid confidence ${sc[iMid]} should ramp, got ${v}`);
    }
  });
});

describe("StarraClipFace uses both bodies (source pins — the wiring has no other test surface)", () => {
  it("accepts either body file as a landed layer in still mode", () => {
    assert.match(face, /\[CONTINUOUS_BODY_CLIP, SPEAKING_BODY_CLIP\]\.map\(\(k\) => STARRA_CLIPS\[k\]\.file\)/);
  });
  it("switches to the speaking body on speech and back after the hold", () => {
    assert.match(face, /if \(playingKey !== SPEAKING_BODY_CLIP\) play\(SPEAKING_BODY_CLIP\);/);
    assert.match(face, /now - quietSince >= SPEAKING_BODY_HOLD_MS/);
    assert.match(face, /if \(playingKey !== CONTINUOUS_BODY_CLIP\) play\(CONTINUOUS_BODY_CLIP\);/);
    assert.match(face, /window\.clearInterval\(speakPoll\)/, "the poll must be cleared on dispose");
  });
  it("picks the drift table by the body on screen and gates the patch by confidence", () => {
    assert.match(face, /const box = bodyBoxAt\(bodyKind, pick\.baseBox, bodyFrame\)/);
    assert.match(face, /const targetAlpha = bodyPatchConfidence\(bodyKind, bodyFrame\)/);
    assert.match(face, /smoothAlpha \+= \(targetAlpha - smoothAlpha\) \* 0\.35/, "the gate must be eased, not per-frame binary");
    assert.match(face, /canvas\.style\.opacity = String\(bodyAlpha\)/);
    assert.ok(!/video\.getAttribute\("src"\) !== STARRA_CLIPS\[CONTINUOUS_BODY_CLIP\]\.file\) \{\s*return hide\(\);/.test(face),
      "the old single-body guard would hide the patch on the speaking body");
  });
  it("blends a new mouth shape in over the previous one instead of snapping", () => {
    assert.match(face, /export const MOUTH_BLEND_MS = 80;/);
    assert.match(face, /const blend = Math\.min\(1, \(now - pickChangedAt\) \/ MOUTH_BLEND_MS\)/);
    assert.match(face, /draw2d\.globalAlpha = blend;/);
    assert.match(face, /draw2d\.globalAlpha = 1;/, "alpha must be restored after the blended draw");
  });
});
