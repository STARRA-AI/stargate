/**
 * SPICY ROUTE — MULTI-DIRECTORY LISTING.
 *
 * The defect this pins (found 2026-08-22): Classic had 18 spicy clips on disk
 * across two folders, and the route hardcoded ONE of them, so the deck could
 * only ever see 5. Thirteen clips he made were invisible to his own deck.
 *
 * The route now merges a LIST of directories into one flat namespace. These
 * tests exist because the merge is where a path-traversal hole would hide:
 * the old code built `path.join(SPICY_DIR, clip)` from the caller's string
 * after an allowlist check, whereas the new code serves the path stored by
 * readdir and uses the caller's string ONLY as a map key. The traversal cases
 * below pin that distinction — they must 404, not read a neighbouring file.
 *
 * SPICY_DIRS is resolved at module scope from the environment, so every case
 * sets STARRA_SPICY_DIR and then imports the route with a cache-busting query
 * so the constant is re-evaluated.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let root = "";
let dirA = "";
let dirB = "";

/** Import a FRESH copy of the route with SPICY_DIRS re-read from the env. */
let bust = 0;
async function loadRoute(dirs: string[]) {
  process.env.STARRA_SPICY_DIR = dirs.join(path.delimiter);
  return (await import(
    `../src/app/api/avatar/spicy/route?multidir=${bust++}`
  )) as { GET(req: Request): Promise<Response> };
}

const req = (qs = "") =>
  new Request(`https://localhost:3000/api/avatar/spicy${qs}`);

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "spicy-multidir-"));
  dirA = path.join(root, "a");
  dirB = path.join(root, "b");
  await fs.mkdir(dirA);
  await fs.mkdir(dirB);

  await fs.writeFile(path.join(dirA, "spicy_mode.mp4"), "AAAA");
  await fs.writeFile(path.join(dirA, "shared.mp4"), "FROM-A");
  await fs.writeFile(path.join(dirA, "notes.txt"), "not a video");

  await fs.writeFile(path.join(dirB, "spicy1.mp4"), "BBBB");
  await fs.writeFile(path.join(dirB, "spicy5.MP4"), "UPPER");
  await fs.writeFile(path.join(dirB, "shared.mp4"), "FROM-B");

  // A file OUTSIDE both configured dirs — the traversal target.
  await fs.writeFile(path.join(root, "secret.mp4"), "SECRET");
});

after(async () => {
  delete process.env.STARRA_SPICY_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

describe("spicy route — multi-directory listing", () => {
  it("merges .mp4 files from EVERY configured directory", async () => {
    const { GET } = await loadRoute([dirA, dirB]);
    const body = (await (await GET(req())).json()) as { clips: string[] };
    assert.deepEqual(body.clips, [
      "shared.mp4",
      "spicy1.mp4",
      "spicy5.MP4",
      "spicy_mode.mp4",
    ]);
  });

  it("is the whole point: a second directory adds clips the first never had", async () => {
    const onlyA = (await (
      await (await loadRoute([dirA])).GET(req())
    ).json()) as { clips: string[] };
    const both = (await (
      await (await loadRoute([dirA, dirB])).GET(req())
    ).json()) as { clips: string[] };

    assert.ok(!onlyA.clips.includes("spicy1.mp4"));
    assert.ok(both.clips.includes("spicy1.mp4"));
    assert.ok(both.clips.length > onlyA.clips.length);
  });

  it("keeps a single directory working exactly as before", async () => {
    const { GET } = await loadRoute([dirA]);
    const body = (await (await GET(req())).json()) as { clips: string[] };
    assert.deepEqual(body.clips, ["shared.mp4", "spicy_mode.mp4"]);
  });

  it("ignores non-.mp4 files and accepts an UPPERCASE extension", async () => {
    const { GET } = await loadRoute([dirA, dirB]);
    const body = (await (await GET(req())).json()) as { clips: string[] };
    assert.ok(!body.clips.includes("notes.txt"));
    assert.ok(body.clips.includes("spicy5.MP4"));
  });

  it("streams a clip that lives in the SECOND directory", async () => {
    const { GET } = await loadRoute([dirA, dirB]);
    const res = await GET(req("?clip=spicy1.mp4"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "video/mp4");
    assert.equal(await res.text(), "BBBB");
  });

  it("gives the FIRST directory precedence on a duplicate basename", async () => {
    const ab = await loadRoute([dirA, dirB]);
    assert.equal(await (await ab.GET(req("?clip=shared.mp4"))).text(), "FROM-A");

    const ba = await loadRoute([dirB, dirA]);
    assert.equal(await (await ba.GET(req("?clip=shared.mp4"))).text(), "FROM-B");
  });

  it("skips a missing directory instead of taking the library offline", async () => {
    const { GET } = await loadRoute([path.join(root, "does-not-exist"), dirB]);
    const body = (await (await GET(req())).json()) as { clips: string[] };
    assert.ok(body.clips.includes("spicy1.mp4"));
  });

  it("returns an empty list, never a throw, when NO directory is readable", async () => {
    const { GET } = await loadRoute([path.join(root, "nope")]);
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { clips: string[] }).clips, []);
  });

  it("REFUSES traversal — the caller's string is a map key, not a path", async () => {
    const { GET } = await loadRoute([dirA, dirB]);
    for (const attack of [
      "../secret.mp4",
      "../../secret.mp4",
      "..%2Fsecret.mp4",
      path.join(root, "secret.mp4"),
      "/etc/hosts",
      "./spicy1.mp4",
      "b/spicy1.mp4",
    ]) {
      const res = await GET(
        req(`?clip=${encodeURIComponent(attack)}`),
      );
      assert.equal(res.status, 404, `traversal leaked for ${attack}`);
    }
  });

  it("serves a byte range so Safari/WKWebView will play the mp4", async () => {
    const { GET } = await loadRoute([dirA, dirB]);
    const r = new Request("https://localhost:3000/api/avatar/spicy?clip=spicy1.mp4", {
      headers: { range: "bytes=1-2" },
    });
    const res = await GET(r);
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("Content-Range"), "bytes 1-2/4");
    assert.equal(await res.text(), "BB");
  });
});
