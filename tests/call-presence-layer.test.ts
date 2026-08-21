/**
 * The CALL PRESENCE LAYER — pinned to source text, the same way
 * tests/deck-design-system.test.ts pins the deck primitives.
 *
 * WHAT THIS PROTECTS. `base_loop.mp4` is 266 frames / 11.0833s and her head
 * travels 10x17px across the whole thing (starra-clip-map.ts:100-102). The
 * presence layer is what stops that from reading as a photograph with a moving
 * mouth. It is pure CSS with no runtime error surface, so a rename, a tidy-up,
 * or a "simplify the guards" pass would silently return her to a still frame
 * with nothing failing. Hence: source text.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(import.meta.dirname, "..");
const deck = readFileSync(join(REPO, "src/styles/deck.css"), "utf8");

/** MEASURED on the shipped file, quoted from starra-clip-map.ts:24-25. */
const CLIP_SECONDS = 11.0833;

/** Pull the `animation-duration: A, B;` pair out of a single-line rule. */
function durationsFor(selector: string): number[] {
  const line = deck
    .split("\n")
    .find((l) => l.trim().startsWith(selector) && l.includes("animation-duration"));
  assert.ok(line, `no animation-duration rule found for ${selector}`);
  const decl = /animation-duration:\s*([^;]+);/.exec(line as string);
  assert.ok(decl, `malformed animation-duration for ${selector}`);
  return (decl as RegExpExecArray)[1]
    .split(",")
    .map((s) => Number.parseFloat(s.trim().replace(/s$/, "")));
}

/**
 * deck.css contains SEVERAL `prefers-reduced-motion` blocks (the galaxy spin and
 * reactor ring have their own). Select by CONTENT, never by position — a
 * position-based match silently asserts against an unrelated block and passes.
 */
function reducedMotionBlockGuarding(needle: string): string {
  const blocks = [
    ...deck.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g),
  ].map((m) => m[1]);
  const hit = blocks.find((b) => b.includes(needle));
  assert.ok(hit, `no prefers-reduced-motion block mentions ${needle}`);
  return hit as string;
}

