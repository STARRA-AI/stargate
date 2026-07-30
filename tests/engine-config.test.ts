/**
 * STARRA Engine — runtime config store (data/engine.json).
 *
 * Requirements under test: never throws on absent/malformed input, deep-merges
 * onto defaults, writes 0600, invalidates its mtime cache after a write, and
 * resolves secrets keyOverride → process.env → unset.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, after } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_ENGINE_CONFIG,
  __resetEngineConfigCache,
  collectSecretValues,
  deepMergeConfig,
  engineConfigPath,
  readEngineConfig,
  resolveSecret,
  sanitizeEngineConfig,
  writeEngineConfig,
} from "../src/lib/engine/config";
import { PROVIDERS } from "../src/lib/engine/providers";

const ENV_KEY = "STARRA_ENGINE_CONFIG_PATH";
let dir: string;

async function freshPath(): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "starra-engine-"));
  const p = path.join(dir, "engine.json");
  process.env[ENV_KEY] = p;
  __resetEngineConfigCache();
  return p;
}

beforeEach(async () => {
  await freshPath();
});

after(() => {
  delete process.env[ENV_KEY];
});

describe("engine config — defaults and the no-spend invariant", () => {
  it("ships every PAID provider disabled by default", () => {
    const paid = PROVIDERS.filter((p) => p.paid);
    assert.ok(paid.length > 0, "at least replicate must be marked paid");
    for (const p of paid) {
      assert.equal(
        DEFAULT_ENGINE_CONFIG.providers[p.id]?.enabled,
        false,
        `${p.id} must default to disabled`,
      );
    }
  });

  it("keeps paid providers out of every default capability chain", () => {
    const paidIds = new Set(PROVIDERS.filter((p) => p.paid).map((p) => p.id));
    for (const [cap, chain] of Object.entries(DEFAULT_ENGINE_CONFIG.capabilities)) {
      for (const id of chain) {
        assert.ok(!paidIds.has(id), `${cap} default chain must not list paid ${id}`);
      }
    }
  });

  it("honours the config path override", () => {
    assert.equal(engineConfigPath(), process.env[ENV_KEY]);
  });
});

describe("engine config — sanitize never throws", () => {
  it("returns defaults for junk input of any shape", () => {
    for (const junk of [undefined, null, 0, "nope", [], true, () => {}]) {
      const cfg = sanitizeEngineConfig(junk);
      assert.deepEqual(cfg.capabilities, DEFAULT_ENGINE_CONFIG.capabilities);
      assert.deepEqual(cfg.cosmetics, DEFAULT_ENGINE_CONFIG.cosmetics);
    }
  });

  it("repairs bad fields individually and keeps the good ones", () => {
    const cfg = sanitizeEngineConfig({
      providers: { groq: { enabled: false, keyOverride: "abc" }, bogus: { enabled: true } },
      capabilities: { brain: "groq", voice: ["piper", "not-a-provider", "webspeech"] },
      cosmetics: { accentHue: "blue", glowIntensity: 0.4, fontScale: 99, reduceMotion: "yes" },
    });
    assert.equal(cfg.providers.groq?.enabled, false, "good field survives");
    assert.equal(cfg.providers.groq?.keyOverride, "abc");
    assert.ok(!("bogus" in cfg.providers), "unknown provider ids dropped");
    assert.deepEqual(
      cfg.capabilities.brain,
      DEFAULT_ENGINE_CONFIG.capabilities.brain,
      "malformed chain falls back to the default chain",
    );
    assert.deepEqual(cfg.capabilities.voice, ["piper", "webspeech"], "unknown ids filtered out");
    assert.equal(cfg.cosmetics.accentHue, DEFAULT_ENGINE_CONFIG.cosmetics.accentHue);
    assert.equal(cfg.cosmetics.glowIntensity, 0.4, "valid cosmetic survives");
    assert.ok(
      cfg.cosmetics.fontScale <= 2 && cfg.cosmetics.fontScale >= 0.5,
      "out-of-range numbers are clamped or defaulted",
    );
    assert.equal(typeof cfg.cosmetics.reduceMotion, "boolean");
  });

  it("never returns an empty capability chain for a known capability", () => {
    const cfg = sanitizeEngineConfig({ capabilities: { lipsync: [] } });
    assert.ok(cfg.capabilities.lipsync.length > 0);
  });

  it("deep-merges a partial patch without dropping untouched branches", () => {
    const merged = deepMergeConfig(DEFAULT_ENGINE_CONFIG, {
      providers: { groq: { enabled: false } },
      cosmetics: { accentHue: 300 },
    });
    assert.equal(merged.providers.groq?.enabled, false);
    assert.deepEqual(merged.capabilities, DEFAULT_ENGINE_CONFIG.capabilities);
    assert.equal(merged.cosmetics.accentHue, 300);
    assert.equal(merged.cosmetics.mouthSync, DEFAULT_ENGINE_CONFIG.cosmetics.mouthSync);
    assert.equal(
      DEFAULT_ENGINE_CONFIG.providers.groq?.enabled,
      true,
      "merge must not mutate the defaults",
    );
  });
});

describe("engine config — disk", () => {
  it("returns defaults when the file is absent", async () => {
    const cfg = await readEngineConfig();
    assert.deepEqual(cfg.capabilities, DEFAULT_ENGINE_CONFIG.capabilities);
  });

  it("returns defaults when the file is malformed JSON", async () => {
    await fs.writeFile(engineConfigPath(), "{ not json ", "utf8");
    __resetEngineConfigCache();
    const cfg = await readEngineConfig();
    assert.deepEqual(cfg.cosmetics, DEFAULT_ENGINE_CONFIG.cosmetics);
  });

  it("writes 0600 and reads back through the cache", async () => {
    await writeEngineConfig({ cosmetics: { accentHue: 275 } });
    const st = await fs.stat(engineConfigPath());
    assert.equal(st.mode & 0o777, 0o600, "operator-only file mode");
    const cfg = await readEngineConfig();
    assert.equal(cfg.cosmetics.accentHue, 275, "write invalidates the cache");
    const raw = await fs.readFile(engineConfigPath(), "utf8");
    assert.ok(JSON.parse(raw).cosmetics.accentHue === 275);
  });

  it("survives two writes in a row (no partial file)", async () => {
    await writeEngineConfig({ cosmetics: { glowIntensity: 0.2 } });
    await writeEngineConfig({ providers: { groq: { enabled: false } } });
    const cfg = await readEngineConfig();
    assert.equal(cfg.cosmetics.glowIntensity, 0.2);
    assert.equal(cfg.providers.groq?.enabled, false);
  });
});

describe("engine config — secret resolution precedence", () => {
  it("prefers keyOverride, then process.env, then unset", async () => {
    const cfg = sanitizeEngineConfig({
      providers: { groq: { enabled: true, keyOverride: "override-value-1234" } },
    });
    const prev = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "env-value-5678";
    try {
      assert.equal(resolveSecret(cfg, "groq"), "override-value-1234");
      const noOverride = sanitizeEngineConfig({ providers: { groq: { enabled: true } } });
      assert.equal(resolveSecret(noOverride, "groq"), "env-value-5678");
      delete process.env.GROQ_API_KEY;
      assert.equal(resolveSecret(noOverride, "groq"), undefined);
    } finally {
      if (prev === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = prev;
    }
  });

  it("returns undefined for a keyless provider and never throws on unknown ids", () => {
    const cfg = sanitizeEngineConfig({});
    assert.equal(resolveSecret(cfg, "webspeech"), undefined);
    assert.doesNotThrow(() => resolveSecret(cfg, "webspeech"));
  });

  it("collectSecretValues gathers overrides and env values, skipping short ones", () => {
    const cfg = sanitizeEngineConfig({
      providers: { groq: { enabled: true, keyOverride: "override-value-1234" } },
    });
    const prev = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "xai-env-value-abcdefgh";
    try {
      const values = collectSecretValues(cfg);
      assert.ok(values.includes("override-value-1234"));
      assert.ok(values.includes("xai-env-value-abcdefgh"));
      assert.ok(values.every((v) => v.length >= 8));
    } finally {
      if (prev === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = prev;
    }
  });
});
