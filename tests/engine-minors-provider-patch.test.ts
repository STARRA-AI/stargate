/**
 * PROVIDER PATCH — no secret at rest for a provider that has no credential slot,
 * and a masked echo that reports what is NOW in force.
 *
 * TWO REPORTED FAULTS.
 *
 * [4] `providerPatchSchema` (src/app/api/engine/_shared.ts:238-255) validated
 *     id/key/enabled/confirmPaid but never asked whether the provider needs a
 *     credential at all. `POST {"id":"piper","key":"whatever"}` validated — piper
 *     is a known id — and wrote a keyOverride for a provider whose envKeys is []
 *     (src/lib/engine/providers.ts:171), where resolveSecret will never read it.
 *     An unused secret sitting at rest on disk for no reason, and that provider's
 *     hasKey/last4 become meaningless.
 *
 * [3] The masked echo was computed from the PRE-write snapshot
 *     (src/app/api/engine/providers/route.ts:95), so the documented CLEAR gesture
 *     (`key: ""`) echoed the last 4 of the key just deleted. It read as
 *     "clear failed". The echo must come from post-write state.
 *
 * Nothing here makes a billable call: this is pure schema + pure projection.
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { maskKey, last4 } from "../src/lib/engine/redact";

type Shared = typeof import("../src/app/api/engine/_shared");
let S: Shared;

const REPO = path.resolve(import.meta.dirname, "..");
/** Comments stripped, so a doc block that NAMES the old bug cannot fail the check
 *  (and cannot pass one either). No regex lookbehind — macOS 12 / WKWebView rule. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const ROUTE_CODE = stripComments(
  readFileSync(path.join(REPO, "src", "app", "api", "engine", "providers", "route.ts"), "utf8"),
);
const readRoute = () => ROUTE_CODE;

/** Mirrors the registry: keyed providers vs the free local ones. */
const KEYED = ["groq", "xai", "anthropic", "huggingface", "replicate"] as const;
const KEYLESS = ["ollama", "piper", "webspeech", "viseme-bank", "local-memory"] as const;
const ALL = [...KEYED, ...KEYLESS];

before(async () => {
  S = await import("../src/app/api/engine/_shared");
});

describe("the keyed/keyless split is read from the registry, not guessed", () => {
  it("matches src/lib/engine/providers.ts exactly", async () => {
    const { PROVIDERS, needsKey } = await import("../src/lib/engine/providers");
    assert.deepEqual(
      PROVIDERS.filter((p) => needsKey(p)).map((p) => p.id).sort(),
      [...KEYED].sort(),
    );
    assert.deepEqual(
      PROVIDERS.filter((p) => !needsKey(p)).map((p) => p.id).sort(),
      [...KEYLESS].sort(),
    );
  });

  it("keyless === local for EVERY provider — which is why the panel can never hit the new refusal", async () => {
    // OptionsPanel.tsx:513,530 gates the key input and its SAVE button on
    // `!p.local`. As long as that predicate is equivalent to needsKey(), the
    // tightening below is unreachable from the UI and only blocks a raw POST.
    const { PROVIDERS, needsKey } = await import("../src/lib/engine/providers");
    const mismatched = PROVIDERS.filter((p) => needsKey(p) === p.local).map((p) => p.id);
    assert.deepEqual(
      mismatched,
      [],
      "a provider is local-but-keyed or remote-but-keyless — the Options panel would now render a key field the route refuses",
    );
  });
});

