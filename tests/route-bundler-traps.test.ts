/**
 * BUNDLER TRAPS IN ROUTE HANDLERS.
 *
 * On 2026-08-08 the whole /tools page went down with:
 *   Module not found: Can't resolve './ROOT/scripts' <dynamic>
 * and it took SIX other tool routes with it (obsidian, multica, openmontage,
 * funding, openalice all 500'd as collateral).
 *
 * The cause was not the path. Turbopack STATICALLY TRACES the argument array of
 * any `spawn()` call whose binding it can see, and tries to resolve that string
 * as a module. Reproduced and measured that day: an absolute path from
 * process.cwd() fails as './ROOT/scripts'; a relative one fails as
 * ('scripts/' <dynamic>). Changing the path shape only changes the error text.
 *
 * The fix is to hide the BINDING via createRequire, so the bundler cannot tell
 * the function is child_process.spawn. That is subtle enough that the next
 * person will "clean it up" back into a static import and take the tools page
 * down again — so this test is the tripwire.
 *
 * NOTE this failure is DEV-ONLY. `next build` compiles it fine; the control
 * test that day passed the production build twice. Only an authenticated
 * request in dev reproduces it. A green build proves nothing here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = join(process.cwd(), "src/app/api");

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

describe("route handlers must not hand the bundler a traceable spawn", () => {
  it("no route statically imports child_process", () => {
    const offenders: string[] = [];
    for (const file of routeFiles(API_ROOT)) {
      const src = readFileSync(file, "utf8");
      // A static `import ... from "child_process"` gives Turbopack the binding
      // it needs to trace spawn's arguments as a module path.
      if (/^\s*import\s+[^;]*\bfrom\s+["'](?:node:)?child_process["']/m.test(src)) {
        offenders.push(file.replace(process.cwd() + "/", ""));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "These routes statically import child_process. Turbopack will trace the " +
        "spawn() arguments and 500 the route in dev (see this file's header). " +
        "Load it with createRequire instead.",
    );
  });

  it("the prompts route still uses the createRequire escape hatch", () => {
    // Pinned by name: this is the route that went down, and the workaround is
    // non-obvious enough to look like dead weight during a cleanup.
    const src = readFileSync(join(API_ROOT, "tools/prompts/route.ts"), "utf8");
    assert.match(src, /createRequire/, "the bundler workaround was removed");
    assert.match(
      src,
      /nodeRequire\(\s*["']child_process["']\s*\)/,
      "child_process must be loaded opaquely, not imported",
    );
  });
});
