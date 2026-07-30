/**
 * Engine options surface — structural invariants an adversarial reviewer should
 * be able to check in seconds, enforced as tests instead of trusted to comments.
 *
 * These are SOURCE scans, not behaviour tests, on purpose: the rules they guard
 * ("no reveal endpoint exists", "the client component cannot reach a module that
 * reads process.env", "the key input is never bound to a value") are properties
 * of the code's shape, and a behaviour test cannot prove the absence of a path.
 *
 * No network call, no engine import, no server start.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const ENGINE_API = path.join(REPO, "src", "app", "api", "engine");
const PANEL = path.join(REPO, "src", "components", "bridge", "OptionsPanel.tsx");
const OPTIONS_CSS = path.join(REPO, "src", "styles", "options.css");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const apiFiles = walk(ENGINE_API);
const routeFiles = apiFiles.filter((f) => f.endsWith(path.sep + "route.ts"));
const read = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => path.relative(REPO, f);

/**
 * Absence scans must look at CODE, not prose: these files document the rules
 * they follow, so an unstripped scan for "process.env" matches the comment that
 * explains why process.env is never touched. Strips block comments and line
 * comments (the `[^:]` guard keeps `https://` intact) with no regex lookbehind.
 */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/([^:])\/\/[^\n]*/g, "$1")
    .replace(/^\/\/[^\n]*/gm, "");
}

