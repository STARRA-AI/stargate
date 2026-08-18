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
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loginTransports,
  PLATFORM_ONLY_REASON,
  removePasskey,
  loadPasskeys,
  savePasskeys,
  PLATFORM_AUTHENTICATOR_SELECTION,
} from "../src/lib/webauthn";
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
    assert.ok(!/passkey/i.test(PLATFORM_ONLY_REASON));
  });
});

describe("removePasskey — against a redirected store, never the real one", () => {
  let dir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "passkeys-"));
    prevDataDir = process.env.STARRA_DATA_DIR;
    process.env.STARRA_DATA_DIR = dir;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.STARRA_DATA_DIR;
    else process.env.STARRA_DATA_DIR = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("removing a present id returns true and the record is gone from loadPasskeys()", () => {
    savePasskeys([rec({ id: "cred-1" }), rec({ id: "cred-2" })]);
    assert.equal(removePasskey("cred-1"), true);
    assert.deepEqual(
      loadPasskeys().map((p) => p.id),
      ["cred-2"],
    );
  });

  it("removing an absent id returns false and the store is left byte-identical", () => {
    savePasskeys([rec({ id: "cred-1" })]);
    const before = loadPasskeys();
    assert.equal(removePasskey("nope"), false);
    assert.deepEqual(loadPasskeys(), before);
  });

  it("a savePasskeys -> loadPasskeys round trip preserves attachment and transports", () => {
    const p = rec({
      id: "cred-1",
      attachment: "platform",
      transports: ["hybrid", "internal"],
    });
    savePasskeys([p]);
    assert.deepEqual(loadPasskeys(), [p]);
  });
});

// The registration option block is data, not behaviour, so it is asserted as
// data. Importing the route would drag next/headers and a cookie store into a
// unit test; this pins the same three fields the route sends.
describe("PLATFORM_AUTHENTICATOR_SELECTION — the three fields that decide the sheet", () => {
  it("pins the built-in authenticator", () => {
    assert.equal(PLATFORM_AUTHENTICATOR_SELECTION.authenticatorAttachment, "platform");
  });

  it("makes the biometric mandatory, not optional", () => {
    // "preferred" does not fail if user verification cannot be performed
    // (MDN). That is a passkey with no fingerprint, which is not the feature.
    assert.equal(PLATFORM_AUTHENTICATOR_SELECTION.userVerification, "required");
  });

  it("keeps the credential discoverable so login needs no username", () => {
    assert.equal(PLATFORM_AUTHENTICATOR_SELECTION.residentKey, "required");
  });
});
