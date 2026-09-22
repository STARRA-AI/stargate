/**
 * THE OPERATOR CONSOLE: typing cost, and the file drop box.
 *
 * WHAT THIS PROTECTS. Classic's report, 2026-09-22: "the chat box is still very
 * slow to type in and it's lagging." The measured dominant cause was macOS
 * speech recognition at ~128% CPU with next-server at 0.0% — but the console
 * also made every keystroke pay for a React render of the console head, 14
 * `.wave-bar` spans with fresh inline style objects, and the whole chip row,
 * because the draft text lived in DeckConsole's `useState` and was passed to
 * Composer as a controlled `value`.
 *
 * The fix is structural and INVISIBLE to every other test: making the textarea
 * controlled again would not fail a single assertion elsewhere, and the suite
 * would stay green while typing got slow again. Hence source-text pins, the same
 * technique as tests/call-presence-layer.test.ts and tests/deck-design-system.test.ts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  BINARY_EXT,
  MAX_DROP_BYTES,
  checkDroppedFile,
  extOf,
  fmtBytes,
  ingestedLabel,
  uploadFailure,
} from "../src/lib/vault/drop";

const REPO = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

const composer = read("src/components/bridge/Composer.tsx");
const deckConsole = read("src/components/bridge/DeckConsole.tsx");
const consoleDrop = read("src/components/bridge/ConsoleDrop.tsx");
const uploadRoute = read("src/app/api/vault/upload/route.ts");
const deckCss = read("src/styles/deck.css");

describe("typing costs no React render outside the composer", () => {
  it("the textarea is uncontrolled — defaultValue, and no value={ } binding", () => {
    assert.match(
      composer,
      /<textarea[\s\S]*?defaultValue=""/,
      "the composer textarea must be uncontrolled; a controlled value={} re-renders on every keystroke",
    );
    // `value={` anywhere in the textarea element is the regression.
    const textarea = /<textarea[\s\S]*?\/>/.exec(composer)?.[0] ?? "";
    assert.ok(textarea.length > 0, "could not find the textarea element");
    assert.ok(
      !/\bvalue=\{/.test(textarea),
      "the textarea must not take a controlled `value={...}` prop",
    );
    assert.ok(
      !/\bonChange=/.test(textarea),
      "onChange re-renders per character; autosize runs on onInput instead",
    );
    assert.match(textarea, /onInput=\{autosize\}/, "autosize must run off onInput");
  });

  it("Composer takes onSubmit(text) and no value/onChange props at all", () => {
    assert.match(
      composer,
      /onSubmit:\s*\(text:\s*string\)\s*=>\s*void/,
      "Composer must hand the draft up as an argument, not read it from a prop",
    );
    assert.ok(
      !/^\s*value:\s*string;/m.test(composer),
      "a `value: string` prop means the draft moved back out of the DOM",
    );
    assert.ok(
      !/onChange:\s*\(/.test(composer),
      "an onChange prop means the parent is being re-rendered per keystroke again",
    );
  });

  it("DeckConsole holds no draft state and passes no value to Composer", () => {
    assert.ok(
      !/const \[input, setInput\] = useState/.test(deckConsole),
      "the draft must not live in DeckConsole — that is the regression being pinned",
    );
    const composerTag = /<Composer[\s\S]*?\/>/.exec(deckConsole)?.[0] ?? "";
    assert.ok(composerTag.length > 0, "DeckConsole must still render <Composer />");
    assert.ok(
      !/value=\{/.test(composerTag),
      "DeckConsole must not pass a controlled value into Composer",
    );
    assert.match(composerTag, /onSubmit=\{submit\}/);
  });

  it("the autosize measurement is coalesced to one per frame and guarded", () => {
    assert.match(composer, /requestAnimationFrame/, "the layout read must be deferred to a frame");
    assert.match(
      composer,
      /if \(rafRef\.current !== null\) return;/,
      "without the early return, every keystroke queues its own measurement",
    );
    assert.match(
      composer,
      /if \(next === lastHeight\.current\)/,
      "the style write must be skipped when the height did not change",
    );
    assert.match(
      composer,
      /cancelAnimationFrame/,
      "a pending frame must be cancelled on unmount",
    );
  });

  it("the head bars and chip row are memoized against the per-token re-render", () => {
    // `streaming` updates on every SSE token, re-rendering DeckConsole many
    // times a second. These two were rebuilt on each of those renders.
    assert.match(deckConsole, /const waveBars = useMemo\(/);
    assert.match(deckConsole, /\[waveLive\],/, "the bars must depend only on waveLive");
    assert.match(deckConsole, /const chipRow = useMemo\(/);
    assert.match(
      deckConsole,
      /const submit = useCallback\(/,
      "an unstable submit would defeat the chip row's memo",
    );
  });
});

describe("the drop box reuses the vault, it does not add a second ingest path", () => {
  it("posts to the existing /api/vault/upload route", () => {
    assert.match(consoleDrop, /fetch\("\/api\/vault\/upload", \{ method: "POST"/);
    assert.match(uploadRoute, /export async function POST/, "that route must still accept a POST");
    assert.match(uploadRoute, /form\.get\("file"\)/, "the field name must stay `file`");
    assert.match(consoleDrop, /fd\.append\("file", file\)/);
  });

  it("the client cap equals the route's cap — a drift makes an HTTP 413 the only warning", () => {
    const routeCap = /MAX_UPLOAD_BYTES = (\d+) \* 1024 \* 1024/.exec(uploadRoute);
    assert.ok(routeCap, "could not read MAX_UPLOAD_BYTES from the upload route");
    assert.equal(MAX_DROP_BYTES, Number(routeCap[1]) * 1024 * 1024);
  });

  it("uploads run one at a time — the route rewrites the whole vault store per call", () => {
    assert.ok(
      !/Promise\.all\([\s\S]{0,120}ingest/.test(consoleDrop),
      "concurrent ingests race saveVault()",
    );
    assert.match(consoleDrop, /for \(let i = 0; i < files\.length; i\+\+\)/);
  });

  it("dragleave is depth-counted, so the highlight does not flicker over children", () => {
    assert.match(consoleDrop, /depth\.current \+= 1/);
    assert.match(consoleDrop, /depth\.current -= 1/);
    assert.match(consoleDrop, /if \(depth\.current <= 0\)/);
  });

  it("dragover preventDefault is present — without it the browser opens the file", () => {
    const over = /onDragOver=\{\(e\) => \{[\s\S]*?\}\}/.exec(consoleDrop)?.[0] ?? "";
    assert.match(over, /e\.preventDefault\(\)/);
  });

  it("its state is local, so an upload never re-renders the console", () => {
    assert.match(consoleDrop, /const \[rows, setRows\] = useState<Row\[\]>/);
    assert.ok(
      !/rows|setRows|armed/.test(deckConsole),
      "drop state must not be lifted into DeckConsole",
    );
    assert.match(deckConsole, /<ConsoleDrop \/>/, "rendered with no props — nothing to re-render for");
  });

  it("the drop box has deck styling, including the armed state", () => {
    assert.match(deckCss, /\.drop-zone \{/);
    assert.match(deckCss, /\.drop-zone\.armed \{/);
    assert.match(deckCss, /\.drop-row\.fail \.drop-detail \{ color: var\(--bad\); \}/);
    assert.match(deckCss, /\.drop-row\.done \.drop-detail \{ color: var\(--good\); \}/);
  });
});

describe("the upload route accepts a real multipart body", () => {
  // ★ THE BUG THIS PINS. The route opened with
  //     const contentLength = header !== null ? Number(header) : NaN;
  //     if (!Number.isFinite(contentLength) || contentLength > MAX) -> 413
  // A FormData Request carries NO content-length (undici sets it at dispatch,
  // not on the object), so the absent header became NaN and every such call
  // returned "file too large" for a 300-byte file. MEASURED 2026-09-22 by
  // calling POST directly: 413 before, 200 after.
  it("does not 413 when content-length is absent", () => {
    assert.ok(
      !/!Number\.isFinite\(contentLength\)/.test(uploadRoute),
      "a missing content-length must not be treated as oversized",
    );
    assert.match(
      uploadRoute,
      /if \(Number\.isFinite\(declared\) && declared > MAX_UPLOAD_BYTES\)/,
      "the header check must only fire when the header is present AND over the cap",
    );
  });

  it("keeps file.size as the authoritative cap after the parse", () => {
    assert.match(
      uploadRoute,
      /if \(file\.size > MAX_UPLOAD_BYTES\)[\s\S]{0,120}status: 413/,
      "the post-parse size check is the one that cannot be lied about",
    );
  });

  it("a FormData Request really carries no content-length — the premise of the fix", () => {
    const fd = new FormData();
    fd.append("file", new File(["hello"], "a.md", { type: "text/markdown" }));
    const req = new Request("http://x/y", { method: "POST", body: fd });
    assert.equal(req.headers.get("content-length"), null);
    // and this is why the old expression rejected it
    assert.equal(Number.isFinite(NaN), false);
    // while the new one lets it through
    assert.equal(Number.isFinite(Number(req.headers.get("content-length"))), true);
  });
});

describe("checkDroppedFile — what she can actually read", () => {
  const ok = (name: string, size = 2048) => checkDroppedFile({ name, size });

  it("accepts the formats ingestTextFile really handles", () => {
    for (const n of ["notes.md", "brief.txt", "leads.csv", "contract.pdf"]) {
      assert.deepEqual(ok(n), { ok: true }, n);
    }
  });

  it("accepts code and config, which have no text/* mime but are plain text", () => {
    // ingestTextFile's `else` branch is buffer.toString("utf8") — correct for these.
    for (const n of ["route.ts", "package.json", "docker-compose.yml", "starra-up.log", "run.sh"]) {
      assert.deepEqual(ok(n), { ok: true }, n);
    }
  });

  it("accepts .docx/.xlsx now that office.ts really reads them", () => {
    assert.deepEqual(ok("deal.docx"), { ok: true });
    assert.deepEqual(ok("model.xlsx"), { ok: true });
  });

  it("still refuses the office formats nothing parses", () => {
    // .pptx is a zip on a schema office.ts does not read; .doc/.xls are OLE
    // compound files, not zips at all; the Apple formats are bundles.
    for (const n of ["deck.pptx", "old.doc", "old.xls", "notes.pages", "sheet.numbers"]) {
      const v = ok(n);
      assert.equal(v.ok, false, n);
      assert.match((v as { why: string }).why, /isn't text/);
      assert.match((v as { why: string }).why, /PDF, DOCX, XLSX, TXT, MD or CSV/);
    }
  });

  it("refuses images, media, archives and model blobs", () => {
    for (const n of ["her.png", "loop.mp4", "voice.wav", "bundle.zip", "model.safetensors"]) {
      assert.equal(ok(n).ok, false, n);
    }
  });

  it("refuses an empty file and one over the cap, with the size said out loud", () => {
    assert.deepEqual(ok("empty.txt", 0), { ok: false, why: "empty file — nothing to read." });
    const big = ok("huge.txt", MAX_DROP_BYTES + 1);
    assert.equal(big.ok, false);
    assert.match((big as { why: string }).why, /20\.0 MB cap/);
  });

  it("an extensionless file is allowed through as text", () => {
    assert.deepEqual(ok("Makefile"), { ok: true });
    assert.equal(extOf("Makefile"), "");
    assert.equal(extOf("a.b.TXT"), "txt");
    assert.equal(extOf("trailing."), "", "a trailing dot is not an extension");
    assert.equal(extOf(".gitignore"), "", "a dotfile's name is not its extension");
  });

  it("every BINARY_EXT entry is lowercase and bare — extOf never returns a dot", () => {
    for (const e of BINARY_EXT) {
      assert.equal(e, e.toLowerCase(), e);
      assert.ok(!e.startsWith("."), e);
    }
  });

  it("the extension check is case-insensitive", () => {
    assert.equal(ok("PHOTO.PNG").ok, false);
    assert.equal(ok("Deck.PPTX").ok, false);
    assert.equal(ok("Deal.DocX").ok, true, "docx is readable now, in any casing");
  });
});

describe("what the console says back", () => {
  it("fmtBytes stays short enough for one row", () => {
    assert.equal(fmtBytes(0), "0 B");
    assert.equal(fmtBytes(1023), "1023 B");
    assert.equal(fmtBytes(1024), "1.0 KB");
    assert.equal(fmtBytes(18841), "18.4 KB");
    assert.equal(fmtBytes(20 * 1024 * 1024), "20.0 MB");
  });

  it("ingestedLabel reports zero facts as a real outcome, never as success", () => {
    assert.match(ingestedLabel({ facts: [], text: "" }), /nothing readable/);
    assert.match(ingestedLabel({ facts: [], text: "x".repeat(4200) }), /no discrete facts/);
    assert.match(ingestedLabel({ facts: [], text: "x".repeat(4200) }), /4,200 chars/);
    const one = ingestedLabel({ facts: ["a"], text: "abc" });
    assert.match(one, /^1 fact · 3 chars/, "singular, not '1 facts'");
    assert.match(one, /She can read it now/);
    assert.match(ingestedLabel({ facts: ["a", "b"], text: "abc" }), /^2 facts/);
  });

  it("uploadFailure never leaks a bare status code without a sentence", () => {
    assert.match(uploadFailure(413, null), /too large/);
    assert.match(uploadFailure(400, { error: "malformed upload" }), /malformed upload\./);
    assert.match(uploadFailure(401, null), /sign back in/);
    assert.match(uploadFailure(403, null), /sign back in/);
    assert.match(uploadFailure(500, null), /HTTP 500/);
    assert.match(uploadFailure(500, { error: "disk full" }), /disk full \(HTTP 500\)/);
    // a non-object body must not throw
    assert.match(uploadFailure(502, "nope"), /HTTP 502/);
  });
});
