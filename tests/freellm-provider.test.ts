/**
 * FREELLM ROUTER — the $0 overflow brain's contracts, pinned on the source:
 * a first-class provider with NO invented model slug (router down + no pin =
 * clean throw = next fallback rung), an explicit opt-in chat branch, a
 * recursion-guarded rung in auto fallback (Kimi → FreeLLM → Ollama →
 * offline), and hard exclusion from silently entering paid Anthropic.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

describe("hosted.ts — freellm is a first-class provider", () => {
  const src = read("src/lib/llm/hosted.ts");

  it("joins the provider union and the vault slot map", () => {
    assert.match(src, /"kimi" \| "grok" \| "freellm"/);
    assert.match(src, /freellm: "freellm"/);
  });

  it("defaults to the local router and env-overrides cleanly", () => {
    assert.match(src, /FREELLM_BASE_URL \|\| "http:\/\/localhost:3001\/v1"/);
    assert.match(src, /keyEnv: "FREELLM_API_KEY"/);
    assert.match(src, /modelEnv: "FREELLM_MODEL"/);
  });

  it("NEVER invents a model slug — empty default + clean throw", () => {
    assert.match(src, /defaultModel: "",/);
    assert.match(src, /model unresolved — router unreachable/);
  });
});

describe("chat route — opt-in branch, guarded fallback rung, no paid bleed", () => {
  const src = read("src/app/api/chat/route.ts");

  it("freellm is an explicit opt-in branch", () => {
    assert.match(src, /prefer === "freellm" && \(await hostedAvailable\("freellm"\)\)/);
    assert.match(src, /FreeLLM brain — /);
  });

  it("auto fallback rung is recursion-guarded", () => {
    assert.match(src, /label !== "FreeLLM" && \(await hostedAvailable\("freellm"\)\)/);
  });

  it("a keyless freellm selection can never slide into paid Anthropic", () => {
    assert.match(src, /prefer !== "freellm"/);
  });
});

describe("surfaces + runbook", () => {
  it("vault slot, status line, env example all know the router", () => {
    assert.match(read("src/lib/keys.ts"), /id: "freellm"/);
    assert.match(read("src/app/api/llm/status/route.ts"), /freellm/);
    assert.match(read(".env.example"), /FREELLM_API_KEY=/);
  });

  it("the runbook exists and states both honest caveats", () => {
    assert.ok(existsSync(join(REPO, "docs/FREELLM.md")));
    const doc = read("docs/FREELLM.md");
    assert.match(doc, /free models, not Claude/);
    assert.match(doc, /ToS\s+compliance is on you/);
    assert.ok(!doc.includes("curl | bash"), "no piped-installer instructions");
  });
});
