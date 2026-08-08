/**
 * DECK PRIMITIVES v1 — the two large screens (/tools and /settings).
 *
 * Source-text assertions, same house style as tests/deck-prefs.test.ts: no DOM,
 * no renderer, just `node:fs` reading what actually shipped. These guard the
 * three things a future edit is most likely to break by accident:
 *
 *   1. The `#link-apis` and `#voice` anchors. LOAD-BEARING — Bridge.tsx links
 *      to /settings#link-apis at Bridge.tsx:468,650,735,789,998. Bridge.tsx is
 *      off-limits, so the anchors have to survive on this side.
 *   2. The 11×-repeated raw h2 Tailwind string must not creep back in. It is
 *      `.deck-title` now, in one place, in globals.css.
 *   3. Every screen keeps at least one visible status badge.
 *
 * NOTE ON "BOTH FILES": /settings was split ONLY as far as it paid. `#voice`
 * moved to VoicePanel.tsx with its three sub-toggles; `#link-apis` (KeyVault)
 * stayed in page.tsx because tests/engine-minors-key-provenance.test.ts:336-353
 * asserts the shadowing copy against page.tsx's SOURCE TEXT — extracting it
 * would silently blind that guard. So the anchor assertions run against the
 * settings SOURCE SET (page + the components it renders) and the import edge is
 * asserted separately, which is what actually proves the anchor reaches the DOM.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const TOOLS = "src/app/tools/page.tsx";
const SETTINGS = "src/app/settings/page.tsx";
const SETTINGS_VOICE = "src/components/screens/settings/VoicePanel.tsx";

/** Every file that renders as part of a screen, keyed by screen. */
const SCREENS: Record<string, string[]> = {
  tools: [TOOLS],
  settings: [SETTINGS, SETTINGS_VOICE],
};

/** The exact 5-class string that used to be pasted on every section h2. */
const OLD_H2 =
  "font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase";

describe("deck screens — load-bearing anchors", () => {
  it("keeps id=\"link-apis\" (Bridge.tsx deep-links to /settings#link-apis)", () => {
    const src = SCREENS.settings.map(read).join("\n");
    assert.ok(src.includes('id="link-apis"'), "#link-apis anchor is gone");
  });

  it("keeps id=\"voice\"", () => {
    const src = SCREENS.settings.map(read).join("\n");
    assert.ok(src.includes('id="voice"'), "#voice anchor is gone");
  });

  /** An anchor in an unimported file is a dead anchor. */
  it("settings/page.tsx actually renders the panels holding those anchors", () => {
    const page = read(SETTINGS);
    assert.ok(page.includes('id="link-apis"'), "#link-apis left page.tsx");
    assert.ok(page.includes("screens/settings/VoicePanel"), "VoicePanel not imported");
    assert.ok(page.includes("<VoicePicker />"), "VoicePicker not rendered");
  });

  /**
   * KeyVault must NOT be extracted: engine-minors-key-provenance.test.ts reads
   * page.tsx's source text for this copy. Extracting it turns that guard green
   * on an empty file instead of failing loudly.
   */
  it("keeps the shadowing copy in page.tsx where its existing guard reads it", () => {
    const page = read(SETTINGS);
    for (const needle of ["shadowedByEngine", "shadowed", "OVERRIDDEN IN OPTIONS"]) {
      assert.ok(page.includes(needle), `"${needle}" left settings/page.tsx`);
    }
  });
});

describe("deck screens — primitives replace the copy-pasted classes", () => {
  for (const [screen, files] of Object.entries(SCREENS)) {
    it(`${screen}: no file re-pastes the old h2 Tailwind string`, () => {
      for (const f of files) {
        assert.ok(!read(f).includes(OLD_H2), `${f} still pastes the raw h2 classes`);
      }
    });

    it(`${screen}: uses deck-panel and deck-title`, () => {
      const src = files.map(read).join("\n");
      assert.ok(src.includes("deck-panel"), `${screen} has no deck-panel`);
      assert.ok(src.includes("deck-title"), `${screen} has no deck-title`);
    });

    it(`${screen}: renders at least one status badge`, () => {
      const src = files.map(read).join("\n");
      assert.ok(src.includes("deck-badge"), `${screen} has no deck-badge`);
      // A badge with no state class is an uncoloured pill — the state IS the point.
      assert.ok(
        /is-ok|is-warn|is-danger|is-idle/.test(src),
        `${screen} has a deck-badge with no state class`,
      );
    });
  }
});

describe("deck screens — no hand-rolled CSS on this side", () => {
  it("neither screen defines its own <style> block", () => {
    for (const f of [...SCREENS.tools, ...SCREENS.settings]) {
      assert.ok(!read(f).includes("<style"), `${f} defines a <style> block`);
    }
  });

  /** Repo hard rule: WKWebView on macOS 12 chokes on lookbehind. */
  it("no regex lookbehind", () => {
    for (const f of [...SCREENS.tools, ...SCREENS.settings]) {
      const src = read(f);
      assert.ok(!src.includes("(?<="), `${f} uses a lookbehind`);
      assert.ok(!src.includes("(?<!"), `${f} uses a negative lookbehind`);
    }
  });
});
