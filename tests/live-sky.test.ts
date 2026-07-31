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

/**
 * MEASUREMENTS — the recorded constants are pinned to source here so the
 * MEASUREMENTS block atop LiveSky.tsx can never quietly disagree with the
 * code. If a number is tuned, this suite fails until the record is updated.
 */
describe("MEASUREMENTS — recorded constants match source", () => {
  const block = sky.slice(sky.indexOf("MEASUREMENTS (recorded"));

  it("the MEASUREMENTS record exists in source and in deck.css", () => {
    assert.ok(block.length > 0, "LiveSky.tsx must carry a MEASUREMENTS block");
    assert.ok(css.includes("MEASUREMENTS"), "deck.css must carry the reactor-center measurement");
    assert.ok(
      block.includes("AUTHED-DOM VERIFICATION — NOT PERFORMED"),
      "the live-DOM leg stays honestly flagged, never implied",
    );
  });

  it("starfield: 120 stars over three depths whose shares sum to 1.00", () => {
    assert.ok(/const STAR_COUNT = 120;/.test(sky));
    const layers = [...sky.matchAll(
      /\{ share: ([\d.]+), speed: ([\d.]+), minSize: ([\d.]+), maxSize: ([\d.]+), alpha: ([\d.]+) \}/g,
    )].map((m) => m.slice(1).map(Number));
    assert.deepEqual(layers, [
      [0.45, 2.0, 0.6, 1.0, 0.55],
      [0.35, 3.2, 0.9, 1.4, 0.75],
      [0.2, 5.0, 1.2, 1.8, 1.0],
    ]);
    const shares = layers.reduce((a, L) => a + L[0], 0);
    assert.ok(Math.abs(shares - 1) < 1e-9, `shares must sum to 1.00, got ${shares}`);
    const drawn = layers.reduce((a, L) => a + Math.round(120 * L[0]), 0);
    assert.equal(drawn, 120, "rounded per-layer counts must equal STAR_COUNT");
  });

  it("timings: drift 200deg, twinkle 2-6s, streak 6-14s gap / 700ms life", () => {
    assert.ok(/const DRIFT_RAD = \(200 \* Math\.PI\) \/ 180;/.test(sky));
    assert.ok(/const TWINKLE_MIN_S = 2;/.test(sky));
    assert.ok(/const TWINKLE_MAX_S = 6;/.test(sky));
    assert.ok(/const SHOOT_GAP_MIN_MS = 6_000;/.test(sky));
    assert.ok(/const SHOOT_GAP_MAX_MS = 14_000;/.test(sky));
    assert.ok(/const SHOOT_LIFE_MS = 700;/.test(sky));
  });

  it("frame budget: dpr capped at 2, delta-t clamped at 0.1s", () => {
    assert.ok(/Math\.min\(window\.devicePixelRatio \|\| 1, 2\)/.test(sky), "dpr cap 2");
    assert.ok(/Math\.min\(\(t - last\) \/ 1000, 0\.1\)/.test(sky), "delta-t clamp 0.1s");
  });

  it("reactor: ring sizes/periods, glow, and the dimmed nebula wash", () => {
    const rule = (sel: string) => {
      const m = new RegExp(`\\n\\${sel} \\{([^}]*)\\}`).exec(css);
      assert.ok(m, `missing rule: ${sel}`);
      return m[1];
    };
    const r1 = rule(".reactor-ring-1");
    const r2 = rule(".reactor-ring-2");
    const r3 = rule(".reactor-ring-3");
    assert.ok(r1.includes("width: 40vmin") && r1.includes("spin-cw 18s") && r1.includes("opacity: 0.75"));
    assert.ok(r2.includes("width: 54vmin") && r2.includes("spin-ccw 45s") && r2.includes("opacity: 0.55"));
    assert.ok(r3.includes("width: 68vmin") && r3.includes("spin-cw 90s") && r3.includes("opacity: 0.4"));
    const glow = rule(".reactor-core-glow");
    assert.ok(glow.includes("width: 26vmin") && glow.includes("core-breathe 4.5s"));
    assert.ok(/50%\s*\{ transform: scale\(1\.06\)/.test(css), "core breathes to 1.06");
    assert.ok(rule(".galaxy-spin").includes("opacity: 0.4"), "nebula dimmed so the canvas reads on top");
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
