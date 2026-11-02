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
  GATE_CLEARLY_TURNED,
  GATE_OFF_DEBOUNCE_MS,
  bodyDriftAt,
  bodyFrameAt,
  bodyPatchConfidence,
  bodyPatchRawConfidence,
  createSpeakGate,
  frameIndexAt,
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
    assert.match(face, /const speakGate = createSpeakGate\(\);/);
    assert.match(face, /speakGate\.step\(bodyPatchRawConfidence\(bodyKind, bodyFrame\), now\)/, "the gate reads the RAW confidence — clearly-turned lives below the floor");
    assert.match(face, /const bodyAlpha = gateOn \? 1 : 0;/, "a hard target: the 50ms CSS transition is the only dissolve");
    assert.match(face, /transition: "opacity 50ms linear",/, "a per-tick JS ramp under a 180ms CSS transition was a ~176ms blur");
    assert.match(face, /canvas\.style\.opacity = String\(bodyAlpha\)/);
    assert.ok(!/video\.getAttribute\("src"\) !== STARRA_CLIPS\[CONTINUOUS_BODY_CLIP\]\.file\) \{\s*return hide\(\);/.test(face),
      "the old single-body guard would hide the patch on the speaking body");
  });
  it("blends a new mouth shape in over the previous one, for a length that follows the jump", () => {
    // UPDATED 2026-09-30. This used to pin `MOUTH_BLEND_MS = 80` — i.e. it
    // asserted the ghosting defect as correct: a fixed 80ms dissolve leaves 40ms
    // of EVERY shape change in the visibly-ghosted 0.25..0.75 alpha band, two
    // photographs of a mouth on her face at once. The dissolve is now scaled by
    // the distance between the two bank cells (16ms for adjacent, 30ms for a
    // multi-row jump), which caps the ghosted band at 15ms. mouthBlendMs and
    // cellDistance are unit-tested on the table in tests/mouth-fluidity.test.ts.
    assert.match(face, /export const MOUTH_BLEND_CEILING_MS = MOUTH_BLEND_MAX_MS;/);
    assert.match(face, /blendMs = mouthBlendMs\(cellDistance\(lastPickCell, pick\)\);/);
    assert.match(
      face,
      /const blend = blendMs > 0 \? Math\.min\(1, \(now - pickChangedAt\) \/ blendMs\) : 1;/,
    );
    assert.match(face, /draw2d\.globalAlpha = blend;/);
    assert.match(face, /draw2d\.globalAlpha = 1;/, "alpha must be restored after the blended draw");
  });
});

