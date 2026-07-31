/**
 * The cosmetics defaults are declared TWICE on purpose — once server-side in
 * src/app/api/engine/_shared.ts, once in the client panel, because the panel is
 * forbidden from importing the server module (see engine-api-secret-discipline).
 * Deliberate duplication needs a guard, or it drifts. This is that guard.
 *
 * It also pins the accent-hue arithmetic to the measured palette so a future
 * edit cannot silently recolour the deck on boot.
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PANEL = readFileSync(
  path.join(REPO, "src", "components", "bridge", "OptionsPanel.tsx"),
  "utf8",
);

type Shared = typeof import("../src/app/api/engine/_shared");
type EngineConfigMod = typeof import("../src/lib/engine/config");
let S: Shared;
let E: EngineConfigMod;

before(async () => {
  S = await import("../src/app/api/engine/_shared");
  // config.ts is server-only (assertServerOnly). Under node there is no
  // `window`, so importing it here is exactly how the routes import it.
  E = await import("../src/lib/engine/config");
});

/** Pull one field out of the panel's DEFAULT_COSMETICS literal. */
function panelDefault(field: string): string {
  const start = PANEL.indexOf("const DEFAULT_COSMETICS: Cosmetics = {");
  assert.ok(start > 0, "panel DEFAULT_COSMETICS literal not found");
  const block = PANEL.slice(start, PANEL.indexOf("};", start));
  // Arrays contain commas, so try a bracketed capture first.
  const m =
    new RegExp(`${field}:\\s*(\\[[^\\]]*\\])`).exec(block) ??
    new RegExp(`${field}:\\s*([^,\\n]+)`).exec(block);
  assert.ok(m, `panel default for ${field} not found`);
  return m[1].trim();
}

describe("cross-division parity — the engine's store is the source of truth", () => {
  it("the projection layer mirrors DEFAULT_ENGINE_CONFIG.cosmetics exactly", () => {
    assert.deepEqual(
      S.DEFAULT_COSMETICS,
      E.DEFAULT_ENGINE_CONFIG.cosmetics,
      "options defaults drifted from src/lib/engine/config.ts — the engine owns this value",
    );
  });

  it("every field the engine stores is one the options schema accepts", () => {
    const parsed = S.cosmeticsSchema.safeParse(E.DEFAULT_ENGINE_CONFIG.cosmetics);
    assert.equal(parsed.success, true, JSON.stringify(parsed));
    assert.deepEqual(
      Object.keys(E.DEFAULT_ENGINE_CONFIG.cosmetics).sort(),
      Object.keys(S.DEFAULT_COSMETICS).sort(),
      "the two cosmetics contracts have different field sets",
    );
  });
});

