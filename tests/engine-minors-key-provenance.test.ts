/**
 * REVERSE SHADOWING — the silent one, made visible.
 *
 * THE TRAP. getKey() (src/lib/keys.ts:239-262) resolves
 *     data/engine.json keyOverride  →  data/keys.json  →  process.env
 * and that order is CORRECT — the Options panel must reach her voice. But
 * /app/settings writes the MIDDLE store (setKeys → data/keys.json, via
 * src/app/api/keys/route.ts:42 and src/app/settings/page.tsx:221-228). So once
 * Classic has used the Options panel's key field for xai / anthropic / groq,
 * pasting a DIFFERENT key in /settings is silently outranked: it saves, the UI
 * says "KEYS STORED", and nothing changes. He would have no way to know why.
 *
 * THE FIX UNDER TEST — make the shadowing VISIBLE, never change the precedence:
 *   • GET  /api/keys reports, per slot, WHICH store the effective value came from
 *     and whether an Options override is standing over it.
 *   • POST /api/keys names the slots the save will not affect, at the moment of
 *     the save.
 *   • /app/settings renders both.
 *
 * SECRET DISCIPLINE: this surface may emit the store NAME and a masked last-4.
 * Never a value, never a fragment beyond the last 4. Asserted below against the
 * real credential strings.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, after } from "node:test";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KEY_SLOTS, describeKeySlot, describeKeySlots, getKey } from "../src/lib/keys";
import { __resetEngineConfigCache } from "../src/lib/engine/config";
import { GET, POST } from "../src/app/api/keys/route";

const REPO = path.resolve(import.meta.dirname, "..");
const SETTINGS_SRC = readFileSync(path.join(REPO, "src", "app", "settings", "page.tsx"), "utf8");

const ENGINE_ENV = "STARRA_ENGINE_CONFIG_PATH";
const KEYS_ENV = "STARRA_KEYS_PATH";

/** Shaped like real keys so the shape-redactor would also catch a leak. */
const ENGINE_KEY = "xai-EngineOverrideAAAAAAAAAAAAAAAA1111";
const VAULT_KEY = "xai-VaultKeysJsonBBBBBBBBBBBBBBBBB2222";
const ENV_KEY_VALUE = "xai-EnvFallbackCCCCCCCCCCCCCCCCCC3333";
const ALL_SECRETS = [ENGINE_KEY, VAULT_KEY, ENV_KEY_VALUE];

let dir: string;
let enginePath: string;
let keysPath: string;

const savedEnv: Record<string, string | undefined> = {
  [ENGINE_ENV]: process.env[ENGINE_ENV],
  [KEYS_ENV]: process.env[KEYS_ENV],
  XAI_API_KEY: process.env.XAI_API_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};

async function writeEngine(raw: string): Promise<void> {
  await fs.writeFile(enginePath, raw, "utf8");
  __resetEngineConfigCache();
}

async function writeVault(raw: string): Promise<void> {
  await fs.writeFile(keysPath, raw, "utf8");
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "starra-key-provenance-"));
  enginePath = path.join(dir, "engine.json");
  keysPath = path.join(dir, "keys.json");
  process.env[ENGINE_ENV] = enginePath;
  process.env[KEYS_ENV] = keysPath;
  delete process.env.XAI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  __resetEngineConfigCache();
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetEngineConfigCache();
});

/** No credential fragment beyond a last-4 may appear anywhere in a payload. */
function assertNoSecret(payload: unknown, where: string): void {
  const text = JSON.stringify(payload) ?? "";
  for (const secret of ALL_SECRETS) {
    assert.ok(!text.includes(secret), `${where} leaked a whole credential`);
    assert.ok(
      !text.includes(secret.slice(0, 12)),
      `${where} leaked the leading characters of a credential`,
    );
  }
}

