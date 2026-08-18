/**
 * TOUCH ID, NOT "A PASSKEY".
 *
 * The credential on this machine was registered with transports
 * ["hybrid","internal"] — hybrid is cross-device (QR-your-phone, formerly
 * caBLE). Advertising it in allowCredentials is what summons the generic
 * passkey picker instead of the Touch ID sheet. These tests pin the rule that
 * a platform credential never advertises a roaming transport.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loginTransports, PLATFORM_ONLY_REASON } from "../src/lib/webauthn";
import type { StoredPasskey } from "../src/lib/webauthn";

function rec(over: Partial<StoredPasskey> = {}): StoredPasskey {
  return {
    id: "cred-1",
    publicKey: "pk",
    counter: 0,
    label: "Touch ID",
    createdAt: 0,
    ...over,
  };
}

describe("loginTransports — a platform credential never advertises roaming", () => {
  it("drops hybrid from a platform credential", () => {
    const p = rec({ attachment: "platform", transports: ["hybrid", "internal"] });
    assert.deepEqual(loginTransports(p), ["internal"]);
  });

  it("drops every roaming transport, not just hybrid", () => {
    const p = rec({ attachment: "platform", transports: ["ble", "nfc", "usb", "internal"] });
    assert.deepEqual(loginTransports(p), ["internal"]);
  });

  it("returns undefined rather than an empty array when nothing survives", () => {
    // An empty transports array is a HINT THAT NOTHING WORKS. Omitting the
    // field lets the browser use its own judgement, which is what we want.
    const p = rec({ attachment: "platform", transports: ["hybrid"] });
    assert.equal(loginTransports(p), undefined);
  });

  it("leaves a legacy record (no attachment recorded) untouched", () => {
    // Records written before this change have no attachment. Silently
    // narrowing them could lock Classic out of a credential that does work.
    const p = rec({ transports: ["hybrid", "internal"] });
    assert.deepEqual(loginTransports(p), ["hybrid", "internal"]);
  });

  it("passes through undefined transports", () => {
    assert.equal(loginTransports(rec({ attachment: "platform" })), undefined);
  });
});

describe("PLATFORM_ONLY_REASON", () => {
  it("is one sentence Classic can act on, and never says 'passkey'", () => {
    assert.ok(PLATFORM_ONLY_REASON.length > 20);
    assert.ok(/Touch ID/.test(PLATFORM_ONLY_REASON));
  });
});
