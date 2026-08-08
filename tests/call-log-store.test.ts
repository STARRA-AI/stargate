/**
 * BUG 3 — PER-CALL CONVERSATION ARCHIVE. call-log.ts is one JSON file per
 * call, storage dir resolved STARRA_CALL_LOG_DIR → /Volumes/Storage/STARRA/calls
 * (if mounted) → <cwd>/data/calls. It sits on the LIVE CALL PATH (Agent B's
 * fire-and-forget POSTs), so nothing here may ever throw.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendTurn, listSessions, readSession } from "../src/lib/memory/call-log";

let dir: string;
const ORIGINAL_ENV = process.env.STARRA_CALL_LOG_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "call-log-"));
  process.env.STARRA_CALL_LOG_DIR = dir;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.STARRA_CALL_LOG_DIR;
  else process.env.STARRA_CALL_LOG_DIR = ORIGINAL_ENV;
  rmSync(dir, { recursive: true, force: true });
});

describe("call-log — append/list/read round-trip (STARRA_CALL_LOG_DIR)", () => {
  it("creates the session file on the first turn and appends after", async () => {
    await appendTurn("call-1", { role: "user", text: "hi", at: "t0" });
    await appendTurn("call-1", { role: "assistant", text: "hey", at: "t1" });

    const full = await readSession("call-1");
    assert.ok(full);
    assert.equal(full!.id, "call-1");
    assert.equal(full!.turns.length, 2);
    assert.deepEqual(full!.turns[0], { role: "user", text: "hi", at: "t0" });
    assert.deepEqual(full!.turns[1], { role: "assistant", text: "hey", at: "t1" });
    assert.ok(existsSync(join(dir, "call-1.json")));
  });

  it("readSession on an id that was never appended is null, not a throw", async () => {
    assert.equal(await readSession("never-existed"), null);
  });

  it("listSessions is newest-first and trims turn text to a preview", async () => {
    await appendTurn("call-old", { role: "user", text: "old call", at: "2020-01-01T00:00:00.000Z" });
    await appendTurn("call-new", {
      role: "user",
      text: "x".repeat(500),
      at: "2030-01-01T00:00:00.000Z",
    });

    const sessions = await listSessions();
    assert.equal(sessions[0].id, "call-new");
    assert.equal(sessions[1].id, "call-old");
    assert.ok(sessions[0].turns[0].text.length < 500, "preview must be trimmed");
    assert.match(sessions[0].turns[0].text, /…$/);
  });

  it("caps the list at 50 sessions", async () => {
    for (let i = 0; i < 55; i++) {
      const at = `2024-01-01T00:${String(i).padStart(2, "0")}:00.000Z`;
      await appendTurn(`c-${i}`, { role: "user", text: `turn ${i}`, at });
    }
    assert.equal((await listSessions()).length, 50);
  });

  it("a corrupt session file is skipped, not a crash", async () => {
    await appendTurn("good", { role: "user", text: "fine", at: "t0" });
    writeFileSync(join(dir, "bad.json"), "{ not json");

    const sessions = await listSessions();
    assert.ok(sessions.some((s) => s.id === "good"));
    assert.ok(!sessions.some((s) => s.id === "bad"));
    assert.equal(await readSession("bad"), null);
  });
});

describe("call-log — storage never throws into the live call path", () => {
  it("appendTurn against an uncreatable dir resolves instead of throwing", async () => {
    // A FILE sits where the target directory needs to be created — mkdir must
    // fail, and appendTurn must swallow it.
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    process.env.STARRA_CALL_LOG_DIR = join(blocker, "calls");
    await assert.doesNotReject(appendTurn("call-x", { role: "user", text: "hi", at: "t0" }));
  });

  it("listSessions against a nonexistent dir returns [] instead of throwing", async () => {
    process.env.STARRA_CALL_LOG_DIR = join(dir, "does", "not", "exist");
    const sessions = await listSessions();
    assert.deepEqual(sessions, []);
  });

  it("readSession against a nonexistent dir returns null instead of throwing", async () => {
    process.env.STARRA_CALL_LOG_DIR = join(dir, "also", "missing");
    assert.equal(await readSession("anything"), null);
  });
});

describe("call-log — dir resolution without an env override (drive-missing fallback)", () => {
  it("an unset STARRA_CALL_LOG_DIR still lands the turn somewhere real, never silently drops it", async () => {
    delete process.env.STARRA_CALL_LOG_DIR;
    const id = `resolve-probe-${Date.now()}`;
    await appendTurn(id, { role: "user", text: "probe", at: "t0" });

    const viaVolume = join("/Volumes/Storage/STARRA/calls", `${id}.json`);
    const viaCwd = join(process.cwd(), "data", "calls", `${id}.json`);
    const wroteToVolume = existsSync(viaVolume);
    const wroteToCwd = existsSync(viaCwd);
    assert.ok(
      wroteToVolume || wroteToCwd,
      "an unplugged/missing drive must fall back to data/calls, never throw or vanish",
    );
    if (wroteToVolume) rmSync(viaVolume, { force: true });
    if (wroteToCwd) rmSync(viaCwd, { force: true });
  });
});
