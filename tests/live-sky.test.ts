/**
 * LIVE SKY — source pins for the per-frame canvas starfield + reactor rings.
 *
 * Pins: (1) LiveSky is zero-dep (react only) and hand-rolled canvas;
 * (2) the rAF loop STOPS (cancelAnimationFrame), never merely skips, and
 * honors all three stillness gates (hidden tab / ECO / reduced motion);
 * (3) the canvas is decorative and pointer-transparent; (4) Bridge mounts
 * the canvas + reactor rings and the superseded CSS star/shooting divs are
 * gone; (5) deck.css carries no orphaned twinkle/shoot keyframes and the
 * ring geometry hangs off the --reactor-cx/--reactor-cy nudge vars.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

const sky = read("src/components/bridge/LiveSky.tsx");
const bridge = read("src/components/bridge/Bridge.tsx");
const css = read("src/styles/deck.css");

describe("LiveSky — zero-dep per-frame canvas contract", () => {
  it("imports nothing beyond react", () => {
    const specs = [...sky.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    assert.ok(specs.length >= 1, "LiveSky must import react");
    for (const s of specs) assert.equal(s, "react", `unexpected import: ${s}`);
  });

  it("stops, never skips: cancelAnimationFrame is present", () => {
    assert.ok(sky.includes("cancelAnimationFrame"));
    assert.ok(sky.includes("requestAnimationFrame"));
  });

  it("honors all three stillness gates", () => {
    assert.ok(sky.includes("document.hidden"), "hidden-tab gate");
    assert.ok(sky.includes("low-power"), "ECO gate");
    assert.ok(sky.includes("prefers-reduced-motion"), "reduced-motion gate");
  });

  it("is decorative: aria-hidden canvas, pointer-events none via .live-sky", () => {
    assert.ok(sky.includes("aria-hidden"));
    assert.ok(sky.includes('className="live-sky"'));
    const start = css.indexOf(".live-sky");
    assert.ok(start >= 0, ".live-sky must be styled in deck.css");
    const block = css.slice(start, css.indexOf("}", start));
    assert.ok(/pointer-events:\s*none/.test(block), "canvas must be pointer-transparent");
    assert.ok(/z-index:\s*1/.test(block), "canvas sits above artwork (0), below panels (2)");
  });

  it("never throws: the frame body is guarded", () => {
    assert.ok(sky.includes("try {") && sky.includes("} catch"), "bad frame disables the sky, not the deck");
  });
});

describe("Bridge — canvas sky supersedes the CSS star layers", () => {
  it("mounts LiveSky, three reactor rings and the core glow", () => {
    assert.ok(bridge.includes("<LiveSky"));
    assert.equal((bridge.match(/reactor-ring-/g) ?? []).length, 3, "exactly three arc rings");
    assert.ok(bridge.includes("reactor-core-glow"));
  });

  it("old galaxy-stars / shooting-star divs are gone; nebula wash stays", () => {
    assert.ok(!bridge.includes("galaxy-stars"));
    assert.ok(!bridge.includes("shooting-star"));
    assert.ok(bridge.includes("galaxy-spin"), "the nebula color wash stays under the canvas");
  });
});

describe("deck.css — no orphans, rings on the reactor nudge vars", () => {
  it("superseded star/shoot CSS is fully removed", () => {
    for (const gone of ["galaxy-stars", "twinkle-a", "twinkle-b", "shooting-star", ".ss-1", "@keyframes shoot"]) {
      assert.ok(!css.includes(gone), `orphaned: ${gone}`);
    }
  });

  it("ring geometry centers on --reactor-cx/--reactor-cy", () => {
    assert.ok(css.includes("--reactor-cx: 50%"));
    assert.ok(css.includes("--reactor-cy: 49%"));
    assert.ok(css.includes("left: var(--reactor-cx)"));
    assert.ok(css.includes("top: var(--reactor-cy)"));
  });

  it("rings + glow freeze under ECO and prefers-reduced-motion", () => {
    assert.ok(css.includes("body.low-power .reactor-ring"));
    assert.ok(css.includes("body.low-power .reactor-core-glow"));
    const prm = css.indexOf("@media (prefers-reduced-motion: reduce)");
    assert.ok(prm >= 0);
    const prmBlock = css.slice(prm, prm + 400);
    assert.ok(prmBlock.includes(".reactor-ring"), "rings freeze under reduced motion");
    assert.ok(prmBlock.includes(".reactor-core-glow"), "glow freezes under reduced motion");
  });
});