describe("the body frame index runs at the BODY's rate, never the bank's", () => {
  // FOUND 2026-09-22 before the first live test: the compositor indexed the
  // 24fps body clips with b4.fps — the bank's SOURCE footage rate, 25 for the
  // InfiniteTalk render — so the drift and confidence tables ran up to 11
  // frames ahead of the picture by the end of each loop (30.7px of placement
  // error on the speaking body; wrong gate decision on ~25% of ticks). The old
  // bank was cut from 24fps footage, which hid it.
  it("bodyFrameAt is the 24fps index, clamped into the 266-frame loop", () => {
    assert.equal(bodyFrameAt(0), 0);
    assert.equal(bodyFrameAt(5), 120);
    assert.equal(bodyFrameAt(10), 240);
    assert.equal(bodyFrameAt(11), 264);
    assert.equal(bodyFrameAt(11.08), BASE_LOOP_FRAMES - 1);
    assert.equal(bodyFrameAt(99), BASE_LOOP_FRAMES - 1);
    assert.equal(bodyFrameAt(-1), 0);
    assert.equal(bodyFrameAt(Number.NaN), 0);
  });
  it("the bank's declared rate is its source footage's, and would land 10 frames ahead at 10s", () => {
    const bank = JSON.parse(readFileSync(join(REPO, "public/avatar/visemes3/bank.json"), "utf8")) as { fps: number };
    assert.equal(bank.fps, 25, "the InfiniteTalk bank is cut from 25fps footage (informational; the bodies are 24)");
    assert.equal(frameIndexAt(10, bank.fps, BASE_LOOP_FRAMES) - bodyFrameAt(10), 10);
  });
  it("both body clips' declared durations are exactly 266 frames at 24fps", () => {
    const ms = Math.round((BASE_LOOP_FRAMES / BASE_LOOP_FPS) * 1000);
    assert.equal(STARRA_CLIPS[CONTINUOUS_BODY_CLIP].durationMs, ms);
    assert.equal(STARRA_CLIPS[SPEAKING_BODY_CLIP].durationMs, ms);
  });
  it("StarraClipFace indexes the body with bodyFrameAt, not with the bank's fps (source pin)", () => {
    assert.match(face, /const bodyFrame = bodyFrameAt\(video\.currentTime\);/);
    assert.ok(!/frameIndexAt\(video\.currentTime, b4\.fps/.test(face), "b4.fps must never drive the body frame index");
  });
});

describe("the speaking gate — a pure state machine, run on the shipped table", () => {
  const FULL = SPEAK_CONF_FULL;
  const FLOOR = SPEAK_CONF_FLOOR;
  it("starts shown, and a short dip below the floor is noise, not a turn", () => {
    const g = createSpeakGate();
    assert.equal(g.step(FULL, 0), true);
    assert.equal(g.step(FLOOR, 10), true);
    assert.equal(g.step(FLOOR, GATE_OFF_DEBOUNCE_MS - 1), true, "still shown just under the debounce");
    assert.equal(g.step(FULL, GATE_OFF_DEBOUNCE_MS + 10), true, "the dip ended: never hidden");
  });
  it("hides after the debounce, or at once when she has clearly turned", () => {
    const g = createSpeakGate();
    g.step(FLOOR, 0);
    assert.equal(g.step(FLOOR, GATE_OFF_DEBOUNCE_MS), false);
    const h = createSpeakGate();
    assert.equal(h.step(GATE_CLEARLY_TURNED, 0), false, "no debounce on a clear turn");
  });
  it("comes back the moment the track is at FULL — no dwell on a frontal face", () => {
    const g = createSpeakGate();
    g.step(GATE_CLEARLY_TURNED, 0);
    assert.equal(g.on, false);
    assert.equal(g.step((FULL + FLOOR) / 2, 5), false, "the band holds the last state");
    assert.equal(g.step(FULL, 6), true);
  });
  it("a non-finite confidence shows the mouth, never hides it", () => {
    const g = createSpeakGate();
    assert.equal(g.step(Number.NaN, 0), true);
  });
  it("over the shipped table at 60Hz: never hidden while she is frontal, few switches per loop", () => {
    const g = createSpeakGate();
    const HZ = 60;
    const LOOPS = 3;
    const loopSec = BASE_LOOP_FRAMES / BASE_LOOP_FPS;
    let switches = 0;
    let hiddenWhileFrontal = 0;
    let shownWhileTurned = 0;
    let prev = true;
    const ticks = Math.floor(loopSec * HZ * LOOPS);
    for (let t = 0; t < ticks; t++) {
      const sec = t / HZ;
      const frame = bodyFrameAt(sec % loopSec);
      const raw = bodyPatchRawConfidence("speak", frame);
      const on = g.step(raw, (t * 1000) / HZ);
      if (on !== prev) switches++;
      prev = on;
      if (!on && raw >= FULL) hiddenWhileFrontal++;
      if (on && raw <= FLOOR) shownWhileTurned++;
    }
    assert.equal(hiddenWhileFrontal, 0, "a hidden patch on a frontal face is lips that do not match her voice");
    assert.ok(switches / LOOPS <= 8, `switches per loop: ${switches / LOOPS}`);
    assert.ok(shownWhileTurned / ticks < 0.05, `shown-while-turned: ${((shownWhileTurned / ticks) * 100).toFixed(1)}%`);
  });
  it("the listening body is always 1 and the speaking body's raw value is the measured table", () => {
    assert.equal(bodyPatchRawConfidence("base", 100), 1);
    assert.ok(bodyPatchRawConfidence("speak", 0) <= 1 && bodyPatchRawConfidence("speak", 0) > 0);
    assert.equal(bodyPatchRawConfidence("speak", 99999), bodyPatchRawConfidence("speak", BASE_LOOP_FRAMES - 1));
  });
});

describe("the body switch survives a rollback, primes the right clip, and never crossfades unasked", () => {
  it("re-issues the switch on every tick of speech and the return on every quiet tick (source pins)", () => {
    assert.match(face, /wantSpeak = true;\s*\/\/ Re-issued on EVERY speaking tick/);
    assert.match(face, /\/\/ Quiet and past the hold: the listening body, re-issued the same way\.\s*if \(playingKey !== CONTINUOUS_BODY_CLIP\) play\(CONTINUOUS_BODY_CLIP\);/);
  });
  it("primes speak_loop.mp4 at call open, not the body that is already loading", () => {
    assert.match(face, /pre\.src = STARRA_CLIPS\[SPEAKING_BODY_CLIP\]\.file;/);
    assert.ok(!/pre\.src = STARRA_CLIPS\[CONTINUOUS_BODY_CLIP\]\.file;/.test(face));
  });
  it("the canplay handler is one-shot", () => {
    assert.match(face, /const go = \(\) => \{[^}]*playingEl\.oncanplay = null;/);
  });
});