describe("key provenance — which store the effective value came from", () => {
  it("reports source ENGINE when the Options panel holds an override", async () => {
    await writeEngine(JSON.stringify({ providers: { xai: { keyOverride: ENGINE_KEY } } }));
    await writeVault(JSON.stringify({ xai: VAULT_KEY }));
    process.env.XAI_API_KEY = ENV_KEY_VALUE;

    const slot = await describeKeySlot("xai");
    assert.equal(slot.source, "engine");
    assert.equal(slot.shadowedByEngine, true);
    assert.equal(await getKey("xai"), ENGINE_KEY, "precedence must NOT have changed");
    assert.ok(slot.masked?.endsWith("1111"), `expected the engine key's last 4, got ${slot.masked}`);
    assertNoSecret(slot, "describeKeySlot");
  });

  it("reports source VAULT, unshadowed, when only /settings has been used", async () => {
    await writeEngine(JSON.stringify({ providers: { xai: { enabled: true } } }));
    await writeVault(JSON.stringify({ xai: VAULT_KEY }));

    const slot = await describeKeySlot("xai");
    assert.equal(slot.source, "vault");
    assert.equal(slot.shadowedByEngine, false);
    assert.ok(slot.masked?.endsWith("2222"));
  });

  it("reports source ENV when neither store holds the slot", async () => {
    await writeEngine(JSON.stringify({ providers: {} }));
    await writeVault(JSON.stringify({}));
    process.env.XAI_API_KEY = ENV_KEY_VALUE;

    const slot = await describeKeySlot("xai");
    assert.equal(slot.source, "env");
    assert.equal(slot.shadowedByEngine, false);
    assert.ok(slot.masked?.endsWith("3333"));
  });

  it("reports source null and masked null for an unset slot", async () => {
    await writeEngine(JSON.stringify({ providers: {} }));
    await writeVault(JSON.stringify({}));

    const slot = await describeKeySlot("xai");
    assert.equal(slot.source, null);
    assert.equal(slot.masked, null);
    assert.equal(slot.shadowedByEngine, false);
  });

  it("WARNS BEFORE THE PASTE: an override shadows the slot even with an EMPTY vault", async () => {
    // This is the moment that matters. He has not saved anything in /settings
    // yet; the badge must already tell him a save here will not take effect.
    await writeEngine(JSON.stringify({ providers: { xai: { keyOverride: ENGINE_KEY } } }));
    await writeVault(JSON.stringify({}));

    const slot = await describeKeySlot("xai");
    assert.equal(slot.shadowedByEngine, true);
    assert.equal(slot.source, "engine");
  });

  it("a blank/whitespace override is NOT shadowing — it matches getKey exactly", async () => {
    await writeEngine(JSON.stringify({ providers: { xai: { keyOverride: "   " } } }));
    await writeVault(JSON.stringify({ xai: VAULT_KEY }));

    const slot = await describeKeySlot("xai");
    assert.equal(slot.shadowedByEngine, false);
    assert.equal(slot.source, "vault");
    assert.equal(await getKey("xai"), VAULT_KEY);
  });

  it("the reported source always MATCHES what getKey actually returns", async () => {
    const cases: ReadonlyArray<readonly [string, string, string | undefined, string, string]> = [
      [JSON.stringify({ providers: { xai: { keyOverride: ENGINE_KEY } } }), JSON.stringify({ xai: VAULT_KEY }), ENV_KEY_VALUE, "engine", ENGINE_KEY],
      [JSON.stringify({ providers: {} }), JSON.stringify({ xai: VAULT_KEY }), ENV_KEY_VALUE, "vault", VAULT_KEY],
      [JSON.stringify({ providers: {} }), JSON.stringify({}), ENV_KEY_VALUE, "env", ENV_KEY_VALUE],
    ];
    for (const [engine, vault, env, source, expected] of cases) {
      await writeEngine(engine);
      await writeVault(vault);
      if (env === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = env;

      const slot = await describeKeySlot("xai");
      assert.equal(slot.source, source);
      assert.equal(await getKey("xai"), expected);
      assert.ok(slot.masked?.endsWith(expected.slice(-4)));
    }
  });

  it("describeKeySlots covers every slot, in KEY_SLOTS order, and leaks nothing", async () => {
    await writeEngine(
      JSON.stringify({
        providers: {
          xai: { keyOverride: ENGINE_KEY },
          groq: { keyOverride: "gsk_EngineGroqAAAAAAAAAAAAAAAAAAA" },
        },
      }),
    );
    await writeVault(JSON.stringify({ xai: VAULT_KEY, multica_token: "mul_vault_only_token_value" }));

    const slots = await describeKeySlots();
    assert.deepEqual(
      slots.map((s) => s.id),
      KEY_SLOTS.map((s) => s.id),
      "describeKeySlots must mirror KEY_SLOTS exactly, in order",
    );
    const byId = new Map(slots.map((s) => [s.id, s]));
    assert.equal(byId.get("xai")?.shadowedByEngine, true);
    assert.equal(byId.get("groq")?.shadowedByEngine, true);
    assert.equal(byId.get("multica_token")?.source, "vault");
    assert.equal(byId.get("multica_token")?.shadowedByEngine, false);
    assert.equal(byId.get("openai")?.source, null);
    assertNoSecret(slots, "describeKeySlots");
  });

  it("never throws on corrupt stores — this path is one hop from her voice", async () => {
    for (const [engine, vault] of [
      ["{ broken", JSON.stringify({ xai: VAULT_KEY })],
      ["[]", "also not json {{{"],
      ["null", "0"],
    ] as const) {
      await writeEngine(engine);
      await writeVault(vault);
      const slots = await describeKeySlots();
      assert.equal(slots.length, KEY_SLOTS.length);
      assertNoSecret(slots, "describeKeySlots on corrupt stores");
    }
  });

  it("the masked form is last-4 only and FIXED WIDTH, matching the rest of the deck", async () => {
    await writeEngine(JSON.stringify({ providers: {} }));
    await writeVault(JSON.stringify({ xai: VAULT_KEY, groq: "gsk_short" }));

    const a = (await describeKeySlot("xai")).masked;
    assert.ok(a !== null);
    assert.equal(a.replace(/•/g, ""), "2222", "the mask revealed more than the last 4");
    assert.ok(!a.includes("xai-"), "the mask leaked the key prefix");
  });
});

describe("GET /api/keys — the shadowing reaches the operator", () => {
  it("forwards source + shadowedByEngine per slot, and still forwards linked + masked", async () => {
    await writeEngine(JSON.stringify({ providers: { xai: { keyOverride: ENGINE_KEY } } }));
    await writeVault(JSON.stringify({ xai: VAULT_KEY, multica_token: "mul_vault_only_token_value" }));

    const res = await GET();
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      slots: Array<{
        id: string;
        label: string;
        hint: string;
        powers: string;
        linked: boolean;
        masked: string | null;
        source: string | null;
        shadowedByEngine: boolean;
      }>;
    };
    const byId = new Map(body.slots.map((s) => [s.id, s]));

    const xai = byId.get("xai");
    assert.equal(xai?.source, "engine");
    assert.equal(xai?.shadowedByEngine, true);
    assert.equal(xai?.linked, true);
    assert.ok(xai?.masked?.endsWith("1111"));
    // The fields the existing UI already renders must survive.
    assert.equal(typeof xai?.label, "string");
    assert.equal(typeof xai?.hint, "string");
    assert.equal(typeof xai?.powers, "string");

    const mul = byId.get("multica_token");
    assert.equal(mul?.source, "vault");
    assert.equal(mul?.shadowedByEngine, false);

    assertNoSecret(body, "GET /api/keys");
  });
});

