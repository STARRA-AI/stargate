/**
 * Private lane — `private …` command parser.
 *
 * The parser is the gate that decides whether a turn NEVER leaves this Mac.
 * A false negative leaks a private ask to a hosted provider, so the boundary
 * cases (`privateer`, bare `private`) are load-bearing, not cosmetic.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePrivateCommand } from "../src/lib/private/commands";

describe("parsePrivateCommand — chat", () => {
  it("strips a whitespace-separated `private` prefix", () => {
    assert.deepEqual(parsePrivateCommand("private what is the code?"), {
      kind: "chat",
      text: "what is the code?",
    });
  });

  it("strips a colon-separated `private:` prefix", () => {
    assert.deepEqual(parsePrivateCommand("private: what is the code?"), {
      kind: "chat",
      text: "what is the code?",
    });
    assert.deepEqual(parsePrivateCommand("private:what is the code?"), {
      kind: "chat",
      text: "what is the code?",
    });
  });

  it("is case-insensitive on the prefix only", () => {
    assert.deepEqual(parsePrivateCommand("PRIVATE Whats the plan"), {
      kind: "chat",
      text: "Whats the plan",
    });
    assert.deepEqual(parsePrivateCommand("PrIvAtE: Whats the plan"), {
      kind: "chat",
      text: "Whats the plan",
    });
  });

  it("tolerates leading/trailing whitespace around the whole ask", () => {
    assert.deepEqual(parsePrivateCommand("   private   hold this   "), {
      kind: "chat",
      text: "hold this",
    });
  });

  it("keeps multi-line asks intact", () => {
    assert.deepEqual(parsePrivateCommand("private summarize:\nline two"), {
      kind: "chat",
      text: "summarize:\nline two",
    });
  });
});

describe("parsePrivateCommand — non-matches", () => {
  it("does NOT match a word that merely starts with `private`", () => {
    assert.equal(parsePrivateCommand("privateer stories"), null);
    assert.equal(parsePrivateCommand("privately, I disagree"), null);
    assert.equal(parsePrivateCommand("private-gpt is running"), null);
  });

  it("does NOT match `private` mid-sentence", () => {
    assert.equal(parsePrivateCommand("keep this private please"), null);
  });

  it("returns null for a bare prefix with no ask", () => {
    assert.equal(parsePrivateCommand("private"), null);
    assert.equal(parsePrivateCommand("private "), null);
    assert.equal(parsePrivateCommand("private:"), null);
    assert.equal(parsePrivateCommand("private:   "), null);
  });

  it("returns null for empty / non-string input", () => {
    assert.equal(parsePrivateCommand(""), null);
    assert.equal(parsePrivateCommand("   "), null);
    assert.equal(
      parsePrivateCommand(undefined as unknown as string),
      null,
    );
    assert.equal(parsePrivateCommand(null as unknown as string), null);
  });
});

describe("parsePrivateCommand — docs", () => {
  it("matches `private docs` exactly", () => {
    assert.deepEqual(parsePrivateCommand("private docs"), { kind: "docs" });
    assert.deepEqual(parsePrivateCommand("private: docs"), { kind: "docs" });
    assert.deepEqual(parsePrivateCommand("  PRIVATE DOCS  "), {
      kind: "docs",
    });
  });

  it("treats `docs`-prefixed prose as a chat ask, not a listing", () => {
    assert.deepEqual(parsePrivateCommand("private documents"), {
      kind: "chat",
      text: "documents",
    });
    assert.deepEqual(parsePrivateCommand("private docs about taxes"), {
      kind: "chat",
      text: "docs about taxes",
    });
  });
});

describe("parsePrivateCommand — ingest", () => {
  it("takes an absolute path", () => {
    assert.deepEqual(
      parsePrivateCommand("private ingest /Users/work/notes/tax.txt"),
      { kind: "ingest", path: "/Users/work/notes/tax.txt" },
    );
  });

  it("takes a ~ path verbatim (expansion is the route's job, not the parser's)", () => {
    assert.deepEqual(parsePrivateCommand("private ingest ~/Desktop/a.md"), {
      kind: "ingest",
      path: "~/Desktop/a.md",
    });
  });

  it("is case-insensitive on the subcommand and accepts the colon form", () => {
    assert.deepEqual(parsePrivateCommand("private: INGEST /tmp/a.txt"), {
      kind: "ingest",
      path: "/tmp/a.txt",
    });
  });

  it("strips matched surrounding quotes so paths with spaces survive", () => {
    assert.deepEqual(
      parsePrivateCommand('private ingest "/Users/work/my notes.txt"'),
      { kind: "ingest", path: "/Users/work/my notes.txt" },
    );
    assert.deepEqual(
      parsePrivateCommand("private ingest '/Users/work/my notes.txt'"),
      { kind: "ingest", path: "/Users/work/my notes.txt" },
    );
  });

  it("falls back to a private chat ask when no path follows", () => {
    assert.deepEqual(parsePrivateCommand("private ingest"), {
      kind: "chat",
      text: "ingest",
    });
  });
});

describe("private lane parser — macOS 12 WebKit safety", () => {
  it("contains no regex lookbehind (client may import this module)", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../src/lib/private/commands.ts", import.meta.url),
      "utf8",
    );
    assert.equal(
      /\(\?<[=!]/.test(src),
      false,
      "lookbehind assertions crash Safari/WebKit on macOS 12",
    );
  });
});
