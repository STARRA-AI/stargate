/**
 * ALIVE BODY MODE — she moves, and `still` mode stays untouched.
 *
 * THE DEFECT THIS PINS (found 2026-08-22). Eleven photoreal clips of her —
 * nodding, glancing, tilting, laughing, raising an eyebrow — sat in
 * public/avatar/clips/ with zero references anywhere in src/. They were benched
 * because every one of them differs from `base_loop` at rest by 14-29x its own
 * natural motion (StarraClipFace.tsx:1029-1038).
 *
 * That comparison was against the WRONG reference. base_loop is 552x720 from a
 * different generation; these are 832x1248, the exact size of his ANGLE stills.
 * Measured against EACH OTHER (scripts/clip-compat-matrix.py, verified at full
 * resolution): all 55 first-frame pairs match, all 110 transitions pass, and a
 * real 11-clip chain seams at 1.65-2.36 — i.e. 0.81x-1.17x the 2.025 seam
 * base_loop already ships and that the code itself calls invisible.
 *
 * Two things must hold forever, and they are what these tests are:
 *   1. `still` mode behaves EXACTLY as it shipped — one clip, every state. His
 *      working deck must not change because this landed.
 *   2. `alive` mode never schedules a clip from outside the anchor family,
 *      because a cross-family switch IS the visible cut (~26, and
 *      scripts/match-families.py shows crop+grade cannot close it).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  STARRA_CLIPS,
  ALIVE_POOL,
  ALIVE_SPEAKING_CLIP,
  ALIVE_BASE_CLIP,
  CONTINUOUS_BODY_CLIP,
  IDLE_POOL,
  pickBodyClip,
  pickAlive,
  isAlivePoolMember,
  aliveShouldAdvance,
  ALIVE_QUIET_TICKS_BEFORE_ADVANCE,
  type StarraClipKey,
} from "../src/lib/voice/starra-clip-map";

const ANCHOR_FAMILY_FILES = new Set<string>(
  [...ALIVE_POOL, ALIVE_SPEAKING_CLIP, ALIVE_BASE_CLIP].map(
    (k) => STARRA_CLIPS[k].file,
  ),
);

describe("still mode is exactly what shipped", () => {
  it("plays the continuous body clip in every state", () => {
    for (const speaking of [true, false]) {
      for (const r of [0, 0.25, 0.5, 0.99]) {
        assert.equal(
          pickBodyClip("still", speaking, null, r),
          CONTINUOUS_BODY_CLIP,
          `still mode must never switch (speaking=${speaking} rand=${r})`,
        );
      }
    }
  });

  it("ignores prev and the pool entirely — there is nothing to schedule", () => {
    assert.equal(pickBodyClip("still", false, "a_nod", 0.5, ALIVE_POOL), CONTINUOUS_BODY_CLIP);
  });

  it("treats an unknown mode as still, never as alive", () => {
    // A bad value must degrade to his working deck, not to the new path.
    assert.equal(pickBodyClip("nonsense" as never, false, null, 0.5), CONTINUOUS_BODY_CLIP);
  });
});

describe("alive mode schedules only the anchor family", () => {
  it("uses her real talking footage while speaking", () => {
    assert.equal(pickBodyClip("alive", true, null, 0.5), ALIVE_SPEAKING_CLIP);
    assert.equal(STARRA_CLIPS[ALIVE_SPEAKING_CLIP].loop, true, "speech must not run dry mid-sentence");
  });

  it("never returns a clip outside the family, across the whole rand range", () => {
    for (let i = 0; i < 200; i++) {
      const key = pickBodyClip("alive", false, null, i / 200);
      assert.ok(
        ANCHOR_FAMILY_FILES.has(STARRA_CLIPS[key].file),
        `alive mode scheduled ${key}, which is outside the anchor family — that is the visible cut`,
      );
    }
  });

  it("never returns an IDLE_POOL member — that is the cross-family cut", () => {
    const idleFiles = new Set<string>(IDLE_POOL.map((k) => STARRA_CLIPS[k].file));
    for (let i = 0; i < 200; i++) {
      const key = pickBodyClip("alive", false, null, i / 200);
      assert.ok(!idleFiles.has(STARRA_CLIPS[key].file), `alive mode leaked into the 768x1168 idle pool via ${key}`);
    }
  });

  it("every pool member is a real registered clip with a real duration", () => {
    for (const k of ALIVE_POOL) {
      const c = STARRA_CLIPS[k];
      assert.ok(c, `${k} is not registered`);
      assert.match(c.file, /^\/avatar\/clips\/.+\.mp4$/, k);
      assert.ok(c.durationMs > 500, `${k} duration ${c.durationMs}ms looks wrong`);
    }
  });

  it("pool members play once so the scheduler gets an `ended` to act on", () => {
    // A looping pool member never fires `ended`, so her face would freeze on it.
    for (const k of ALIVE_POOL) {
      assert.equal(STARRA_CLIPS[k].loop, false, `${k} loops — the scheduler would never advance`);
    }
  });
});

describe("pickAlive", () => {
  it("avoids an immediate repeat", () => {
    for (const prev of ALIVE_POOL) {
      for (let i = 0; i < 60; i++) {
        assert.notEqual(pickAlive(prev, i / 60), prev, `repeated ${prev}`);
      }
    }
  });

  it("clamps rand at both ends instead of indexing off the array", () => {
    for (const r of [-1, -0.001, 1, 1.5, NaN, Infinity]) {
      const k = pickAlive(null, r as number);
      assert.ok(ALIVE_POOL.includes(k as never), `rand ${r} produced ${k}`);
    }
  });

  it("falls back to the alive pool when handed an empty or bad pool", () => {
    for (const bad of [[], null, undefined, "nope"]) {
      const k = pickAlive(null, 0.5, bad as never);
      assert.ok(ALIVE_POOL.includes(k as never), `bad pool ${JSON.stringify(bad)} produced ${k}`);
    }
  });

  it("still returns something usable when the pool holds exactly one clip", () => {
    const one = ["a_nod"] as readonly StarraClipKey[];
    // prev === the only member: it must return that member, not undefined.
    assert.equal(pickAlive("a_nod", 0.5, one), "a_nod");
  });
});

describe("isAlivePoolMember", () => {
  it("accepts pool members and rejects everything else", () => {
    for (const k of ALIVE_POOL) assert.equal(isAlivePoolMember(k), true, k);
    for (const bad of [
      CONTINUOUS_BODY_CLIP, ALIVE_SPEAKING_CLIP, "idle_a1", "talking",
      "", null, undefined, 3, {}, [], "constructor", "__proto__", "toString",
    ]) {
      assert.equal(isAlivePoolMember(bad), false, JSON.stringify(bad));
    }
  });
});


describe("a long run of handovers, simulated", () => {
  /** Drive the scheduler the way the face does: each `ended` picks the next. */
  function runChain(turns: number, speakingAt: (i: number) => boolean) {
    const seq: StarraClipKey[] = [];
    let prev: StarraClipKey | null = null;
    // Deterministic pseudo-random so a failure is reproducible.
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < turns; i++) {
      const next = pickBodyClip("alive", speakingAt(i), prev, rand());
      seq.push(next);
      prev = next;
    }
    return seq;
  }

  it("never leaves the anchor family across 500 handovers", () => {
    const seq = runChain(500, (i) => i % 7 === 0);
    for (const k of seq) {
      assert.ok(
        ANCHOR_FAMILY_FILES.has(STARRA_CLIPS[k].file),
        `handover produced ${k}, outside the family — that is the visible cut`,
      );
    }
  });

  it("never repeats a gesture back to back", () => {
    // Excludes the speaking clip, which legitimately repeats while she talks.
    const seq = runChain(500, () => false);
    for (let i = 1; i < seq.length; i++) {
      assert.notEqual(seq[i], seq[i - 1], `repeated ${seq[i]} at ${i}`);
    }
  });

  it("does not get stuck alternating a pair — she has to look alive", () => {
    const seq = runChain(500, () => false);
    const distinct = new Set(seq).size;
    assert.ok(
      distinct >= ALIVE_POOL.length - 1,
      `only ${distinct} of ${ALIVE_POOL.length} gestures ever appeared — she would read as a loop`,
    );
  });

  it("returns to gestures after a run of speaking", () => {
    // First 20 turns speaking, then idle: she must resume moving, not freeze on
    // the talking clip.
    const seq = runChain(40, (i) => i < 20);
    assert.ok(seq.slice(0, 20).every((k) => k === ALIVE_SPEAKING_CLIP), "should speak while speaking");
    const after = seq.slice(20);
    assert.ok(after.some((k) => k !== ALIVE_SPEAKING_CLIP), "she never went back to moving");
    assert.ok(
      after.every((k) => ANCHOR_FAMILY_FILES.has(STARRA_CLIPS[k].file)),
      "left the family on the way back from speech",
    );
  });
});