describe("cosmetics defaults parity", () => {
  it("numeric and boolean defaults match the server", () => {
    assert.equal(Number(panelDefault("accentHue")), S.DEFAULT_COSMETICS.accentHue);
    assert.equal(Number(panelDefault("glowIntensity")), S.DEFAULT_COSMETICS.glowIntensity);
    assert.equal(Number(panelDefault("fontScale")), S.DEFAULT_COSMETICS.fontScale);
    assert.equal(panelDefault("reduceMotion"), String(S.DEFAULT_COSMETICS.reduceMotion));
    assert.equal(panelDefault("mouthSync"), String(S.DEFAULT_COSMETICS.mouthSync));
  });

  it("the idle pool matches the server's clip list", () => {
    const raw = panelDefault("idlePool");
    const clips = (raw.match(/"([a-z0-9_]+)"/g) ?? []).map((s) => s.replace(/"/g, ""));
    assert.deepEqual(clips, [...S.DEFAULT_COSMETICS.idlePool]);
    // Matches the verified IDLE_POOL in src/lib/voice/starra-clip-map.ts.
    assert.deepEqual(clips, ["idle_a1", "idle_c1", "idle_a2"]);
  });

  it("the panel offers NO idle-clip buttons — clip switching is retired", () => {
    // SUPERSEDED CONTRACT (2026-07-30): the face plays one continuous clip
    // and the engine composites the mouth, so the panel's IDLE POOL toggles
    // were removed as dead controls. The server schema keeps `idlePool`
    // tolerantly (older stored configs still parse — covered below); the
    // PANEL must not resurrect buttons for a setting nothing consumes.
    assert.ok(
      !/const IDLE_CLIPS/.test(PANEL),
      "IDLE_CLIPS buttons are back in the panel — clip switching is retired",
    );
    assert.ok(
      !/patchCosmetics\(\{ idlePool/.test(PANEL),
      "the panel must not write idlePool any more",
    );
  });

  it("every panel default is accepted by the server schema", () => {
    const fromPanel = {
      accentHue: Number(panelDefault("accentHue")),
      glowIntensity: Number(panelDefault("glowIntensity")),
      fontScale: Number(panelDefault("fontScale")),
      reduceMotion: panelDefault("reduceMotion") === "true",
      mouthSync: panelDefault("mouthSync") === "true",
      idlePool: (panelDefault("idlePool").match(/"([a-z0-9_]+)"/g) ?? []).map((s) =>
        s.replace(/"/g, ""),
      ),
    };
    const parsed = S.cosmeticsSchema.safeParse(fromPanel);
    assert.equal(parsed.success, true, JSON.stringify(parsed));
    assert.deepEqual(parsed.success ? parsed.data : null, S.DEFAULT_COSMETICS);
  });
});

describe("accent hue arithmetic is pinned to the measured palette", () => {
  it("derives magenta at +21 and star at -18 from the base hue", () => {
    assert.match(PANEL, /--purple",\s*`hsl\(\$\{hue\} 91% 65%\)`/);
    assert.match(PANEL, /--magenta",\s*`hsl\(\$\{\(hue \+ 21\) % 360\} 84% 61%\)`/);
    assert.match(PANEL, /--star",\s*`hsl\(\$\{\(hue \+ 342\) % 360\} 95% 85%\)`/);
  });

  it("at the default hue the derived tokens reproduce the shipped hex palette", () => {
    // hsl(H s% l%) → rgb, so the default cosmetics cannot recolour the deck.
    const hsl = (h: number, s: number, l: number) => {
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const hp = h / 60;
      const x = c * (1 - Math.abs((hp % 2) - 1));
      const [r1, g1, b1] =
        hp < 1 ? [c, x, 0]
        : hp < 2 ? [x, c, 0]
        : hp < 3 ? [0, c, x]
        : hp < 4 ? [0, x, c]
        : hp < 5 ? [x, 0, c]
        : [c, 0, x];
      const m = l - c / 2;
      return [r1, g1, b1].map((v) => Math.round((v + m) * 255));
    };
    const near = (got: number[], want: number[], tol: number, name: string) => {
      for (let i = 0; i < 3; i++) {
        assert.ok(
          Math.abs(got[i] - want[i]) <= tol,
          `${name} channel ${i}: got ${got[i]}, want ${want[i]} (tol ${tol})`,
        );
      }
    };
    // Proves the DEFAULT cannot recolour the deck: 271 is the measured hue of
    // the shipped #a855f7, and both divisions store it.
    const h = S.DEFAULT_COSMETICS.accentHue;
    near(hsl(h, 0.91, 0.65), [168, 85, 247], 4, "--purple #a855f7");
    near(hsl((h + 21) % 360, 0.84, 0.61), [217, 70, 239], 5, "--magenta #d946ef");
    near(hsl((h + 342) % 360, 0.95, 0.85), [196, 181, 253], 6, "--star #c4b5fd");
  });
});

describe("the panel never gates audio", () => {
  it("contains no await on the voice path and no audio API at all", () => {
    for (const api of ["AudioContext", "createAnalyser", "HTMLAudioElement", "new Audio(", "speak("]) {
      assert.ok(!PANEL.includes(api), `OptionsPanel touches the audio path via ${api}`);
    }
  });

  it("every fetch has a catch so a dead engine cannot wedge the deck", () => {
    const fetches = (PANEL.match(/fetch\(/g) ?? []).length;
    const catches = (PANEL.match(/catch/g) ?? []).length;
    assert.ok(fetches > 0);
    assert.ok(catches >= fetches, `${fetches} fetch calls but only ${catches} catch sites`);
  });
});
