/**
 * The loading skeleton's contract is half JSX and half CSS, so both halves are
 * asserted here:
 *   - it renders exactly `rows` bars and needs no data wiring at a call site;
 *   - the stylesheet keeps the aesthetic + motion invariants (no new hex, the
 *     sweep rides `transform` not a paint property, reduced motion kills it).
 * The CSS half is checked against the file's own source because there is no
 * DOM/CSSOM in this suite — a string check on the real stylesheet still fails
 * loudly if someone reintroduces a repainting animation or a raw color.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import Module, { createRequire } from "node:module";
import * as React from "react";

// tsx's esbuild transform falls back to classic JSX (React.createElement) for
// this repo's tsconfig ("jsx": "preserve"), which Next's own compiler otherwise
// handles via the automatic runtime — so under plain node:test there is no
// global `React`. Provide one locally; production bundling is untouched.
(globalThis as unknown as { React: unknown }).React = React;

// Skeleton.tsx imports a `.module.css` file — real CSS, not JS. tsx's require
// hook (no webpack/jsdom in this suite) throws parsing it as CommonJS. Stub
// `.css` to an empty export at the require-extension level, local to this
// file only — same pattern as tests/call-chat-fresh.test.ts.
(Module as unknown as { _extensions: Record<string, (m: NodeModule, filename: string) => void> })
  ._extensions[".css"] = (m) => {
  (m as unknown as { exports: unknown }).exports = {};
};

const require = createRequire(__filename);
const { Skeleton } = require(
  "../src/components/hud/Skeleton",
) as typeof import("../src/components/hud/Skeleton");

const css = readFileSync(
  new URL("../src/components/hud/Skeleton.module.css", import.meta.url),
  "utf8",
);

describe("Skeleton — render shape", () => {
  it("renders exactly `rows` bars", () => {
    const el = Skeleton({ rows: 3 }) as React.ReactElement<{ children: unknown[] }>;
    assert.ok(el, "Skeleton({ rows }) must return an element");
    assert.equal(el.props.children.length, 3);
  });

  it("renders nothing to loop over at zero rows", () => {
    const el = Skeleton({ rows: 0 }) as React.ReactElement<{ children: unknown[] }>;
    assert.equal(el.props.children.length, 0);
  });

  it("announces itself to assistive tech", () => {
    const el = Skeleton({ rows: 2 }) as React.ReactElement<{ role: string }>;
    assert.equal(el.props.role, "status");
  });
});

describe("Skeleton.module.css — locked invariants", () => {
  it("stops the sweep under prefers-reduced-motion", () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /animation:\s*none/);
  });

  it("animates transform only — never a paint property", () => {
    assert.match(css, /transform:\s*translateX/);
    assert.doesNotMatch(css, /background-position/);
  });

  it("introduces no new hex colors", () => {
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  });
});
