/**
 * HERO-FRAME STABILITY — the division's law (2026-07-31).
 *
 * Pins three invariants for StarraClipFace's video-layer compositing and the
 * mouth-patch silence gate:
 *
 *   1. The body-clip retry path never touches a currently-visible, healthy
 *      layer — retries operate exclusively on the hidden `back` layer, and
 *      only after re-confirming (at the moment of mutation) that it is still
 *      actually unhealthy.
 *   2. The crossfade is INCOMING-FADES-IN-OVER-OUTGOING: the outgoing layer
 *      stays at opacity 1 for the entire blend and is dropped only after the
 *      incoming layer's transitionend settles — never a double-fade where
 *      both layers sit below opacity 1 at the same instant.
 *   3. The composited mouth patch cannot render during silence, and the raw
 *      openness gate cannot chatter open/closed on noise sitting right at
 *      SILENCE_FLOOR (hysteresis: opens above the floor, only closes below
 *      the lower SILENCE_RELEASE_FLOOR).
 *
 * (1) and (2) are verified STRUCTURALLY, on the real source text — this repo
 * has no DOM/jsdom harness (verified: no jsdom/happy-dom/testing-library in
 * node_modules, no *.tsx test files), so StarraClipFace's closures cannot be
 * mounted and driven directly. This is the SAME technique the codebase
 * already uses for equally load-bearing invariants (see
 * no-test-video-engine-only.test.ts's "structural" describe block) — a
 * comment cannot fail, this can. (3) is a genuine behavioral test: the
 * silence gate is a real exported pure function, so it is driven with actual
 * Float32Arrays end to end.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  SILENCE_FLOOR,
  SILENCE_RELEASE_FLOOR,
  createMouthSmoother,
  createOpennessGate,
} from "../src/lib/voice/viseme-sync";

const REPO = resolve(import.meta.dirname, "..");
const FACE_SRC = readFileSync(
  join(REPO, "src/components/bridge/StarraClipFace.tsx"),
  "utf8",
);

// Strip comments so documentation prose (which freely discusses the OLD,
// fixed bug) can never itself trip a structural assertion below — only real
// code counts. Same technique as no-test-video-engine-only.test.ts.
const FACE_CODE = FACE_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /^\s*\/\/.*$/gm,
  "",
);

/** Extract the brace-balanced block starting at the first `{` after `needle`. */
function extractBlock(src: string, needle: string): string {
  const start = src.indexOf(needle);
  assert.ok(start >= 0, `expected to find "${needle}" in source`);
  const braceStart = src.indexOf("{", start);
  assert.ok(braceStart >= 0, `expected an opening brace after "${needle}"`);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting "${needle}"`);
}

describe("structural: crossfade is incoming-over-outgoing, never a double-fade", () => {
  const crossfadeBody = extractBlock(FACE_CODE, "const crossfadeToBack = () => {");

  it("does not dim the outgoing layer synchronously — only the deferred settle may", () => {
    // settleFront is a function EXPRESSION defined inline, so its body (which
    // legitimately sets opacity to 0, once the fade has landed) appears
    // textually before the `.addEventListener("transitionend", ...)` call that
    // arms it. Strip that nested body out first so this checks only the code
    // that actually runs SYNCHRONOUSLY when crossfadeToBack is invoked.
    const settleBlock = extractBlock(crossfadeBody, "const settleFront = () => {");
    const synchronousOnly = crossfadeBody.replace(settleBlock, "");
    const registerIdx = synchronousOnly.indexOf('.addEventListener("transitionend"');
    assert.ok(registerIdx > 0, "expected a transitionend listener registration");
    const beforeRegister = synchronousOnly.slice(0, registerIdx);
    assert.ok(
      !/opacity\s*=\s*"0"/.test(beforeRegister),
      "the outgoing layer must not be set to opacity 0 synchronously — that is " +
        "the double-fade bug: for the whole CROSSFADE_MS blend both layers " +
        "would sit below opacity 1 at once. It may only be hidden from inside " +
        "the deferred settle callback, once the incoming has actually landed.",
    );
  });

  it("only hides the outgoing layer after the incoming is published as the new front", () => {
    const publishIdx = crossfadeBody.indexOf("frontElRef.current = incoming;");
    assert.ok(publishIdx > 0, "expected the settle to publish frontElRef.current = incoming");
    const afterPublish = crossfadeBody.slice(publishIdx);
    assert.ok(
      /opacity\s*=\s*"0"/.test(afterPublish),
      "the outgoing layer's opacity must be dropped only inside the settle " +
        "callback, after the incoming has actually landed",
    );
  });

  it("stacks the incoming layer above the outgoing one before starting the fade-in", () => {
    const opacityOneIdx = crossfadeBody.indexOf('opacity = "1"');
    assert.ok(opacityOneIdx > 0, "expected the incoming layer's opacity to be set to 1");
    const zIndexRaise = crossfadeBody.search(/zIndex\s*=\s*"2"/);
    assert.ok(
      zIndexRaise >= 0 && zIndexRaise < opacityOneIdx,
      "the incoming layer must be stacked above the outgoing one (z-index) " +
        "BEFORE it starts fading in, so a partly-faded incoming layer is never " +
        "rendered underneath a still-opaque outgoing one",
    );
  });
});

describe("structural: body-clip retry never touches a healthy visible layer", () => {
  const retryBody = extractBlock(FACE_CODE, "const scheduleBodyRetry = () => {");

  it("guards the whole retry on bodyPlaybackHealthy() before scheduling anything", () => {
    const healthyIdx = retryBody.indexOf("bodyPlaybackHealthy()");
    const scheduleIdx = retryBody.indexOf("window.setTimeout(");
    assert.ok(healthyIdx >= 0, "expected the health check to be present");
    assert.ok(
      healthyIdx < scheduleIdx,
      "the health check must run before a retry is even scheduled",
    );
  });

  it("re-checks health at fire time, immediately before mutating the hidden layer", () => {
    const callback = extractBlock(retryBody, "window.setTimeout(() =>");
    const healthyIdx = callback.indexOf("bodyPlaybackHealthy()");
    const removeIdx = callback.indexOf('back.removeAttribute("src")');
    assert.ok(healthyIdx >= 0, "expected a re-check inside the retry callback");
    assert.ok(removeIdx >= 0, "expected the retry to clear back's src");
    assert.ok(
      healthyIdx < removeIdx,
      "the retry must re-verify the layer is STILL unhealthy immediately " +
        "before touching it — the backoff can be up to 8s, long enough for " +
        "the world to have healed underneath a stale scheduled retry",
    );
  });

  it("the retry callback mutates only the hidden back layer, never front/a/b directly", () => {
    const callback = extractBlock(retryBody, "window.setTimeout(() =>");
    assert.ok(
      !/\bfront\s*\./.test(callback),
      "the retry callback must never reference the front (visible) layer",
    );
    assert.ok(
      !/\ba\.(removeAttribute|pause|src)/.test(callback) &&
        !/\bb\.(removeAttribute|pause|src)/.test(callback),
      "the retry callback must mutate only `back`, never `a`/`b` by name",
    );
  });
});

describe("structural: no key/remount tied to mode or status", () => {
  it("the face stack renders with no React `key` prop anywhere in this file", () => {
    assert.ok(
      !/\bkey\s*=\s*[{"]/.test(FACE_CODE),
      "a keyed element would force React to unmount/remount on a key change " +
        "— the face stack must persist across mode/status changes",
    );
  });
});

describe("mouth openness gate — silence is exact zero, threshold cannot chatter", () => {
  const constantLevel = (rms: number, n = 512): Float32Array =>
    new Float32Array(n).fill(rms); // a constant-value buffer has rmsLevel === |rms|
  const silence = (n = 512): Float32Array => new Float32Array(n); // all zero

  it("is exactly 0 through a long silent analyser sequence", () => {
    const gate = createOpennessGate();
    for (let i = 0; i < 500; i++) {
      assert.equal(gate.step(silence()), 0, `block ${i} must be exactly 0 during silence`);
    }
  });

  it("stays exactly 0 through the real gate -> smoother pipeline during silence", () => {
    // Mirrors the production call site: smoother.step(opennessGate.step(...), dt).
    const gate = createOpennessGate();
    const smoother = createMouthSmoother();
    let v = -1;
    for (let i = 0; i < 200; i++) {
      v = smoother.step(gate.step(silence()), 16.7);
    }
    assert.equal(v, 0);
  });

  it("opens on level above SILENCE_FLOOR (the trigger is unchanged)", () => {
    const gate = createOpennessGate();
    const justAbove = gate.step(constantLevel(SILENCE_FLOOR * 1.2));
    assert.ok(justAbove > 0, "level above SILENCE_FLOOR must open the gate");
  });

  it("does not close on level dithering inside the hysteresis dead band once open", () => {
    const gate = createOpennessGate();
    assert.ok(gate.step(constantLevel(SILENCE_FLOOR * 1.2)) > 0, "opens the gate");
    const mid = (SILENCE_FLOOR + SILENCE_RELEASE_FLOOR) / 2;
    assert.ok(
      mid < SILENCE_FLOOR && mid > SILENCE_RELEASE_FLOOR,
      "sanity: the midpoint must sit strictly inside the dead band",
    );
    for (let i = 0; i < 20; i++) {
      const v = gate.step(constantLevel(mid));
      assert.ok(
        v > 0,
        `block ${i}: level in the dead band (between SILENCE_RELEASE_FLOOR and ` +
          `SILENCE_FLOOR) must stay engaged, not snap to 0 and reopen every block`,
      );
    }
  });

  it("closes once level actually drops below the release floor", () => {
    const gate = createOpennessGate();
    gate.step(constantLevel(SILENCE_FLOOR * 1.2)); // open it first
    const v = gate.step(constantLevel(SILENCE_RELEASE_FLOOR * 0.5));
    assert.equal(v, 0, "level under the release floor must close the gate");
  });

  it("closing does not stick open forever — a later real silence still gates to 0", () => {
    const gate = createOpennessGate();
    gate.step(constantLevel(SILENCE_FLOOR * 1.2));
    gate.step(constantLevel(SILENCE_RELEASE_FLOOR * 0.5)); // closes
    for (let i = 0; i < 50; i++) {
      assert.equal(gate.step(silence()), 0);
    }
  });
});

/**
 * THE STACKING-CONTEXT TRAP. `.call-face-portrait` is `position:absolute` with a
 * `z-index`, so it establishes a stacking context: every child of it — including
 * StarraClipFace's own blurred `.call-face-backdrop` <video> — paints entirely
 * above ANY sibling of `.call-face-portrait`, whatever that sibling's z-index.
 * A backstop rendered in VoiceCallOverlay's `.call-face-stage` is therefore dead
 * on arrival: permanently hidden behind the very blur it exists to cover. This
 * suite pins the backstop where it actually works.
 */
describe("structural: the hero-frame backstop is inside the portrait stacking context", () => {
  const CSS = readFileSync(join(REPO, "src/styles/deck.css"), "utf8");
  const OVERLAY = readFileSync(
    join(REPO, "src/components/bridge/VoiceCallOverlay.tsx"),
    "utf8",
  ).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("StarraClipFace renders it, and VoiceCallOverlay does not", () => {
    assert.ok(
      FACE_CODE.includes("call-face-hero-still"),
      "StarraClipFace must render the backstop itself — it is the only place " +
        "inside .call-face-portrait's stacking context",
    );
    assert.ok(
      !OVERLAY.includes("call-face-hero-still"),
      "a backstop in .call-face-stage is a sibling of .call-face-portrait and " +
        "can never be seen through it — do not put it back",
    );
  });

  it("sits after the blurred backdrop and before both live layers", () => {
    const backdrop = FACE_CODE.indexOf('className="call-face-backdrop"');
    const still = FACE_CODE.indexOf('className="call-face-hero-still"');
    const layerA = FACE_CODE.indexOf("ref={aRef}");
    const layerB = FACE_CODE.indexOf("ref={bRef}");
    assert.ok(backdrop >= 0 && still >= 0 && layerA >= 0 && layerB >= 0);
    assert.ok(
      backdrop < still,
      "the backstop wins its z-index tie with the backdrop by TREE ORDER — " +
        "it must come second, or the blur paints over it",
    );
    assert.ok(
      still < layerA && still < layerB,
      "the backstop must be declared before the live layers",
    );
  });

  it("uses the same clip and geometry as the live layers, never played", () => {
    const still = FACE_CODE.indexOf('className="call-face-hero-still"');
    const block = FACE_CODE.slice(still, still + 600);
    assert.ok(
      /src=\{STARRA_CLIPS\[CONTINUOUS_BODY_CLIP\]\.file\}/.test(block),
      "the backstop must show the SAME clip the live layers play, or the " +
        "still would not register with her face",
    );
    assert.ok(/\.pause\(\)/.test(block), "it must pause — it is a still, not a second playing copy");
    assert.ok(!/\bloop\b/.test(block), "a backstop must never loop");
    assert.ok(/\bmuted\b/.test(block), "unmuted autoplay would be blocked and would add a second audio source");
  });

  it("is painted below the live layers and above the blur, per deck.css", () => {
    const rule = extractBlock(CSS, ".call-face-hero-still");
    assert.match(rule, /z-index:\s*0\b/, "same level as the backdrop; tree order breaks the tie");
    assert.match(
      rule,
      /object-fit:\s*contain/,
      "must match the live layers' inline objectFit:contain or the still is misaligned",
    );
    assert.ok(
      !/(filter|transform|opacity)\s*:/.test(rule),
      "the backstop must never be filtered, scaled or faded — that is the bug",
    );
    // The live layers sit above it; the blurred backdrop sits at the same level
    // but earlier in tree order.
    assert.match(extractBlock(CSS, ".call-face-backdrop"), /z-index:\s*0\b/);
    assert.ok(
      /ref=\{aRef\}[^/]*zIndex:\s*1/.test(FACE_CODE) && /ref=\{bRef\}[^/]*zIndex:\s*1/.test(FACE_CODE),
      "both live layers must sit above the backstop",
    );
  });
});