describe("route surface", () => {
  it("exposes exactly the six documented endpoints and no more", () => {
    const endpoints = routeFiles
      .map((f) => path.relative(ENGINE_API, path.dirname(f)))
      .sort();
    assert.deepEqual(endpoints, ["cosmetics", "providers", "status", "test"]);

    const verbs = routeFiles.flatMap((f) => {
      const src = read(f);
      const dir = path.relative(ENGINE_API, path.dirname(f));
      return ["GET", "POST", "PUT", "PATCH", "DELETE"]
        .filter((v) => new RegExp(`export async function ${v}\\b`).test(src))
        .map((v) => `${v} ${dir}`);
    });
    assert.deepEqual(verbs.sort(), [
      "GET cosmetics",
      "GET providers",
      "GET status",
      "POST cosmetics",
      "POST providers",
      "POST test",
    ]);
  });

  it("has NO reveal / export / unmask endpoint anywhere in the tree", () => {
    for (const f of apiFiles) {
      const name = path.basename(path.dirname(f)).toLowerCase();
      assert.ok(
        !/reveal|unmask|plaintext|export-keys|dump/.test(name),
        `suspicious endpoint directory: ${rel(f)}`,
      );
    }
    for (const f of apiFiles) {
      assert.ok(
        !/\breveal\b|\bunmask\b/i.test(code(f)),
        `${rel(f)} mentions reveal/unmask — there must be no read-back path`,
      );
    }
  });

  it("pins every route to the node runtime and disables caching of settings", () => {
    for (const f of routeFiles) {
      const src = read(f);
      assert.match(src, /export const runtime = "nodejs";/, `${rel(f)} missing node runtime`);
      assert.match(src, /export const dynamic = "force-dynamic";/, `${rel(f)} is cacheable`);
    }
  });

  it("never reads process.env directly — secret resolution belongs to the engine", () => {
    for (const f of apiFiles) {
      assert.ok(!/process\.env/.test(code(f)), `${rel(f)} touches process.env`);
    }
  });

  it("never references the PAID Replicate token", () => {
    for (const f of [...apiFiles, PANEL, OPTIONS_CSS]) {
      assert.ok(
        !/REPLICATE_API_TOKEN/.test(read(f)),
        `${rel(f)} references REPLICATE_API_TOKEN`,
      );
    }
  });

  it("routes every response body through the _shared projection helpers", () => {
    // A route that hand-rolls Response.json over engine output could leak a
    // field the projection would have stripped.
    for (const f of routeFiles) {
      const src = read(f);
      assert.ok(!/Response\.json\(/.test(src), `${rel(f)} bypasses the json() helper`);
      assert.match(src, /from "\.\.\/_shared"/, `${rel(f)} does not use _shared`);
    }
  });

  it("gates enabling a paid provider behind an explicit confirm on the server", () => {
    const src = read(path.join(ENGINE_API, "providers", "route.ts"));
    assert.match(src, /current\.paid && enabled === true && confirmPaid !== true/);
    assert.match(src, /409/, "the paid refusal must be a distinct status");
  });
});

describe("client bundle safety — proven by the import graph", () => {
  const panelSrc = read(PANEL);

  it("OptionsPanel imports ONLY react and its own stylesheet", () => {
    const specifiers: string[] = [];
    // Two forms: `import x from "y"` and bare `import "y"`.
    const re = /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm;
    let m: RegExpExecArray | null = re.exec(panelSrc);
    while (m) {
      specifiers.push(m[1]);
      m = re.exec(panelSrc);
    }
    assert.deepEqual(
      specifiers.sort(),
      ["@/styles/options.css", "react"],
      "the panel reached a module outside its own surface — anything a client component imports is public",
    );
  });

  it("the panel cannot reach any module that resolves secrets", () => {
    const panelCode = code(PANEL);
    for (const forbidden of [
      "@/lib/engine",
      "@/lib/keys",
      "@/lib/security/redact",
      "_shared",
      "process.env",
      "NEXT_PUBLIC_",
    ]) {
      assert.ok(
        !panelCode.includes(forbidden),
        `OptionsPanel references ${forbidden}`,
      );
    }
  });

  it("the key input is a password field that is never bound to a value", () => {
    const start = panelSrc.indexOf('className="opt-input"');
    assert.ok(start > 0, "opt-input not found");
    // The input JSX element containing opt-input, up to its self-closing tag.
    const open = panelSrc.lastIndexOf("<input", start);
    const close = panelSrc.indexOf("/>", start);
    assert.ok(open > 0 && close > open, "could not bound the input element");
    const el = panelSrc.slice(open, close);

    assert.match(el, /type="password"/);
    assert.match(el, /autoComplete="new-password"/);
    assert.match(el, /spellCheck=\{false\}/);
    assert.ok(!/\bvalue=/.test(el), "the key input is bound to a value — it must be uncontrolled");
    assert.match(el, /placeholder=/, "a masked hint must come from the placeholder only");
  });

  it("shows at most the last four characters of a stored key", () => {
    // Every rendering of stored key material in the panel is a bullet mask.
    const mentions = panelSrc.match(/last4/g) ?? [];
    assert.ok(mentions.length > 0);
    for (const line of panelSrc.split("\n")) {
      if (!line.includes("last4")) continue;
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
      if (/last4:|last4\?:/.test(line)) continue; // type declaration / projection
      assert.ok(
        line.includes("••••") || line.includes("last4 ?? "),
        `last4 rendered without a mask: ${line.trim()}`,
      );
    }
  });
});

describe("macOS 12 / WKWebView compatibility", () => {
  const clientFiles = [PANEL, OPTIONS_CSS];

  it("uses no regex lookbehind in client code", () => {
    const lookbehind = "(?" + "<";
    for (const f of [...apiFiles, ...clientFiles]) {
      assert.ok(!code(f).includes(lookbehind), `${rel(f)} uses regex lookbehind`);
    }
  });

  it("avoids APIs that Safari 15.6 does not ship", () => {
    const src = code(PANEL);
    for (const api of ["AbortSignal.timeout", "structuredClone", "Array.fromAsync", "requestIdleCallback"]) {
      assert.ok(!src.includes(api), `OptionsPanel uses ${api}, unsupported on macOS 12`);
    }
  });
});

describe("design doctrine", () => {
  const panelSrc = read(PANEL);
  const cssSrc = read(OPTIONS_CSS);

  it("carries no emoji in UI copy", () => {
    // Surrogate-pair range covers the pictographic planes without needing the
    // /u flag's property escapes.
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    assert.ok(!emoji.test(panelSrc), "emoji found in OptionsPanel copy");
    assert.ok(!emoji.test(cssSrc), "emoji found in options.css");
  });

  it("does not edit or import deck.css", () => {
    assert.ok(!code(PANEL).includes("deck.css"), "the panel must not import deck.css");
    assert.match(panelSrc, /@\/styles\/options\.css/);
  });

  it("colors come from the STARRA token set, never raw hex or added greys", () => {
    // Only the void backdrop rgba() shadows are allowed as literals; no hex.
    const hex = cssSrc.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    const inComment = (h: string) => {
      // #a855f7 etc. appear only inside the measured-palette comments.
      const idx = cssSrc.indexOf(h);
      const before = cssSrc.slice(0, idx);
      return before.lastIndexOf("/*") > before.lastIndexOf("*/");
    };
    const offenders = hex.filter((h) => !inComment(h));
    assert.deepEqual(offenders, [], `raw hex colors in options.css: ${offenders.join(", ")}`);
  });

  it("honours reduced motion through both the OS query and the in-panel toggle", () => {
    assert.match(cssSrc, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(cssSrc, /\[data-reduce-motion="1"\]/);
  });

  it("keeps the edge tab below the voice call overlay so a live call is never covered", () => {
    const tabStart = cssSrc.indexOf(".opt-tab {");
    const tab = cssSrc.slice(tabStart, cssSrc.indexOf("}", tabStart));
    const z = /z-index:\s*(\d+)/.exec(tab);
    assert.ok(z, "the tab has no z-index");
    assert.ok(Number(z[1]) < 60, `tab z-index ${z?.[1]} is not below the call overlay's 60`);
  });
});

describe("runtime config store hygiene", () => {
  it("data/engine.json is gitignored", () => {
    const ignore = readFileSync(path.join(REPO, ".gitignore"), "utf8");
    const lines = ignore.split("\n").map((l) => l.trim());
    assert.ok(
      lines.includes("/data/*.json") || lines.includes("data/engine.json") || lines.includes("/data/engine.json"),
      "nothing in .gitignore covers data/engine.json",
    );
  });

  it("no route writes .env.local or any file — persistence goes through the engine", () => {
    for (const f of apiFiles) {
      const src = code(f); // prose may DISCUSS .env.local; code must not touch it
      // `\b` keeps this off legitimate identifiers like `p.envKeys`.
      assert.ok(!/\.env\b/.test(src), `${rel(f)} references an env file in code`);
      assert.ok(!/writeFile|appendFile|createWriteStream/.test(src), `${rel(f)} writes to disk directly`);
      assert.ok(!/from "(node:)?fs"/.test(src), `${rel(f)} imports fs`);
    }
  });
});
