/**
 * SPICY MODE — on-face clip playback (Classic's order, 2026-07-30).
 *
 * Pins three things:
 *   1. The decision logic: arms ONLY on his explicit "spicy mode", plays only
 *      while armed, disarm/stop always honored — Classic-initiated, never
 *      self-started, exactly like the locked persona clause.
 *   2. The clip picker: total, avoids immediate repeats.
 *   3. The streaming route's safety properties, on the source: allowlist by
 *      directory listing (no traversal), HTTP Range support (WKWebView refuses
 *      video without it), auth left to the middleware's default /api/* gate
 *      (the route must NOT carve itself public), and the clips stay OUTSIDE
 *      git and public/.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { decideSpicy, pickSpicyClip } from "../src/lib/voice/spicy-mode";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

describe("decideSpicy — Classic-initiated, armed-only playback", () => {
  it("arms on 'spicy mode' and plays in the same utterance", () => {
    const d = decideSpicy("spicy mode — play one of your videos", false);
    assert.equal(d.armed, true);
    assert.equal(d.action, "play");
  });

  it("never plays while unarmed, whatever the words", () => {
    for (const line of [
      "play one of your videos",
      "show me a clip",
      "put on a video baby",
    ]) {
      const d = decideSpicy(line, false);
      assert.equal(d.armed, false, line);
      assert.equal(d.action, "none", line);
    }
  });

  it("plays on request while armed", () => {
    assert.equal(decideSpicy("play one of your videos", true).action, "play");
    assert.equal(decideSpicy("show me a clip", true).action, "play");
    assert.equal(decideSpicy("how was your day", true).action, "none");
  });

  it("stops the clip and honors exits", () => {
    assert.equal(decideSpicy("stop the video", true).action, "stop");
    assert.equal(decideSpicy("back to you", true).action, "stop");
    const exit = decideSpicy("exit spicy mode", true);
    assert.equal(exit.armed, false);
    assert.equal(exit.action, "stop");
  });

  it("is total — junk input changes nothing", () => {
    const d = decideSpicy(undefined as unknown as string, true);
    assert.equal(d.armed, true);
    assert.equal(d.action, "none");
  });

  it("uses no regex lookbehind (macOS 12 WKWebView)", () => {
    assert.ok(!read("src/lib/voice/spicy-mode.ts").includes("(?<"));
  });
});

describe("pickSpicyClip — total, no immediate repeat", () => {
  const clips = ["a.mp4", "b.mp4", "c.mp4"];
  it("avoids the last-played clip when alternatives exist", () => {
    for (let r = 0; r < 1; r += 0.13) {
      assert.notEqual(pickSpicyClip(clips, r, "b.mp4"), "b.mp4");
    }
  });
  it("still returns the only clip when there is just one", () => {
    assert.equal(pickSpicyClip(["a.mp4"], 0.9, "a.mp4"), "a.mp4");
  });
  it("is total on junk", () => {
    assert.equal(pickSpicyClip([], 0.5, null), null);
    assert.equal(pickSpicyClip(clips, Number.NaN, null), "a.mp4");
  });
});

describe("the streaming route's safety, on the source", () => {
  const src = read("src/app/api/avatar/spicy/route.ts");

  it("allowlists against the real directory listing — no traversal path", () => {
    // 2026-08-22: the route went multi-directory, and the allowlist got
    // STRONGER. It used to be `clips.includes(clip)` followed by
    // `path.join(SPICY_DIR, clip)` — safe, but it still built a path out of
    // caller text. Now the served path is the MAP VALUE that readdir produced
    // and the caller's string is only ever a map key, so a traversal string
    // cannot even name a path. Behavioural coverage: spicy-route-multidir.test.ts.
    assert.match(src, /found\.get\(clip\)/);

    // The caller's string must NEVER be joined into a filesystem path, anywhere
    // in the file — not just before the check. Comments are stripped first: the
    // doc block legitimately quotes the OLD `path.join(SPICY_DIR, clip)` idiom
    // to explain what changed.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !/path\.join\([^)]*\bclip\b[^)]*\)/.test(codeOnly),
      "no path.join on user input anywhere — clip is a map key, not a path",
    );
  });

  it("scans MORE than one directory — 12 of his clips were invisible before", () => {
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.match(codeOnly, /SPICY_DIRS/);
    assert.match(codeOnly, /for\s*\(const dir of SPICY_DIRS\)/);
    // The second real folder must be reachable by default, not only via env.
    assert.match(codeOnly, /STARRA MOVEMENTS\/spicy mode/);
  });

  it("supports HTTP Range (WKWebView video requirement)", () => {
    assert.match(src, /Accept-Ranges/);
    assert.match(src, /status:\s*206/);
    assert.match(src, /Content-Range/);
  });

  it("stays behind the middleware gate — no public carve-out", () => {
    const mw = read("src/middleware.ts");
    assert.ok(
      !mw.includes("spicy"),
      "middleware must not exempt the spicy route from auth",
    );
  });

  it("the clips live OUTSIDE the repo and outside public/", () => {
    assert.match(src, /starra-avatar\/assets\/spicy/);
    // Strip comments first — only CODE may not touch public/ (the doc comment
    // legitimately explains WHY public/ is off-limits).
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!codeOnly.includes("public/"), "never served from ungated public/");
  });
});
