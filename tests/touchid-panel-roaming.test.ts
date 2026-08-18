/**
 * isRoaming() — the single branch that decides whether Classic is ever TOLD
 * which credential is the wrong one.
 *
 * The panel's whole reason to exist is the "▲ phone / security key" flag. That
 * flag is one boolean. Nothing else in the suite pins it, so a plausible
 * "simplification" to a bare `transports.includes("hybrid")` check would pass
 * typecheck, pass lint, pass every other test, and silently stop flagging a
 * cross-platform credential that reports only `internal` — the panel would then
 * say "● this Mac" about a security key.
 *
 * Imported from the "use client" .tsx directly: tsx compiles the JSX and the
 * `"use client"` directive is an inert string literal under node:test. No DOM
 * is constructed here — the predicate is pure and the component is never
 * rendered.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRoaming } from "@/components/screens/settings/TouchIdPanel";

describe("isRoaming — which credential summons the phone instead of the finger", () => {
  it("flags the record actually on disk today: no attachment, hybrid transport", () => {
    // data/passkeys.json as of 2026-08-18 — written 7/31, before the
    // `attachment` field existed. `hybrid` IS the QR-your-phone channel.
    // If this ever returns false, Classic stops being told which one is bad.
    assert.equal(
      isRoaming({
        id: "G7Box6hC8lj5Tu7cu3mYQAssBV4",
        label: "Passkey · 7/31/2026",
        attachment: null,
        transports: ["hybrid", "internal"],
        createdAt: 1785541362931,
      }),
      true,
    );
  });

  it("does not flag a real platform credential", () => {
    assert.equal(
      isRoaming({
        id: "platform-1",
        label: "Touch ID · 8/18/2026",
        attachment: "platform",
        transports: ["internal"],
        createdAt: 0,
      }),
      false,
    );
  });

  it("flags a cross-platform credential even when it reports only `internal`", () => {
    // The case a hybrid-only check misses: the authenticator declares itself
    // cross-platform but advertises no hybrid transport. Still not this Mac.
    assert.equal(
      isRoaming({
        id: "roaming-1",
        label: "Passkey · 8/18/2026",
        attachment: "cross-platform",
        transports: ["internal"],
        createdAt: 0,
      }),
      true,
    );
  });
});
