/**
 * CREDENTIAL UNIFICATION — /app/settings must keep working.
 *
 * src/lib/keys.ts is reachable from the CLIENT import graph via
 * src/app/settings/page.tsx:5 ("use client"). The engine's secret-bearing
 * modules (providers/config/router/health/index) throw at MODULE SCOPE in a
 * browser (assertServerOnly, src/lib/engine/providers.ts:22-31). So keys.ts may
 * NEVER statically import one — it must reach the engine through a dynamic
 * import behind `typeof window === "undefined"`, which Next replaces with a
 * constant in the client build and dead-code-eliminates.
 *
 * These are structural + runtime assertions. If someone converts that dynamic
 * import into a static one, /app/settings dies in the browser and this fails.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "src", "lib");
const KEYS_SRC = readFileSync(path.join(ROOT, "keys.ts"), "utf8");
const REDACT_SRC = readFileSync(path.join(ROOT, "engine", "redact.ts"), "utf8");

/** Static import specifiers only — `import ... from "x"` and bare `import "x"`. */
function staticImports(src: string): string[] {
  const out: string[] = [];
  const re = /^\s*import\s+(?![^"';]*\btype\b\s)(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm;
  let m: RegExpExecArray | null = re.exec(src);
  while (m) {
    out.push(m[1]);
    m = re.exec(src);
  }
  return out;
}

const SERVER_ONLY_ENGINE_MODULES = ["providers", "config", "router", "health", "index"];

describe("keys.ts stays importable from the client graph", () => {
  it("has NO value-level static import of a server-only engine module", () => {
    for (const spec of staticImports(KEYS_SRC)) {
      for (const mod of SERVER_ONLY_ENGINE_MODULES) {
        assert.ok(
          !(spec.endsWith(`/engine/${mod}`) || spec === `./engine/${mod}` || spec === "@/lib/engine"),
          `keys.ts statically imports the server-only engine module "${spec}" — this kills /app/settings in the browser`,
        );
      }
    }
  });

  it("reaches the engine only through a dynamic import guarded by typeof window", () => {
    assert.match(
      KEYS_SRC,
      /typeof window === "undefined"/,
      "the engine hop is not gated on typeof window — Next cannot strip it from the client bundle",
    );
    assert.match(
      KEYS_SRC,
      /import\("\.\/engine\/config"\)/,
      "expected a dynamic import of ./engine/config as the single engine hop",
    );
  });

  it("the one engine module keys.ts may import statically (redact) is genuinely pure", () => {
    assert.deepEqual(staticImports(REDACT_SRC), [], "engine/redact.ts grew an import — it must stay pure");
    for (const forbidden of ["assertServerOnly", "process.env", 'from "fs"', 'from "node:fs"']) {
      assert.ok(!REDACT_SRC.includes(forbidden), `engine/redact.ts references ${forbidden} — no longer client-safe`);
    }
  });
});

describe("keys.ts in a browser-like environment", () => {
  it("loads and resolves without throwing, and never consults the engine", async () => {
    const g = globalThis as unknown as { window?: unknown };
    const had = "window" in g;
    g.window = { document: {} };
    try {
      // Fresh module instance, evaluated with `window` already defined. A static
      // engine import would throw right here.
      const mod = await import(`../src/lib/keys.ts?browser=${Date.now()}`);
      const keysFile = path.join(process.cwd(), "data", "__unify_browser_probe_keys.json");
      const engineFile = path.join(process.cwd(), "data", "__unify_browser_probe_engine.json");
      const fs = await import("node:fs/promises");
      await fs.mkdir(path.dirname(keysFile), { recursive: true });
      await fs.writeFile(keysFile, JSON.stringify({ xai: "xai-VaultOnlyValue000000000000" }), "utf8");
      await fs.writeFile(
        engineFile,
        JSON.stringify({ providers: { xai: { keyOverride: "xai-EngineOnlyValue00000000000" } } }),
        "utf8",
      );
      const savedKeys = process.env.STARRA_KEYS_PATH;
      const savedEngine = process.env.STARRA_ENGINE_CONFIG_PATH;
      process.env.STARRA_KEYS_PATH = keysFile;
      process.env.STARRA_ENGINE_CONFIG_PATH = engineFile;
      try {
        // In a browser the engine hop is skipped entirely: the vault value wins.
        assert.equal(await mod.getKey("xai"), "xai-VaultOnlyValue000000000000");
        assert.equal(typeof mod.mask("xai-abcdefghijklmnop1234"), "string");
      } finally {
        if (savedKeys === undefined) delete process.env.STARRA_KEYS_PATH;
        else process.env.STARRA_KEYS_PATH = savedKeys;
        if (savedEngine === undefined) delete process.env.STARRA_ENGINE_CONFIG_PATH;
        else process.env.STARRA_ENGINE_CONFIG_PATH = savedEngine;
        await fs.rm(keysFile, { force: true });
        await fs.rm(engineFile, { force: true });
      }
    } finally {
      if (!had) delete g.window;
    }
  });
});
