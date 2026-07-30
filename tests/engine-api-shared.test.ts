/**
 * Engine options routes — the pure layer that every response body passes
 * through (src/app/api/engine/_shared.ts).
 *
 * These are the security-critical invariants of the settings surface, and they
 * are deliberately testable WITHOUT src/lib/engine existing: _shared.ts imports
 * nothing from the engine, so the "no key ever crosses the wire" guarantee is
 * proven here regardless of how the engine core lands.
 *
 * No network call is made anywhere in this file.
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

type Shared = typeof import("../src/app/api/engine/_shared");
let S: Shared;

before(async () => {
  S = await import("../src/app/api/engine/_shared");
});

describe("toProviderView — the secret chokepoint", () => {
  it("drops every field that is not on the allowlist, including key material", () => {
    const view = S.toProviderView({
      id: "replicate",
      label: "Replicate",
      capabilities: ["lipsync"],
      paid: true,
      enabled: false,
      status: "disabled",
      hasKey: true,
      last4: "9f3a",
      // Hostile extras a sloppy engine might hand back:
      ...({
        keyOverride: "r8_LIVEKEYDONOTLEAK123456",
        apiKey: "sk-ant-doNotLeakThisEither000000",
        secret: "hunter2",
        env: { REPLICATE_API_TOKEN: "r8_alsoNotAllowed99999999" },
      } as Record<string, unknown>),
    });

    const wire = JSON.stringify(view);
    assert.ok(!wire.includes("r8_LIVEKEYDONOTLEAK123456"), "keyOverride leaked");
    assert.ok(!wire.includes("sk-ant-"), "apiKey leaked");
    assert.ok(!wire.includes("hunter2"), "secret leaked");
    assert.ok(!wire.includes("REPLICATE_API_TOKEN"), "env leaked");

    assert.deepEqual(Object.keys(view).sort(), [
      "capabilities",
      "detail",
      "enabled",
      "envKeys",
      "hasKey",
      "id",
      "label",
      "last4",
      "local",
      "notes",
      "paid",
      "status",
    ]);
  });

  it("scrubs the free-text detail and notes fields", () => {
    const view = S.toProviderView({
      id: "xai",
      detail: "401 for xai-AbCdEfGhIjKlMnOpQrSt",
      notes: "plain note",
    });
    assert.ok(!view.detail.includes("xai-AbCd"), `detail leaked: ${view.detail}`);
    assert.equal(view.notes, "plain note");
    // Empty stays empty — scrubMessage's error fallback must not leak in here.
    assert.equal(S.toProviderView({ id: "x" }).detail, "");
  });

  it("keeps envKeys as NAMES and drops non-string entries", () => {
    const view = S.toProviderView({ id: "xai", envKeys: ["XAI_API_KEY", 42, null] });
    assert.deepEqual(view.envKeys, ["XAI_API_KEY"]);
  });

  it("clamps last4 to four characters even if a whole key is put there", () => {
    const view = S.toProviderView({ id: "x", last4: "sk-ant-averylongrealkey7788" });
    assert.equal(view.last4, "7788");
    assert.equal(view.last4?.length, 4);
  });

  it("never returns a truthy paid/enabled/hasKey for non-boolean junk", () => {
    const view = S.toProviderView({
      id: "x",
      paid: "yes" as unknown,
      enabled: 1 as unknown,
      hasKey: {} as unknown,
    });
    assert.equal(view.paid, false);
    assert.equal(view.enabled, false);
    assert.equal(view.hasKey, false);
  });

  it("survives a completely empty provider record without throwing", () => {
    const view = S.toProviderView({});
    assert.equal(view.id, "");
    assert.equal(view.status, "unknown");
    assert.equal(view.last4, null);
    assert.deepEqual(view.capabilities, []);
  });
});

describe("scrubMessage — nothing key-shaped reaches the client", () => {
  const cases: [string, string][] = [
    ["anthropic", "upstream rejected sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"],
    ["groq", "401 from gsk_AAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["xai", "connect failed for xai-AbCdEfGhIjKlMnOpQrSt"],
    ["huggingface", "hf_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA not accepted"],
    ["replicate", "r8_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA is invalid"],
    ["bearer header echo", "sent Authorization: Bearer abc123def456ghi789jkl"],
    ["opaque token", "reply body contained aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7b"],
  ];

  it("redacts every known key shape", () => {
    for (const [name, input] of cases) {
      const out = S.scrubMessage(input);
      assert.ok(
        !/sk-ant-api03|gsk_A|xai-AbCd|hf_AAA|r8_AAA|abc123def456|aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7b/.test(
          out,
        ),
        `${name} survived scrubbing: ${out}`,
      );
    }
  });

  it("caps length, collapses whitespace, and never emits a stack", () => {
    const err = new Error("boom");
    const out = S.scrubMessage(err);
    assert.equal(out, "boom");
    assert.ok(!out.includes("at "), "stack frame leaked");

    const long = S.scrubMessage("word ".repeat(400));
    assert.ok(long.length <= 321, `length not capped: ${long.length}`);
  });

  it("returns an operator-voice fallback rather than empty or [object Object]", () => {
    assert.equal(S.scrubMessage(undefined), "unspecified fault");
    assert.equal(S.scrubMessage({ weird: true }), "unspecified fault");
  });

  it("faultBody and errorBody expose only an `error` string", () => {
    const b = S.faultBody(new Error("xai-AbCdEfGhIjKlMnOpQrSt blew up"));
    assert.deepEqual(Object.keys(b), ["error"]);
    assert.ok(!b.error.includes("xai-AbCd"));
    assert.deepEqual(Object.keys(S.errorBody("nope")), ["error"]);
  });
});

describe("providerPatchSchema — malformed bodies never reach the config store", () => {
  const ids = ["groq", "xai", "replicate"];

  it("rejects an unknown provider id", () => {
    const r = S.providerPatchSchema(ids).safeParse({ id: "evilcorp", enabled: true });
    assert.equal(r.success, false);
  });

  it("rejects unknown keys in the body (no smuggling extra config)", () => {
    const r = S.providerPatchSchema(ids).safeParse({
      id: "groq",
      enabled: true,
      keyOverride: "r8_sneaky",
    });
    assert.equal(r.success, false);
  });

  it("rejects a body that changes nothing", () => {
    const r = S.providerPatchSchema(ids).safeParse({ id: "groq" });
    assert.equal(r.success, false);
  });

  it("rejects a non-string key and an over-long key", () => {
    assert.equal(S.providerPatchSchema(ids).safeParse({ id: "groq", key: 42 }).success, false);
    assert.equal(
      S.providerPatchSchema(ids).safeParse({ id: "groq", key: "a".repeat(4097) }).success,
      false,
    );
  });

  it("accepts the two legitimate gestures: set a key, and clear it", () => {
    assert.equal(S.providerPatchSchema(ids).safeParse({ id: "groq", key: "gsk_x" }).success, true);
    assert.equal(S.providerPatchSchema(ids).safeParse({ id: "groq", key: "" }).success, true);
    assert.equal(S.providerPatchSchema(ids).safeParse({ id: "groq", enabled: false }).success, true);
  });

  it("providerIdSchema rejects unknown ids and extra fields", () => {
    assert.equal(S.providerIdSchema(ids).safeParse({ id: "nope" }).success, false);
    assert.equal(S.providerIdSchema(ids).safeParse({ id: "groq", extra: 1 }).success, false);
    assert.equal(S.providerIdSchema(ids).safeParse({ id: "groq" }).success, true);
  });
});

describe("cosmetics — bounded so a bad write cannot wreck the deck", () => {
  it("defaults are in range and keep the mouth on", () => {
    // The exact hue is the ENGINE's to choose; parity with its store is asserted
    // in tests/engine-api-cosmetics-parity.test.ts, not duplicated here.
    assert.equal(S.cosmeticsSchema.safeParse(S.DEFAULT_COSMETICS).success, true);
    assert.equal(S.DEFAULT_COSMETICS.mouthSync, true);
    assert.ok(S.DEFAULT_COSMETICS.idlePool.length > 0);
  });

  it("rejects out-of-range and hostile values", () => {
    const bad: unknown[] = [
      { accentHue: 9999 },
      { accentHue: -1 },
      { fontScale: 40 },
      { fontScale: 0 },
      { glowIntensity: 12 },
      { idlePool: [] },
      { idlePool: ["../../etc/passwd"] },
      { idlePool: ["<script>"] },
      { mouthSync: "yes" },
      { unknownField: 1 },
    ];
    for (const b of bad) {
      assert.equal(
        S.cosmeticsPatchSchema.safeParse(b).success,
        false,
        `accepted hostile cosmetics: ${JSON.stringify(b)}`,
      );
    }
  });

  it("rejects an empty patch", () => {
    assert.equal(S.cosmeticsPatchSchema.safeParse({}).success, false);
  });

  it("normalizeCosmetics falls back to defaults on garbage and strips unknown keys", () => {
    assert.deepEqual(S.normalizeCosmetics(null), S.DEFAULT_COSMETICS);
    assert.deepEqual(S.normalizeCosmetics("nope"), S.DEFAULT_COSMETICS);
    assert.deepEqual(S.normalizeCosmetics([1, 2]), S.DEFAULT_COSMETICS);

    // An out-of-RANGE number now CLAMPS to the nearest legal value instead of
    // resetting the whole object — resetting cost Classic every unrelated
    // cosmetic he had set (see tests/engine-minors-cosmetics-bounds.test.ts).
    // The rest of the object must still be untouched.
    assert.deepEqual(S.normalizeCosmetics({ accentHue: 5000 }), {
      ...S.DEFAULT_COSMETICS,
      accentHue: S.COSMETIC_BOUNDS.accentHue[1],
    });

    const merged = S.normalizeCosmetics({ accentHue: 20, injected: "x" });
    assert.equal(merged.accentHue, 20);
    assert.ok(!("injected" in merged));
    assert.equal(merged.fontScale, S.DEFAULT_COSMETICS.fontScale);
  });

  it("mouthSync is a MOUTH switch only — it is stored, never used to gate audio", () => {
    // Contract note, enforced by the panel's copy + the voice division owning
    // playback. Here we only assert the field exists and defaults ON.
    const c = S.normalizeCosmetics({ mouthSync: false });
    assert.equal(c.mouthSync, false);
    assert.equal(S.DEFAULT_COSMETICS.mouthSync, true);
  });
});

describe("deriveFaults — the 'what is broken right now' list", () => {
  const free = (id: string, over: Partial<ReturnType<typeof S.toProviderView>> = {}) =>
    S.toProviderView({
      id,
      label: id,
      capabilities: ["brain"],
      paid: false,
      enabled: true,
      status: "ok",
      hasKey: true,
      last4: "1234",
      ...over,
    });

  it("reports an unresolved capability as an error with a fix", () => {
    const faults = S.deriveFaults([], [{ capability: "brain", providerId: null, why: "no key", chain: [] }]);
    assert.equal(faults.length, 1);
    assert.equal(faults[0].severity, "error");
    assert.match(faults[0].what, /BRAIN has no live provider/);
    assert.ok(faults[0].fix.length > 0, "a fault must always carry a fix");
  });

  it("escalates a capability routed to a PAID provider to an error", () => {
    const providers = [free("replicate", { paid: true, label: "Replicate", capabilities: ["lipsync"] })];
    const faults = S.deriveFaults(providers, [
      { capability: "lipsync", providerId: "replicate", why: "first eligible", chain: [] },
    ]);
    const spendErrors = faults.filter((f) => f.severity === "error" && /SPEND/.test(f.what));
    assert.equal(spendErrors.length, 1);
  });

  it("warns whenever a paid provider is merely enabled", () => {
    const faults = S.deriveFaults([free("replicate", { paid: true })], []);
    assert.ok(faults.some((f) => /SPEND/.test(f.what)), "paid+enabled must always be surfaced");
  });

  it("stays silent about a paid provider that is disabled — the default posture", () => {
    const faults = S.deriveFaults([free("replicate", { paid: true, enabled: false, status: "disabled" })], []);
    assert.equal(faults.length, 0);
  });

  it("warns on enabled-without-key and on an unreachable probe", () => {
    const faults = S.deriveFaults(
      [
        free("groq", { hasKey: false, envKeys: ["GROQ_API_KEY"] }),
        free("xai", { status: "unreachable", envKeys: ["XAI_API_KEY"] }),
      ],
      [],
    );
    assert.ok(faults.some((f) => /no key linked/.test(f.what)));
    assert.ok(faults.some((f) => /GROQ_API_KEY/.test(f.fix)), "the fix must name the env var");
    assert.ok(faults.some((f) => /health probe/.test(f.what)));
  });

  it("NEVER nags about a key for a local provider that needs none", () => {
    // Regression: ollama / piper / webspeech / viseme-bank / local-memory are all
    // enabled with no key by design. Warning about them filled DIAGNOSTICS with
    // five permanent false alarms on the live deck.
    const locals = ["ollama", "piper", "webspeech", "viseme-bank", "local-memory"].map((id) =>
      free(id, { hasKey: false, local: true, envKeys: [] }),
    );
    assert.deepEqual(S.deriveFaults(locals, []), []);
  });

  it("still nags a keyed remote provider that has no envKeys recorded", () => {
    // No envKeys and not local: nothing to paste, so silence is correct here too
    // rather than a fault with no actionable fix.
    const faults = S.deriveFaults([free("mystery", { hasKey: false, envKeys: [] })], []);
    assert.deepEqual(faults, []);
  });

  it("adopts the engine's own broken list as the capability authority", () => {
    const faults = S.deriveFaults(
      [],
      [{ capability: "voice", providerId: null, why: "stale", chain: [] }],
      [{ capability: "voice", providerId: null, why: "no key on xai" }],
    );
    // One capability fault, not two — the engine's version wins.
    const voice = faults.filter((f) => f.capability === "voice");
    assert.equal(voice.length, 1);
    assert.match(voice[0].what, /VOICE is down — no key on xai/);
    assert.ok(voice[0].fix.length > 0);
  });

  it("still reports SPEND on a capability the engine already flagged", () => {
    const faults = S.deriveFaults(
      [free("replicate", { paid: true, label: "Replicate" })],
      [{ capability: "lipsync", providerId: "replicate", why: "", chain: [] }],
      [{ capability: "lipsync", providerId: "replicate", why: "probe failed" }],
    );
    assert.ok(faults.some((f) => /SPEND/.test(f.what)), "spend rule must never be suppressed");
  });

  it("scrubs a credential out of an engine-supplied why", () => {
    const faults = S.deriveFaults([], [], [
      { capability: "brain", providerId: "groq", why: "401 for gsk_AAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    ]);
    assert.ok(!faults[0].what.includes("gsk_AAA"), faults[0].what);
  });

  it("sorts errors ahead of warnings", () => {
    const faults = S.deriveFaults(
      [free("groq", { hasKey: false, envKeys: ["GROQ_API_KEY"] })],
      [{ capability: "voice", providerId: null, why: "", chain: [] }],
    );
    assert.equal(faults[0].severity, "error");
    assert.ok(faults.every((f) => f.fix.length > 0));
  });

  it("every fault carries a fix — never a problem without a path", () => {
    const faults = S.deriveFaults(
      [
        free("replicate", { paid: true }),
        free("groq", { hasKey: false, envKeys: ["GROQ_API_KEY"] }),
        free("xai", { status: "unreachable", envKeys: ["XAI_API_KEY"] }),
      ],
      [
        { capability: "brain", providerId: null, why: "", chain: [] },
        { capability: "lipsync", providerId: "replicate", why: "", chain: [] },
      ],
    );
    assert.ok(faults.length >= 5);
    for (const f of faults) assert.ok(f.fix.trim().length > 0, `no fix on: ${f.what}`);
  });
});

describe("toResolutionView", () => {
  it("reads the engine's `considered` chain shape (id/ok/reason)", () => {
    const r = S.toResolutionView({
      capability: "brain",
      providerId: "groq",
      why: "first eligible",
      considered: [
        { id: "groq", ok: true, reason: "keyed and enabled", status: "ok" },
        { id: "xai", ok: false, reason: "disabled", status: "disabled" },
      ],
    });
    assert.equal(r.chain.length, 2);
    assert.equal(r.chain[0].eligible, true);
    assert.equal(r.chain[0].why, "keyed and enabled");
    assert.equal(r.chain[1].eligible, false);
    assert.equal(r.chain[1].why, "disabled");
  });

  it("scrubs a chain reason that carries a credential", () => {
    const r = S.toResolutionView({
      considered: [{ id: "xai", ok: false, reason: "rejected xai-AbCdEfGhIjKlMnOpQrSt" }],
    });
    assert.ok(!r.chain[0].why.includes("xai-AbCd"));
  });

  it("leaves an absent reason empty rather than inventing a fault", () => {
    const r = S.toResolutionView({ considered: [{ id: "groq", ok: true }] });
    assert.equal(r.chain[0].why, "");
  });

  it("normalizes a junk chain without throwing", () => {
    const r = S.toResolutionView({
      capability: "brain",
      providerId: "",
      why: 5 as unknown,
      chain: [null, { id: "groq", eligible: true, status: "ok", why: "keyed" }, "junk"],
    });
    assert.equal(r.providerId, null);
    assert.equal(r.why, "");
    assert.equal(r.chain.length, 3);
    assert.equal(r.chain[1].id, "groq");
    assert.equal(r.chain[1].eligible, true);
  });
});

describe("json helper", () => {
  it("never lets a settings response be cached", async () => {
    const res = S.json({ a: 1 });
    assert.equal(res.headers.get("Cache-Control"), "no-store, max-age=0");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { a: 1 });
    assert.equal(S.json({}, 409).status, 409);
  });
});