describe("POST /api/keys — the save moment names what it cannot change", () => {
  const post = (payload: unknown) =>
    POST(
      new Request("http://127.0.0.1:3000/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );

  it("reports the shadowed slots it just wrote, so 'KEYS STORED' cannot mislead", async () => {
    await writeEngine(JSON.stringify({ providers: { xai: { keyOverride: ENGINE_KEY } } }));
    await writeVault(JSON.stringify({}));

    const res = await post({ xai: VAULT_KEY, multica_token: "mul_vault_only_token_value" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; shadowed: string[] };

    assert.equal(body.ok, true);
    assert.deepEqual(body.shadowed, ["xai"], "the save did not report the slot it cannot affect");
    assertNoSecret(body, "POST /api/keys");
    // And the write itself still happened, outranked but stored.
    assert.equal(await getKey("xai"), ENGINE_KEY);
  });

  it("reports an EMPTY shadowed list when nothing is outranked", async () => {
    await writeEngine(JSON.stringify({ providers: {} }));
    await writeVault(JSON.stringify({}));

    const res = await post({ xai: VAULT_KEY });
    const body = (await res.json()) as { ok: boolean; shadowed: string[] };
    assert.equal(body.ok, true);
    assert.deepEqual(body.shadowed, []);
    assert.equal(await getKey("xai"), VAULT_KEY);
  });

  it("only reports slots the caller actually sent", async () => {
    await writeEngine(
      JSON.stringify({
        providers: { xai: { keyOverride: ENGINE_KEY }, groq: { keyOverride: "gsk_EngineGroqAAAAAAAAAAAAAAAAAAA" } },
      }),
    );
    const res = await post({ groq: "gsk_vault_value_aaaaaaaaaaaa" });
    const body = (await res.json()) as { shadowed: string[] };
    assert.deepEqual(body.shadowed, ["groq"]);
  });

  it("keeps every pre-existing guard: bad JSON, non-object, non-string values", async () => {
    const bad = await POST(
      new Request("http://127.0.0.1:3000/api/keys", { method: "POST", body: "{ not json" }),
    );
    assert.equal(bad.status, 400);

    const arr = await post([1, 2]);
    assert.equal(arr.status, 400);

    const num = await post({ xai: 42 });
    assert.equal(num.status, 400);
  });
});

describe("/app/settings — the badge is actually on the screen", () => {
  it("renders the shadow warning and the store the key came from", () => {
    assert.match(
      SETTINGS_SRC,
      /shadowedByEngine/,
      "the settings page never reads shadowedByEngine — the API tells the truth and the UI hides it",
    );
    assert.match(SETTINGS_SRC, /OVERRIDDEN IN OPTIONS/, "no visible badge on a shadowed slot");
    assert.match(SETTINGS_SRC, /source/, "the settings page never surfaces which store is in force");
  });

  it("uses the POST response's shadowed list in the save confirmation", () => {
    assert.match(
      SETTINGS_SRC,
      /shadowed/,
      "the save toast still says STORED without naming the slots it could not affect",
    );
  });

  it("stays operator-voice: no emoji in the new copy", () => {
    // Repo rule (CLAUDE.md): no emojis in UI copy. Surrogate pairs cover the
    // emoji planes without a lookbehind (macOS 12 / WKWebView rule).
    const emoji = /[\uD800-\uDBFF][\uDC00-\uDFFF]/;
    assert.equal(emoji.test(SETTINGS_SRC), false, "an emoji reached the settings copy");
  });
});