/* ── the wiring in the face itself ──────────────────────────────────────── */

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Strip comments so a doc block naming a symbol cannot pass or fail a check. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const FACE = strip(readFileSync(path.join(REPO, "src/components/bridge/StarraClipFace.tsx"), "utf8"));

describe("StarraClipFace wiring", () => {
  it("arms the handover INSIDE play, not once before the first clip", () => {
    // THE BUG THIS PINS, caught before it ever ran. play() does
    // `back.onended = …` on the hidden layer, and the layers SWAP on every
    // crossfade. Arming `ended` once on both elements before the first play
    // therefore gets cleared by that very first play(), and she freezes on her
    // first gesture forever — a still frame, with every test still green.
    assert.match(
      FACE,
      /back\.onended\s*=\s*\n?\s*bodyMode === "alive"/,
      "play() must arm the alive handover on the layer carrying the clip",
    );
    assert.ok(
      !/armAliveHandover/.test(FACE),
      "the pre-arm helper is the freeze bug — play() owns the handover",
    );
  });

  it("never arms `ended` on a looping clip — it would never fire", () => {
    assert.match(FACE, /bodyMode === "alive" && !clip\.loop/);
  });

  it("HAS a second way off the looping speaking clip, or alive mode dead-ends", () => {
    // THE BUG THIS PINS, found in review 2026-09-09: `ended` is the only thing
    // that advances the alive scheduler, and ALIVE_SPEAKING_CLIP is the one
    // pool member with loop:true — so it fires no `ended`. The first time she
    // spoke, she locked onto talking footage for the whole session. The guard
    // above is correct AND was not sufficient on its own.
    assert.match(
      FACE,
      /aliveShouldAdvance\(bodyMode, playingKey, quietTicks\)/,
      "the body heartbeat must be able to push her off the looping talking clip",
    );
    assert.match(
      FACE,
      /if \(speakingRef\.current\) quietTicks = 0;/,
      "audio truth must reset the quiet counter",
    );
  });

  it("rewinds the scheduler when a crossfade rolls back, not just the pixels", () => {
    // Review finding 2026-09-09: settleFront's rollback restored opacity and the
    // front/back aliases but left playingKey/scheduledFile ADVANCED. In alive
    // mode that is a permanent stall — the looping talking clip stays on screen
    // with `ended` cleared, while playingKey says "gesture" so aliveShouldAdvance
    // never nudges it either.
    assert.match(FACE, /prevPlayingKey = playingKey;/);
    assert.match(FACE, /prevScheduledFile = scheduledFile;/);
    assert.match(
      FACE,
      /if \(prevScheduledFile !== null\) \{[\s\S]{0,120}?playingKey = prevPlayingKey;[\s\S]{0,120}?scheduledFile = prevScheduledFile;/,
      "the rollback must restore both",
    );
  });

  it("a HIDDEN layer may not vouch for a broken visible one", () => {
    // The outgoing layer is set to opacity 0 but never paused, so in alive mode
    // it keeps playing invisibly. With the family-wide layerLanded it would
    // otherwise satisfy bodyPlaybackHealthy() and suppress recovery while the
    // visible layer was actually broken.
    assert.match(FACE, /const layerShowing = \(el: HTMLVideoElement\): boolean => el\.style\.opacity !== "0";/);
    assert.match(
      FACE,
      /bodyPlaybackHealthy = \(\) => \[a, b\]\.some\(\(el\) => layerShowing\(el\) && layerHealthy\(el\)\)/,
    );
  });

  it("judges layer health against the whole family, not just the newest file", () => {
    // Review finding 2026-09-09: play() advances `scheduledFile` synchronously
    // while the incoming clip is still loading, so for that whole window the
    // OUTGOING (visible, healthy) layer read as "not landed" and sent the 2s
    // heartbeat into scheduleBodyRetry() — yanking the clip that was loading.
    assert.match(FACE, /const aliveFiles = new Set<string>\(/);
    assert.match(FACE, /aliveFiles\.has\(src\)/);
  });

  it("takes speaking from the BUS, never from the analyser's presence", () => {
    // The call's analyser tap lives for the WHOLE call, so `analyser !== null`
    // is permanently true inside a call — she would have counted as speaking
    // start to finish and never gestured once.
    assert.match(FACE, /speakingRef\.current = bus\.speaking;/);
    assert.ok(
      !/speakingRef\.current = bus\.speaking \|\| analyser !== null/.test(FACE),
      "analyser presence is not audio truth",
    );
  });

  it("keeps cosmetics out of the clip effect's dependency list", () => {
    // Pinned independently of cosmetics-live-hook.test.ts because it is THIS
    // change that would most plausibly break it: a bodyMode dep tears both
    // video layers down and rebuilds them, i.e. a black flash mid-call.
    assert.match(FACE, /bodyModeRef\.current/, "bodyMode must be read through a ref");
    assert.ok(
      !/\}, \[active, bodyMode\]\)/.test(FACE),
      "bodyMode must never appear in the clip effect's deps",
    );
  });

  it("still mode never reaches the alive scheduler", () => {
    assert.match(FACE, /if \(bodyMode === "alive"\) \{[\s\S]{0,200}?scheduleNextAlive\(\);[\s\S]{0,120}?\} else \{[\s\S]{0,120}?play\(CONTINUOUS_BODY_CLIP\);/);
  });

  it("reads speaking through a ref so a voice transition cannot restart playback", () => {
    assert.match(FACE, /speakingRef\.current/);
  });
});

describe("aliveShouldAdvance — the nudge off the looping talking clip", () => {
  const QUIET = ALIVE_QUIET_TICKS_BEFORE_ADVANCE;

  it("advances once she has been quiet for the full run of ticks", () => {
    assert.equal(aliveShouldAdvance("alive", ALIVE_SPEAKING_CLIP, QUIET), true);
    assert.equal(aliveShouldAdvance("alive", ALIVE_SPEAKING_CLIP, QUIET + 5), true);
  });

  it("does NOT advance on a single quiet tick — that is an INTER-CHUNK GAP", () => {
    // speakStarraChunks publishes {playing:false} at the end of EVERY chunk, so
    // bus.speaking drops between the sentences of one reply. Advancing on one
    // quiet sample would cut her talking footage into a gesture mid-sentence.
    for (let t = 1; t < QUIET; t++) {
      assert.equal(
        aliveShouldAdvance("alive", ALIVE_SPEAKING_CLIP, t),
        false,
        `${t} quiet tick(s) must not be read as the end of her turn`,
      );
    }
  });

  it("does NOT advance while she is still talking (counter at zero)", () => {
    assert.equal(aliveShouldAdvance("alive", ALIVE_SPEAKING_CLIP, 0), false);
  });

  it("needs more than one tick, or the gap guard is meaningless", () => {
    assert.ok(
      ALIVE_QUIET_TICKS_BEFORE_ADVANCE >= 2,
      "a threshold of 1 is the single-sample bug this constant exists to prevent",
    );
  });

  it("never interrupts a gesture — those hand over on `ended` themselves", () => {
    for (const key of ALIVE_POOL) {
      for (const ticks of [0, QUIET, QUIET + 10]) {
        assert.equal(
          aliveShouldAdvance("alive", key, ticks),
          false,
          `${key} must be allowed to finish its motion (${ticks} quiet ticks)`,
        );
      }
    }
  });

  it("is inert in still mode, whatever else is true", () => {
    for (const ticks of [0, QUIET, QUIET + 10]) {
      assert.equal(aliveShouldAdvance("still", ALIVE_SPEAKING_CLIP, ticks), false);
      assert.equal(aliveShouldAdvance("still", null, ticks), false);
    }
  });

  it("is inert before anything has been scheduled", () => {
    assert.equal(aliveShouldAdvance("alive", null, QUIET + 10), false);
  });

  it("the clip it guards really is the looping one — the whole reason it exists", () => {
    assert.equal(
      STARRA_CLIPS[ALIVE_SPEAKING_CLIP].loop,
      true,
      "if this ever becomes non-looping, `ended` covers it and this guard is redundant",
    );
    for (const key of ALIVE_POOL) {
      assert.equal(STARRA_CLIPS[key].loop, false, `${key} must hand over on ended`);
    }
  });
});
