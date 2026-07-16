/**
 * Obsidian vault — path safety + gated note ops (Layer 1 + Layer 2 gates).
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  clearVaultPending,
  parseWikilinks,
  resolveSafeNotePath,
  resolveWikilink,
  scaffoldVault,
  writeNote,
  readNote,
  deleteNote,
  searchNotes,
} from "../src/lib/obsidian";

describe("obsidian path safety", () => {
  it("rejects traversal and absolute paths", () => {
    const root = "/tmp/fake-vault";
    assert.equal(resolveSafeNotePath(root, "../etc/passwd").ok, false);
    assert.equal(resolveSafeNotePath(root, "/etc/passwd").ok, false);
    assert.equal(resolveSafeNotePath(root, "foo/../../bar").ok, false);
  });

  it("resolves vault-relative markdown paths", () => {
    const root = "/tmp/fake-vault";
    const ok = resolveSafeNotePath(root, "0-Inbox/Note");
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.rel, "0-Inbox/Note.md");
      assert.ok(ok.abs.endsWith("0-Inbox/Note.md"));
    }
  });

  it("parses wikilinks", () => {
    const links = parseWikilinks("See [[Inbox]] and [[Credit#Disputes|disputes]].");
    assert.deepEqual(links, ["Inbox", "Credit"]);
  });
});

describe("obsidian note ops", () => {
  let vaultRoot = "";

  before(async () => {
    vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stargate-vault-"));
    clearVaultPending();
  });

  after(async () => {
    clearVaultPending();
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  it("scaffolds PARA folders", async () => {
    const result = await scaffoldVault(vaultRoot);
    assert.equal(result.ok, true);
    const inbox = await fs.stat(path.join(vaultRoot, "0-Inbox"));
    assert.equal(inbox.isDirectory(), true);
  });

  it("creates and reads a note", async () => {
    const created = await writeNote({
      vaultRoot,
      relativePath: "1-Projects/Test.md",
      content: "# Test\n\nLink [[Inbox]].\n",
      mode: "create",
    });
    assert.equal(created.ok, true);
    const read = await readNote("1-Projects/Test.md", vaultRoot);
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.match(read.note.content, /\[\[Inbox\]\]/);
    }
  });

  it("holds overwrite without confirm token", async () => {
    const held = await writeNote({
      vaultRoot,
      relativePath: "1-Projects/Test.md",
      content: "# Overwritten\n",
      mode: "overwrite",
    });
    assert.equal(held.ok, false);
    if (!held.ok) {
      assert.equal(held.held, true);
      assert.ok(held.token);
      const confirmed = await writeNote({
        vaultRoot,
        relativePath: "1-Projects/Test.md",
        content: "# Overwritten\n",
        mode: "overwrite",
        confirmToken: held.token,
      });
      assert.equal(confirmed.ok, true);
    }
  });

  it("appends without gate", async () => {
    const result = await writeNote({
      vaultRoot,
      relativePath: "1-Projects/Test.md",
      content: "\n## Appended\n",
      mode: "append",
    });
    assert.equal(result.ok, true);
    const read = await readNote("1-Projects/Test.md", vaultRoot);
    assert.equal(read.ok, true);
    if (read.ok) assert.match(read.note.content, /Appended/);
  });

  it("searches and resolves wikilinks", async () => {
    const hits = await searchNotes("Overwritten", vaultRoot);
    assert.ok(hits.length >= 1);
    const resolved = await resolveWikilink("Inbox", vaultRoot);
    assert.equal(resolved.ok, true);
    if (resolved.ok) assert.match(resolved.rel, /Inbox\.md$/);
  });

  it("holds delete until confirmed", async () => {
    const held = await deleteNote({
      vaultRoot,
      relativePath: "1-Projects/Test.md",
    });
    assert.equal(held.ok, false);
    if (!held.ok) {
      assert.ok(held.token);
      const done = await deleteNote({
        vaultRoot,
        relativePath: "1-Projects/Test.md",
        confirmToken: held.token,
      });
      assert.equal(done.ok, true);
    }
  });
});
