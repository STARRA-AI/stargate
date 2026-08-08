/**
 * B2 deck-primitives pass — source-text assertions (house style: deck-prefs.test.ts).
 *
 * Confirms the five ScreenShell screens adopted the shared `.deck-panel`
 * primitive, none of the six B2 files still carries the old ad-hoc
 * `panel-etch p-4` / `panel-etch p-5` pairing, connectors renders a real
 * `.deck-badge`, and login stays the pre-auth gate: no ScreenShell import,
 * `redirectTarget` untouched.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const SCREEN_SHELL_SCREENS = [
  "src/app/brief/page.tsx",
  "src/app/connectors/page.tsx",
  "src/app/memory/page.tsx",
  "src/app/pipeline/page.tsx",
  "src/app/vault/page.tsx",
];

const ALL_SIX = [...SCREEN_SHELL_SCREENS, "src/app/login/page.tsx"];

describe("deck primitives — five ScreenShell screens", () => {
  it("every ScreenShell screen uses deck-panel", () => {
    for (const rel of SCREEN_SHELL_SCREENS) {
      assert.match(read(rel), /deck-panel/, `${rel} should contain deck-panel`);
    }
  });
});

describe("deck primitives — no leftover ad-hoc panel padding", () => {
  it("none of the six files still pairs panel-etch with p-4 or p-5", () => {
    for (const rel of ALL_SIX) {
      const src = read(rel);
      assert.doesNotMatch(
        src,
        /panel-etch p-4/,
        `${rel} should not contain "panel-etch p-4"`,
      );
      assert.doesNotMatch(
        src,
        /panel-etch p-5/,
        `${rel} should not contain "panel-etch p-5"`,
      );
    }
  });
});

describe("connectors status badges", () => {
  it("renders deck-badge for connector status", () => {
    const src = read("src/app/connectors/page.tsx");
    assert.match(src, /deck-badge/, "connectors should render deck-badge");
    assert.match(src, /is-ok/);
    assert.match(src, /is-danger/);
    assert.match(src, /is-idle/);
  });
});

describe("login stays the pre-auth gate", () => {
  it("still contains redirectTarget and does not import ScreenShell", () => {
    const src = read("src/app/login/page.tsx");
    assert.match(src, /redirectTarget/, "login must still define/use redirectTarget");
    assert.doesNotMatch(
      src,
      /ScreenShell/,
      "login must not import or use ScreenShell — it is the pre-auth gate",
    );
  });
});
