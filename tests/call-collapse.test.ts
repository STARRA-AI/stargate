/**
 * COLLAPSED CALL — pinned to source text.
 *
 * Two things here are safety, not styling:
 *   1. The toggle must render INSIDE `.call-face-stage`. The stage is the only
 *      thing still on screen when collapsed, so a toggle placed anywhere else
 *      is a one-way door.
 *   2. Collapsing may hide the engine selector, the status kicker and the chat
 *      pane. It may NOT hide MUTE or END CALL. There must be no state in which
 *      he is shrunk into a call he cannot end.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(import.meta.dirname, "..");
const overlay = readFileSync(join(REPO, "src/components/bridge/VoiceCallOverlay.tsx"), "utf8");
const deck = readFileSync(join(REPO, "src/styles/deck.css"), "utf8");

describe("collapsed call: the way out is always on screen", () => {
  it("renders the toggle inside .call-face-stage", () => {
    const stage = overlay.indexOf("call-face-stage call-face-");
    const btn = overlay.indexOf("call-collapse-btn");
    assert.ok(stage > -1, "stage element not found");
    assert.ok(btn > stage, "the collapse toggle must render inside the stage, not before it");
    // and before the stage's closing region: it must precede StarraClipFace's sibling chat pane
    assert.ok(btn < overlay.indexOf("call-chat-pane"), "toggle escaped the face column");
  });

  it("the toggle flips state and announces itself", () => {
    assert.match(overlay, /setCollapsed\(\(v\) => !v\)/, "toggle does not flip collapsed state");
    assert.match(overlay, /aria-expanded=\{!collapsed\}/, "toggle has no aria-expanded");
    assert.match(overlay, /aria-label=\{collapsed \?/, "toggle label does not change with state");
  });

  it("applies is-collapsed to the overlay root", () => {
    assert.match(
      overlay,
      /call-overlay call-facetime\$\{collapsed \? " is-collapsed" : ""\}/,
      "root className never receives is-collapsed",
    );
  });
});

describe("collapsed call: MUTE and END survive", () => {
  const hidden = [...deck.matchAll(/\.is-collapsed[^{]*\{[^}]*display:\s*none[^}]*\}/g)].map((m) => m[0]);

  it("hides only the chat pane, engine selector, note and status kicker", () => {
    const allowed = ["call-chat-pane", "call-engine-select", "call-engine-note", "call-ft-top"];
    for (const rule of hidden) {
      const selectors = rule.slice(0, rule.indexOf("{"));
      const named = selectors.match(/\.call-[a-z-]+/g) ?? [];
      for (const cls of named) {
        if (cls === ".call-facetime" || cls === ".call-face-col" || cls === ".call-face-stage") continue;
        assert.ok(
          allowed.some((a) => cls === `.${a}`),
          `collapsing hides ${cls}, which is not on the allow-list. If that is a control, he is trapped.`,
        );
      }
    }
  });

  it("never hides the controls row wholesale", () => {
    for (const rule of hidden) {
      const sel = rule.slice(0, rule.indexOf("{"));
      assert.doesNotMatch(
        sel,
        /\.call-ft-controls\s*(,|$|\{)/,
        "the whole controls row is hidden when collapsed - MUTE and END would go with it",
      );
    }
    assert.match(overlay, /call-end-btn/, "END CALL button missing entirely");
    assert.match(overlay, /call-mute-btn/, "MUTE button missing entirely");
  });
});

describe("collapsed call: the zoom composes with the presence layer", () => {
  it("zooms with `transform`, not the individual `scale` property", () => {
    const re = /\.is-collapsed\s+\.call-face-portrait[^{]*\{([^}]*)\}/;
    const m = re.exec(deck);
    assert.ok(m, "no collapsed zoom rule for .call-face-portrait");
    assert.match(m[1], /transform:\s*scale\(/, "collapsed zoom must use `transform: scale()`");
    assert.doesNotMatch(
      m[1],
      /(^|\s|;)scale:\s/,
      "using the `scale` property would OVERWRITE starra-breathe and freeze her while collapsed",
    );
    assert.match(m[1], /transform-origin:/, "zoom needs an origin or it centres on her chest");
  });

  it("keeps a sized stage rather than a full-bleed absolute layer", () => {
    const m = /\.call-facetime\.is-collapsed\s+\.call-face-stage\s*\{([^}]*)\}/.exec(deck);
    assert.ok(m, "collapsed stage rule missing");
    assert.match(m[1], /position:\s*relative/);
    assert.match(m[1], /aspect-ratio:/, "use aspect-ratio so the window keeps shape at any width");
  });

  it("the collapsed window is a real floating panel, not the fullscreen scrim", () => {
    const m = /\.call-overlay\.call-facetime\.is-collapsed\s*\{([^}]*)\}/.exec(deck);
    assert.ok(m, "collapsed overlay rule missing");
    assert.match(m[1], /backdrop-filter:\s*none/, "fullscreen blur must switch off when collapsed");
    assert.match(m[1], /border-radius:/);
    assert.match(m[1], /overflow:\s*hidden/, "the zoom would spill without clipping");
  });
});
