/**
 * DURABLE-FACT MEMORY (mem0-style, in-house, $0) — the contracts:
 * merge is pure/deduped/capped, parse is tolerant, the prompt block LEADS
 * with facts, and extraction is strictly fire-and-forget from the reply path.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { mergeFacts, memoryForPrompt, FACTS_CAP } from "../src/lib/memory/store";
import { parseFacts, EXTRACT_MIN_CHARS } from "../src/lib/memory/extract";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

describe("mergeFacts — pure, deduped, capped", () => {
  it("adds fresh facts and dedupes substrings in either direction", () => {
    const now = "t1";
    const start = [{ text: "Classic filed the DUNS application", at: "t0" }];
    const merged = mergeFacts(
      start,
      ["filed the DUNS", "Groq is the free daily driver"],
      now,
    );
    assert.equal(merged.length, 2);
    assert.equal(merged[0].text, "Classic filed the DUNS application");
  });

  it("a longer phrasing of a known fact wins and refreshes", () => {
    const merged = mergeFacts(
      [{ text: "filed the DUNS", at: "t0" }],
      ["Classic filed the DUNS application on Tuesday"],
      "t1",
    );
    assert.equal(merged.length, 1);
    assert.match(merged[0].text, /on Tuesday/);
    assert.equal(merged[0].at, "t1");
  });

  it("caps at FACTS_CAP dropping oldest, ignores junk", () => {
    const many = Array.from({ length: FACTS_CAP + 10 }, (_, i) => `distinct durable fact number ${i} about thing-${i}`);
    const merged = mergeFacts([], many, "t");
    assert.equal(merged.length, FACTS_CAP);
    assert.match(merged[0].text, /number 10 /);
    assert.deepEqual(mergeFacts([], ["", "  ", "short", 42 as unknown as string], "t"), []);
  });
});

describe("parseFacts — tolerant", () => {
  it("accepts arrays, arrays in prose, junk → []", () => {
    assert.deepEqual(parseFacts('["a fact worth keeping"]'), ["a fact worth keeping"]);
    assert.deepEqual(parseFacts('Here: ["one", "two"] done'), ["one", "two"]);
    assert.deepEqual(parseFacts("no json"), []);
    assert.deepEqual(parseFacts('{"not":"array"}'), []);
  });

  it("takes at most 3", () => {
    assert.equal(parseFacts('["a","b","c","d","e"]').length, 3);
  });
});

describe("facts lead her memory on every surface", () => {
  it("memoryForPrompt puts Facts first, newest-first", () => {
    const block = memoryForPrompt(
      {
        working: [],
        summaries: [],
        archival: [],
        facts: [
          { text: "OLD-FACT", at: "t0" },
          { text: "NEW-FACT", at: "t1" },
        ],
      },
      "",
    );
    assert.ok(block.indexOf("Facts") < block.indexOf("Working"));
    assert.ok(block.indexOf("NEW-FACT") < block.indexOf("OLD-FACT"));
  });
});

describe("extraction discipline, on the source", () => {
  it("the chat route fires it fire-and-forget (void, never awaited)", () => {
    const src = read("src/app/api/chat/route.ts");
    assert.match(src, /void extractFactsFromExchange\(/);
    assert.ok(!/await extractFactsFromExchange/.test(src));
  });

  it("skips trivial exchanges and swallows every failure", () => {
    const src = read("src/lib/memory/extract.ts");
    assert.match(src, /EXTRACT_MIN_CHARS/);
    assert.ok(EXTRACT_MIN_CHARS >= 100);
    assert.match(src, /return \[\]; \/\/ extraction is garnish/);
  });
});