describe("providerPatchSchema — a keyless provider may not be handed a key", () => {
  it("REJECTS a key for a provider whose registry entry needs none", () => {
    const r = S.providerPatchSchema(ALL, KEYED).safeParse({ id: "piper", key: "whatever" });
    assert.equal(r.success, false, "a keyOverride for piper would sit at rest, unread, forever");
    if (!r.success) {
      assert.deepEqual(r.error.issues[0]?.path, ["key"], "the rejection must point at `key`");
      // The operator-voice line must never echo the value he pasted.
      const line = S.zodMessage(r.error.issues);
      assert.ok(!line.includes("whatever"), "the rejection echoed the pasted secret");
    }
  });

  it("REJECTS even the CLEAR gesture for a keyless provider — there is nothing to clear", () => {
    const r = S.providerPatchSchema(ALL, KEYED).safeParse({ id: "piper", key: "" });
    assert.equal(r.success, false);
  });

  it("rejects a key for EVERY keyless provider in the registry", () => {
    for (const id of KEYLESS) {
      assert.equal(
        S.providerPatchSchema(ALL, KEYED).safeParse({ id, key: "x" }).success,
        false,
        `${id} accepted a key it can never read`,
      );
    }
  });

  it("still ACCEPTS a key for every provider that declares envKeys", () => {
    for (const id of KEYED) {
      assert.equal(
        S.providerPatchSchema(ALL, KEYED).safeParse({ id, key: "gsk_live_value" }).success,
        true,
        `${id} was refused a key it genuinely needs`,
      );
      assert.equal(
        S.providerPatchSchema(ALL, KEYED).safeParse({ id, key: "" }).success,
        true,
        `${id} was refused the documented CLEAR gesture`,
      );
    }
  });

  it("still ACCEPTS enabled for a keyless provider — turning Piper on must not break", () => {
    for (const id of KEYLESS) {
      assert.equal(S.providerPatchSchema(ALL, KEYED).safeParse({ id, enabled: true }).success, true);
      assert.equal(S.providerPatchSchema(ALL, KEYED).safeParse({ id, enabled: false }).success, true);
    }
  });

  it("keeps every pre-existing guard: unknown id, wrong types, oversize, empty patch", () => {
    const S2 = (raw: unknown) => S.providerPatchSchema(ALL, KEYED).safeParse(raw).success;
    assert.equal(S2({ id: "evilcorp", enabled: true }), false);
    assert.equal(S2({ id: "groq", key: 42 }), false);
    assert.equal(S2({ id: "groq", key: "a".repeat(4097) }), false);
    assert.equal(S2({ id: "groq" }), false, "an empty patch must still be rejected");
    assert.equal(S2({ id: "groq", enabled: true, extra: 1 }), false, "strictObject must still hold");
  });

  it("omitting the keyed-id list keeps the OLD permissive behaviour, so no caller silently breaks", () => {
    assert.equal(S.providerPatchSchema(ALL).safeParse({ id: "piper", key: "x" }).success, true);
  });
});

describe("masked echo — it reports what is NOW in force", () => {
  it("maskFromLast4 is byte-identical to the engine's maskKey for the same secret", () => {
    const secret = "xai-AbCdEfGhIjKlMnOpQrStUvWx9876";
    assert.equal(
      S.maskFromLast4(last4(secret)),
      maskKey(secret),
      "the route's echo and the engine's mask disagree — one of them leaks a different amount",
    );
  });

  it("is FIXED WIDTH, so an echo cannot leak the key's length", () => {
    const a = S.maskFromLast4("1234");
    const b = S.maskFromLast4("9876");
    assert.equal(a?.length, b?.length);
    assert.equal(a?.length, maskKey("x".repeat(40))?.length);
  });

  it("reveals at most 4 characters, whatever it is handed", () => {
    // Even if a caller ever passed a whole key into this field by mistake.
    const out = S.maskFromLast4("xai-AbCdEfGhIjKlMnOpQrStUvWx9876");
    assert.ok(out !== null);
    assert.equal(out.replace(/•/g, ""), "9876");
    assert.ok(!out.includes("xai-"), "the echo leaked the key prefix");
  });

  it("is null when nothing is in force — the CLEAR gesture's honest answer", () => {
    assert.equal(S.maskFromLast4(null), null);
    assert.equal(S.maskFromLast4(""), null);
    assert.equal(S.maskFromLast4("   "), null);
  });

  it("the route computes its echo from POST-WRITE state, never the pre-write snapshot", () => {
    // Structural: the pre-write snapshot is named `current` in the route and the
    // post-write one `after`. `current.last4` in the echo was the whole bug.
    const src = readRoute();
    assert.ok(
      !src.includes("current.last4"),
      "the masked echo still reads the PRE-write snapshot — clearing a key will report the deleted key's last 4",
    );
    assert.ok(
      src.includes("maskFromLast4"),
      "the echo no longer goes through the one masking helper",
    );
    // …and the echo is built from the post-write view, not from the pasted key.
    assert.match(src, /masked:\s*afterView\s*\?\s*maskFromLast4\(/);
  });

  it("the route never hand-rolls a bullet run", () => {
    assert.ok(
      !readRoute().includes("••••"),
      "a hand-built mask reappeared in the route — width must come from one helper",
    );
  });
});