describe("presence layer: she is never a still frame", () => {
  it("declares BOTH verbs on .call-face-portrait", () => {
    const rule = /\.call-face-portrait\s*\{[^}]*\}/g;
    const withAnim = [...deck.matchAll(rule)].find((m) => m[0].includes("animation:"));
    assert.ok(withAnim, ".call-face-portrait declares no animation");
    assert.match(withAnim[0], /starra-handheld/, "handheld drift is missing");
    assert.match(withAnim[0], /starra-breathe/, "breathe is missing");
  });

  it("defines the keyframes both verbs name", () => {
    assert.match(deck, /@keyframes\s+starra-handheld\s*\{/);
    assert.match(deck, /@keyframes\s+starra-breathe\s*\{/);
    assert.match(deck, /@keyframes\s+starra-grain\s*\{/);
  });

  it("uses INDIVIDUAL transform properties, not `transform`", () => {
    // One element cannot run two `transform` animations on two periods — the
    // second silently wins and one verb disappears. translate/rotate/scale
    // compose. If someone "simplifies" these back into transform, she loses a verb.
    const kf = /@keyframes\s+starra-handheld\s*\{([\s\S]*?)\n\}/.exec(deck);
    assert.ok(kf, "handheld keyframes not found");
    assert.match(kf[1], /translate:/, "handheld must animate `translate`");
    assert.match(kf[1], /rotate:/, "handheld must animate `rotate`");
    assert.doesNotMatch(kf[1], /[^-]transform:/, "handheld must NOT use `transform`");
  });
});

describe("presence layer: every state is retimed, none is unguarded", () => {
  for (const state of ["speaking", "listening", "idle"]) {
    it(`.call-face-${state} retimes both verbs`, () => {
      const d = durationsFor(`.call-face-${state}`);
      assert.equal(d.length, 2, `${state} must retime handheld AND breathe`);
      assert.ok(d.every((n) => Number.isFinite(n) && n > 0), `${state} has a bad duration`);
    });
  }
});

describe("presence layer: periods never re-align with the clip", () => {
  /**
   * THE INVARIANT. The clip visibly repeats every 11.0833s. If a presence
   * period is a near-integer ratio of that, the two cycles lock and the eye
   * learns the loop — which is the exact failure the layer exists to prevent.
   * Every period must sit at least 0.12 away from any integer ratio in EITHER
   * direction. Checked numerically so a future retune cannot quietly break it.
   */
  const MIN_DISTANCE = 0.12;

  const all: Array<[string, number]> = [];
  for (const state of ["speaking", "listening", "idle"]) {
    durationsFor(`.call-face-${state}`).forEach((d, i) =>
      all.push([`${state}/${i === 0 ? "handheld" : "breathe"}`, d]),
    );
  }

  for (const [label, seconds] of all) {
    it(`${label} (${seconds}s) does not lock to the 11.0833s clip`, () => {
      const ratio = seconds / CLIP_SECONDS;
      const inverse = CLIP_SECONDS / seconds;
      const dist = Math.min(
        Math.round(ratio) >= 1 ? Math.abs(ratio - Math.round(ratio)) : Number.POSITIVE_INFINITY,
        Math.round(inverse) >= 1 ? Math.abs(inverse - Math.round(inverse)) : Number.POSITIVE_INFINITY,
      );
      assert.ok(
        dist >= MIN_DISTANCE,
        `${label}=${seconds}s sits ${dist.toFixed(3)} from an integer ratio of the clip ` +
          `(min ${MIN_DISTANCE}). The loop would re-announce itself.`,
      );
    });
  }
});

describe("presence layer: accessibility and low-power guards", () => {
  /**
   * THE LANDMINE THIS PINS. `transform: none` does NOT clear `translate`,
   * `rotate` or `scale` — they are separate properties with separate initial
   * values. A guard that only resets `transform` freezes her mid-drift, off
   * centre and slightly rolled, instead of bringing her to rest. The previous
   * guards also named only listening/speaking, leaving `.call-face-idle` — the
   * state she is in for most of a call — completely unguarded.
   */
  const guards: Array<[string, () => string]> = [
    ["prefers-reduced-motion", () => reducedMotionBlockGuarding(".call-face-portrait")],
    ["low-power", () => {
      const m = /body\.low-power\s+\.call-face-portrait\s*\{([^}]*)\}/.exec(deck);
      assert.ok(m, "low-power guard block not found");
      return (m as RegExpExecArray)[1];
    }],
  ];

  for (const [label, get] of guards) {
    it(`${label} resets translate, rotate AND scale, not just transform`, () => {
      const block = get();
      for (const prop of ["translate:", "rotate:", "scale:"]) {
        assert.ok(
          block.includes(prop),
          `${label} guard never resets \`${prop}\` — she would freeze mid-drift`,
        );
      }
      assert.match(block, /animation:\s*none/, `${label} guard does not stop the animation`);
    });
  }

  it("reduced motion guards .call-face-portrait itself, not only some states", () => {
    const block = reducedMotionBlockGuarding(".call-face-portrait");
    assert.match(
      block,
      /(^|\s)\.call-face-portrait\s*\{/m,
      "guard must target .call-face-portrait unconditionally so no state is missed",
    );
  });

  it("both guards stop the grain flicker", () => {
    const stopped = deck.match(/\.call-face-stage::after\s*\{\s*animation:\s*none;\s*\}/g) ?? [];
    assert.ok(
      stopped.length >= 2,
      "grain's step flicker must be stopped under BOTH reduced-motion and low-power",
    );
  });
});

describe("presence layer: grain and vignette cannot eat input or chrome", () => {
  /**
   * Select the DEFINING block by content, not by position. State overrides
   * (e.g. the collapsed call retunes the vignette) also match the selector,
   * and a position-based match silently asserts against the override instead.
   */
  const overlay = (pseudo: string) => {
    const re = new RegExp(`\\.call-face-stage::${pseudo}\\s*\\{([\\s\\S]*?)\\n\\}`, "g");
    const blocks = [...deck.matchAll(re)].map((m) => m[1]);
    const defining = blocks.find((b) => b.includes("content:") && b.includes("position:"));
    assert.ok(defining, `::${pseudo} defining overlay block not found`);
    return defining as string;
  };

  for (const pseudo of ["after", "before"]) {
    it(`::${pseudo} is pointer-events:none and sits below the controls`, () => {
      const block = overlay(pseudo);
      assert.match(block, /pointer-events:\s*none/, `::${pseudo} would swallow clicks`);
      const z = /z-index:\s*(\d+)/.exec(block);
      assert.ok(z, `::${pseudo} has no z-index`);
      // .call-ft-top and .call-ft-controls are z-index 3. Grain grades HER,
      // it must never sit over the operator's status text or buttons.
      assert.ok(
        Number(z[1]) < 3,
        `::${pseudo} at z-index ${z[1]} would cover the call controls`,
      );
    });
  }

  it("grain overhangs the stage so drift cannot expose an edge", () => {
    assert.match(overlay("after"), /inset:\s*-50%/);
  });
});
