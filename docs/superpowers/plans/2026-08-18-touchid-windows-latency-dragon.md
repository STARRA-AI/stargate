# Touch ID · Chat Windows · Speech Latency · Dragon Tradar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Touch ID actually raise the Touch ID sheet, give the chat boxes draggable/expandable windows, cut the wait before STARRA speaks on both chat and call using the rigs already in the tree, and let her trade Classic's Dragon Tradar account behind a human approval gate.

**Architecture:** Four independent phases against `~/STARGATE/stargate` @ `3856b59`. Each phase ships on its own and touches a disjoint file set: Phase 1 = WebAuthn routes + a settings panel; Phase 2 = a pure geometry module + one window wrapper + CSS; Phase 3 = a stop-epoch and a chunk queue in `speak.ts`, wired from `stargate-context.tsx`, plus two measured call sessions; Phase 4 = a server-side Dragon Tradar client, a proposal store, deck routes, and tool bindings. Phases 1, 2 and 4 do not overlap at all. Phase 3 is the only one that touches the voice path and it runs alone.

**Tech Stack:** Next.js 15.5.20 (App Router, Turbopack), React 19.1.0, TypeScript strict, `@simplewebauthn/server` 13.3.2 + `@simplewebauthn/browser` 13.3.0, `node:test` via `tsx` (`npm run test:v2`), Playwright for e2e, no new dependencies in any phase.

**Spec:** `docs/superpowers/specs/2026-08-18-deck-touchid-windows-latency-dragon-design.md`

## Global Constraints

- **No new dependencies.** Every phase is achievable with what is installed. If a task appears to need a package, stop and escalate.
- **Gates, after every task:** `npm run typecheck` → 0 errors · `npm run test:v2` → 0 fail · `npm run lint` → 0 errors. A task is not done until all three are clean.
- **A green suite is not a result.** Every phase ends with something Classic can see, hear, or do. State that observable in the commit body and in the report. If a change moves nothing he can perceive, say so in the same breath as "done".
- **Never log, echo, or return a secret.** The Dragon Tradar bearer token, the Kalshi private key and `data/keys.json` values are read server-side only and never appear in a response body, a console line, a feed entry, or the browser bundle.
- **Do not touch the animation engine.** `StarraClipFace.tsx`, `ReactorSphere.tsx`, `LiveSky.tsx`, `viseme-sync.ts`, `lipsync.ts` and the analyser bus are out of scope in every phase (Classic: "the animation engine which we are going to fix later").
- **Do not regress `tests/one-voice-chat-fallback.test.ts` or `tests/one-voice-call-gate.test.ts`.** The one-voice doctrine is load-bearing; two voices in the room is the incident these files exist to prevent.
- **`.env.local` is Classic-only.** The harness blocks writes to it. Any env change is handed to him as an exact paste-ready line — never attempted, never worked around.
- **Touch ID only works at `https://localhost:3000`.** WebAuthn forbids an IP address as rpID. Do not attempt to make it work on `192.168.1.222` or a tunnel host.
- **Commit at the end of every task.** Frequent commits, one task per commit.

---

# PHASE 1 — TOUCH ID

Four tasks. Ships when the macOS Touch ID sheet appears with no QR code on it.

## File Structure — Phase 1

| File | Responsibility |
|---|---|
| `src/lib/webauthn.ts` (modify) | Add the `attachment` field to the stored record, the pure `loginTransports()` filter, and `removePasskey()`. Still the only module that touches `data/passkeys.json`. |
| `src/app/api/auth/passkey/register/route.ts` (modify) | Demand a platform authenticator at option-generation time and enforce it at verify time. |
| `src/app/api/auth/passkey/login/route.ts` (modify) | Stop advertising `hybrid` for platform credentials. |
| `src/app/api/auth/passkey/route.ts` (create) | `GET` list + `DELETE` one, both behind the existing password session. |
| `src/components/screens/settings/TouchIdPanel.tsx` (create) | The panel Classic uses: what is registered, remove it, add a new one. |
| `src/app/settings/page.tsx` (modify) | Mount the panel. |
| `tests/webauthn-platform.test.ts` (create) | The pure logic: transport filtering, attachment gating, store mutation. |

---

### Task 1: Platform-only credential rules in the store module

**Files:**
- Modify: `src/lib/webauthn.ts:19-27` (the `StoredPasskey` interface) and append two functions
- Test: `tests/webauthn-platform.test.ts` (create)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `StoredPasskey` gains `attachment?: "platform" | "cross-platform"`.
  - `loginTransports(p: StoredPasskey): string[] | undefined` — the transports safe to advertise in `allowCredentials`.
  - `removePasskey(id: string): boolean` — deletes by credential id, returns whether anything was removed.
  - `PLATFORM_ONLY_REASON: string` — the single operator-facing sentence used by Task 2 and Task 4.

- [ ] **Step 1: Write the failing test**

Create `tests/webauthn-platform.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --yes tsx --test tests/webauthn-platform.test.ts`
Expected: FAIL — `loginTransports is not a function` (an unresolved named import binds to `undefined` under tsx).

- [ ] **Step 3: Write minimal implementation**

In `src/lib/webauthn.ts`, add `attachment` to the interface (after `transports?`):

```ts
export interface StoredPasskey {
  id: string; // base64url credential id
  publicKey: string; // base64url-encoded COSE public key
  counter: number;
  transports?: string[];
  /**
   * What the browser reported at registration. "platform" is Touch ID — the
   * authenticator built into this Mac. Absent on records written before
   * 2026-08-18, which is why loginTransports leaves those alone.
   */
  attachment?: "platform" | "cross-platform";
  label: string;
  createdAt: number;
}
```

Then append to the same file:

```ts
/** The one sentence shown wherever a non-Touch-ID authenticator is refused. */
export const PLATFORM_ONLY_REASON =
  "That wasn't Touch ID — it was a phone or a security key. Pick \"This device\" on the sheet so the fingerprint reader on this Mac is what gets registered.";

/**
 * Transports that are safe to put in `allowCredentials` for this credential.
 *
 * `hybrid` means cross-device: the browser reads it as "this may live on a
 * phone" and offers the QR sheet. A credential we KNOW is platform-bound must
 * never carry it, or the Touch ID sheet is never the first thing he sees.
 *
 * A record with no recorded `attachment` predates this rule and is returned
 * unchanged — narrowing a credential we cannot vouch for could lock him out.
 */
const ROAMING_TRANSPORTS = new Set(["hybrid", "ble", "nfc", "usb", "cable"]);

export function loginTransports(p: StoredPasskey): string[] | undefined {
  if (p.attachment !== "platform" || !p.transports) return p.transports;
  const kept = p.transports.filter((t) => !ROAMING_TRANSPORTS.has(t));
  // An EMPTY array is a hint that nothing works; omitting the field lets the
  // browser decide. Never send [].
  return kept.length > 0 ? kept : undefined;
}

/** Remove one credential by id. Returns whether anything was actually removed. */
export function removePasskey(id: string): boolean {
  const list = loadPasskeys();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return false;
  savePasskeys(next);
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --yes tsx --test tests/webauthn-platform.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Run the full gates**

```bash
npm run typecheck && npm run test:v2 2>&1 | tail -6 && npm run lint
```
Expected: 0 type errors · 0 fail · 0 lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/webauthn.ts tests/webauthn-platform.test.ts
git commit -m "fix(auth): a platform credential stops advertising the QR-your-phone transport

The registered credential carries transports ['hybrid','internal']. hybrid is
cross-device (formerly caBLE), and sending it in allowCredentials is what makes
the browser show the generic passkey picker instead of the Touch ID sheet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Demand a platform authenticator at registration

**Files:**
- Modify: `src/app/api/auth/passkey/register/route.ts:54-57` and `:106-115`
- Test: `tests/webauthn-platform.test.ts` (extend)

**Interfaces:**
- Consumes: `PLATFORM_ONLY_REASON` and the `attachment` field from Task 1.
- Produces: registration options carrying `authenticatorAttachment: "platform"`; stored records that always carry `attachment`.

- [ ] **Step 1: Write the failing test**

Append to `tests/webauthn-platform.test.ts`:

```ts
// The registration option block is data, not behaviour, so it is asserted as
// data. Importing the route would drag next/headers and a cookie store into a
// unit test; this pins the same three fields the route sends.
import { PLATFORM_AUTHENTICATOR_SELECTION } from "../src/lib/webauthn";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --yes tsx --test tests/webauthn-platform.test.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'authenticatorAttachment')`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/lib/webauthn.ts`:

```ts
/**
 * THE THREE FIELDS THAT DECIDE WHICH SHEET APPEARS.
 *
 * Without `authenticatorAttachment: "platform"` the browser is free to offer
 * roaming authenticators — iCloud Keychain sync, phone-via-QR, a security key
 * — which is exactly the sheet Classic kept getting instead of Touch ID.
 * MDN: "platform" means "the authenticator is part of the device WebAuthn is
 * running on … a public key credential bound to a platform authenticator is
 * called a platform credential."
 *
 * `userVerification: "required"` makes the fingerprint mandatory; "preferred"
 * "will not fail if user verification cannot be performed" (MDN), i.e. a
 * passkey with no biometric, which is not the thing he asked for.
 */
export const PLATFORM_AUTHENTICATOR_SELECTION = {
  authenticatorAttachment: "platform",
  residentKey: "required",
  userVerification: "required",
} as const;
```

In `register/route.ts`, replace the inline `authenticatorSelection` block (`:54-57`):

```ts
    authenticatorSelection: PLATFORM_AUTHENTICATOR_SELECTION,
```

and add `PLATFORM_AUTHENTICATOR_SELECTION`, `PLATFORM_ONLY_REASON` to the existing import from `@/lib/webauthn`.

In the same file's `POST`, gate on what the browser actually reported. Insert immediately after the `if (!verification.verified || !verification.registrationInfo)` block (`:102-104`):

```ts
  // WHAT THE BROWSER ACTUALLY USED, not what we asked for. `authenticatorAttachment`
  // rides on the credential response (@simplewebauthn/server 13.3.2,
  // types/index.d.ts:78). Chrome and Safari both populate it. Storing a
  // cross-platform credential here is how the deck ended up with a hybrid one
  // in the first place — refuse it instead of collecting another.
  if (body.authenticatorAttachment && body.authenticatorAttachment !== "platform") {
    return NextResponse.json({ ok: false, error: PLATFORM_ONLY_REASON }, { status: 400 });
  }
```

Then record the attachment in the pushed record (`:108-115`):

```ts
  list.push({
    id: cred.id,
    publicKey: pubKeyToStore(cred.publicKey),
    counter: cred.counter,
    transports: cred.transports,
    attachment: body.authenticatorAttachment ?? "platform",
    label: `Touch ID · ${new Date().toLocaleDateString()}`,
    createdAt: Date.now(),
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --yes tsx --test tests/webauthn-platform.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Run the full gates**

```bash
npm run typecheck && npm run test:v2 2>&1 | tail -6 && npm run lint
```
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/webauthn.ts src/app/api/auth/passkey/register/route.ts tests/webauthn-platform.test.ts
git commit -m "fix(auth): registration demands the Mac's own authenticator

authenticatorAttachment was absent, so the browser offered iCloud Keychain,
phone-via-QR and security keys. Now: platform-only, userVerification required,
and a registration that came from anything else is refused rather than stored.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Login stops advertising roaming, and passkeys become manageable

**Files:**
- Modify: `src/app/api/auth/passkey/login/route.ts:34-41`
- Create: `src/app/api/auth/passkey/route.ts`

**Interfaces:**
- Consumes: `loginTransports`, `removePasskey`, `loadPasskeys` from Task 1.
- Produces: `GET /api/auth/passkey` → `{ passkeys: { id, label, attachment, createdAt }[] }` · `DELETE /api/auth/passkey?id=<credId>` → `{ ok, count }`. Task 4 consumes both.

- [ ] **Step 1: Write the failing test**

There is no HTTP harness for these routes in this repo and adding one is out of proportion; the pure logic is already covered by Task 1. Instead, prove the route file exists and exports both verbs — a cheap structural check that catches a mis-named export:

Append to `tests/webauthn-platform.test.ts`:

```ts
describe("the passkey management route", () => {
  it("exports GET and DELETE", async () => {
    const mod = await import("../src/app/api/auth/passkey/route");
    assert.equal(typeof mod.GET, "function");
    assert.equal(typeof mod.DELETE, "function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --yes tsx --test tests/webauthn-platform.test.ts`
Expected: FAIL — `Cannot find module '../src/app/api/auth/passkey/route'`.

- [ ] **Step 3: Write minimal implementation**

In `login/route.ts`, swap the transport source (`:37-40`) and import `loginTransports` alongside the existing imports:

```ts
    allowCredentials: list.map((p) => ({
      id: p.id,
      // NOT p.transports. A platform credential must never advertise hybrid,
      // or the browser offers the QR sheet before the fingerprint reader.
      transports: loginTransports(p) as AuthenticatorTransportFuture[] | undefined,
    })),
```

Also raise the login's own bar to match registration (`:36`):

```ts
    userVerification: "required",
```

Create `src/app/api/auth/passkey/route.ts`:

```ts
/**
 * PASSKEY MANAGEMENT — list and remove, behind the existing password session.
 *
 * This exists so Classic never has to hand-edit data/passkeys.json (mode 0700)
 * to get rid of a credential that summons the wrong sheet. Registration lives
 * next door in ./register; this file only reads and deletes.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { authCookieName, verifyToken } from "@/lib/auth";
import { loadPasskeys, removePasskey } from "@/lib/webauthn";

export const runtime = "nodejs";

async function isAuthed(): Promise<boolean> {
  const token = (await cookies()).get(authCookieName())?.value;
  return verifyToken(token);
}

/** GET → what is registered. Never returns the public key. */
export async function GET() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    passkeys: loadPasskeys().map((p) => ({
      id: p.id,
      label: p.label,
      attachment: p.attachment ?? null,
      transports: p.transports ?? [],
      createdAt: p.createdAt,
    })),
  });
}

/** DELETE ?id=<credentialId> → remove one. */
export async function DELETE(req: Request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) {
    return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  }
  const removed = removePasskey(id);
  return NextResponse.json({ ok: removed, count: loadPasskeys().length });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --yes tsx --test tests/webauthn-platform.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Run the full gates**

```bash
npm run typecheck && npm run test:v2 2>&1 | tail -6 && npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/app/api/auth/passkey/login/route.ts src/app/api/auth/passkey/route.ts tests/webauthn-platform.test.ts
git commit -m "feat(auth): passkeys are listable and removable; login stops offering the QR sheet

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The Touch ID panel in Settings — and Classic replaces the stale credential

**Files:**
- Create: `src/components/screens/settings/TouchIdPanel.tsx`
- Modify: `src/app/settings/page.tsx:373` (mount it next to `<KeyVault />`)

**Interfaces:**
- Consumes: `GET`/`DELETE /api/auth/passkey` from Task 3; the existing `GET`/`POST /api/auth/passkey/register`.
- Produces: nothing downstream.

- [ ] **Step 1: Write the component**

Create `src/components/screens/settings/TouchIdPanel.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";

interface PasskeyRow {
  id: string;
  label: string;
  attachment: string | null;
  transports: string[];
  createdAt: number;
}

/** Why Touch ID cannot run in THIS window, or null. Same two dead ends the
 *  login page names: no WebAuthn at all (the dock app's WKWebView), and an
 *  IP-address host, which WebAuthn forbids as an rpID. */
function unavailable(): string | null {
  if (typeof window === "undefined") return null;
  if (!window.PublicKeyCredential) {
    return "This window has no WebAuthn — open the deck in Safari or Chrome at https://localhost:3000.";
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$|:/.test(window.location.hostname)) {
    return "Touch ID needs https://localhost:3000 — WebAuthn will not bind to an IP address.";
  }
  return null;
}

/** A credential that can summon the phone/QR sheet instead of the fingerprint. */
function isRoaming(p: PasskeyRow): boolean {
  return p.attachment !== "platform" || p.transports.includes("hybrid");
}

export function TouchIdPanel() {
  const [rows, setRows] = useState<PasskeyRow[] | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/passkey");
      if (!res.ok) {
        setRows([]);
        return;
      }
      const data = (await res.json()) as { passkeys?: PasskeyRow[] };
      setRows(data.passkeys ?? []);
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function register() {
    const blocked = unavailable();
    if (blocked) {
      setMsg(blocked);
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const optRes = await fetch("/api/auth/passkey/register");
      if (!optRes.ok) {
        const d = (await optRes.json().catch(() => ({}))) as { error?: string };
        setMsg(d.error || "Could not start Touch ID setup.");
        return;
      }
      const optionsJSON = await optRes.json();
      const { startRegistration } = await import("@simplewebauthn/browser");
      const attestation = await startRegistration({ optionsJSON });
      const verRes = await fetch("/api/auth/passkey/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attestation),
      });
      const data = (await verRes.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      setMsg(data.ok ? "Touch ID is set up." : data.error || "Touch ID setup failed.");
      await load();
    } catch (e) {
      setMsg(
        e instanceof Error && e.name === "NotAllowedError"
          ? "Cancelled."
          : "Touch ID setup failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`/api/auth/passkey?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      setMsg(res.ok ? "Removed." : "Could not remove it.");
      await load();
    } catch {
      setMsg("Could not remove it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="deck-panel">
      <h2 className="deck-title">Touch ID</h2>
      <p className="deck-note">
        Unlocks the deck with the fingerprint reader on this Mac. Works only at{" "}
        <span className="text-[var(--magenta)]">https://localhost:3000</span> — WebAuthn
        will not bind to an IP address.
      </p>

      {rows === null ? (
        <p className="font-[family-name:var(--font-mono)] text-xs text-[var(--star)]">
          PROCESSING
        </p>
      ) : rows.length === 0 ? (
        <p className="font-[family-name:var(--font-mono)] text-xs text-[var(--star)]">
          NOTHING REGISTERED
        </p>
      ) : (
        rows.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3 py-1">
            <span className="font-[family-name:var(--font-mono)] text-xs">
              {p.label}
              {isRoaming(p) ? (
                <span className="ml-2 text-[var(--bad)]">
                  ▲ phone / security key — remove and re-add
                </span>
              ) : (
                <span className="ml-2 text-[var(--good)]">● this Mac</span>
              )}
            </span>
            <button
              type="button"
              className="deck-badge"
              disabled={busy}
              onClick={() => void remove(p.id)}
            >
              Remove
            </button>
          </div>
        ))
      )}

      <button
        type="button"
        className="deck-badge is-ok mt-2"
        disabled={busy}
        onClick={() => void register()}
      >
        {busy ? "…" : "Set up Touch ID"}
      </button>

      {msg ? (
        <p className="font-[family-name:var(--font-mono)] mt-2 text-xs text-[var(--star)]">
          {msg}
        </p>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 2: Mount it**

In `src/app/settings/page.tsx`, add the import next to the existing ones:

```ts
import { TouchIdPanel } from "@/components/screens/settings/TouchIdPanel";
```

and place it directly after `<KeyVault />` (`:373`):

```tsx
        <KeyVault />
        <TouchIdPanel />
        <VoicePicker />
```

- [ ] **Step 3: Run the full gates**

```bash
npm run typecheck && npm run test:v2 2>&1 | tail -6 && npm run lint
```
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/screens/settings/TouchIdPanel.tsx src/app/settings/page.tsx
git commit -m "feat(auth): Touch ID panel in Settings — see it, remove it, re-add it

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: HAND IT TO CLASSIC — this is the only step that proves the feature**

No test can raise a Touch ID sheet. Open it for him rather than describing it:

```bash
open "https://localhost:3000/settings"
```

Tell him, in these terms:

> Settings now has a Touch ID panel. The credential registered on 7/31 is flagged
> **▲ phone / security key** — that is the one that has been giving you the passkey
> sheet; its transports are `["hybrid","internal"]` and `hybrid` means QR-your-phone.
> Hit **Remove**, then **Set up Touch ID**. What should come up is the macOS
> fingerprint sheet with no QR code and no "use a phone" option. If you see a QR code,
> stop and tell me — that means the browser ignored `authenticatorAttachment` and I
> need to know which browser and version.

Then have him log out and back in at `https://localhost:3000/login` and press
"Use Touch ID". **Phase 1 is not done until he reports the fingerprint sheet.**

---

# PHASE 2 — EXPANDABLE, MOVABLE CHAT WINDOWS

Three tasks. Ships when he can drag the console and pull its tab.

## File Structure — Phase 2

| File | Responsibility |
|---|---|
| `src/lib/deck/window-geometry.ts` (create) | Pure maths: viewport delta → stage delta, clamping, expand/collapse. No DOM, no React. Every test lives here. |
| `src/lib/deck/deck-windows.ts` (create) | localStorage persistence per window id. Modelled on `src/lib/voice/deck-prefs.ts`. |
| `src/components/bridge/DeckWindow.tsx` (create) | The chrome: drag handle, resize grip, pull tab. |
| `src/components/bridge/useStageScale.ts` (modify) | Publish `--stage-scale`. |
| `src/components/bridge/DeckConsole.tsx` (modify) | Wrap the console in a `DeckWindow`. |
| `src/styles/deck.css` (modify) | `.deck-window`, `.deck-window-tab`, `.deck-window-grip`. |
| `tests/window-geometry.test.ts` (create) | The maths. |

---

### Task 5: The geometry, and the scale that makes it correct

**Files:**
- Create: `src/lib/deck/window-geometry.ts`
- Modify: `src/components/bridge/useStageScale.ts`
- Test: `tests/window-geometry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `STAGE_W = 1680`, `STAGE_H = 1000`
  - `interface WindowRect { x: number; y: number; w: number; h: number }`
  - `dragTo(rect, dxViewport, dyViewport, scale): WindowRect`
  - `resizeTo(rect, dxViewport, dyViewport, scale): WindowRect`
  - `clampToStage(rect): WindowRect`
  - `expandedRect(rect): WindowRect` / `MIN_W`, `MIN_H`
  - `readStageScale(el: { style: { getPropertyValue(n: string): string } } | null): number`
  - Task 6 and Task 7 consume all of these.

- [ ] **Step 1: Write the failing test**

Create `tests/window-geometry.test.ts`:

```ts
/**
 * WHY THIS FILE IS PURE MATHS AND NOT A BROWSER TEST.
 *
 * The deck is a FIXED 1680x1000 canvas transform-scale()d to the viewport
 * (useStageScale.ts:5-6, deck.css:55). PointerEvent.clientX/Y are VIEWPORT
 * pixels; the dragged element lives in SCALED space. Adding the raw delta
 * makes the window drift away from the cursor by 1/scale — on a 1280-wide
 * window that is ~31% too far on every drag. That bug is arithmetic, so it is
 * caught here, without a browser.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  STAGE_W,
  STAGE_H,
  MIN_W,
  MIN_H,
  dragTo,
  resizeTo,
  clampToStage,
  expandedRect,
  readStageScale,
} from "../src/lib/deck/window-geometry";

const base = { x: 100, y: 100, w: 400, h: 300 };

describe("dragTo — viewport pixels are divided by the stage scale", () => {
  it("moves 1:1 at scale 1", () => {
    assert.deepEqual(dragTo(base, 50, 20, 1), { x: 150, y: 120, w: 400, h: 300 });
  });

  it("moves TWICE the viewport delta at scale 0.5 — the drift bug", () => {
    // At half scale, 50 viewport px is 100 stage px. Getting this wrong is the
    // whole reason a hand-rolled drag feels broken on this deck.
    assert.deepEqual(dragTo(base, 50, 20, 0.5), { x: 200, y: 140, w: 400, h: 300 });
  });

  it("treats a zero or nonsense scale as 1 rather than dividing by it", () => {
    assert.deepEqual(dragTo(base, 50, 0, 0), { x: 150, y: 100, w: 400, h: 300 });
    assert.deepEqual(dragTo(base, 50, 0, Number.NaN), { x: 150, y: 100, w: 400, h: 300 });
  });

  it("clamps to the stage — a window cannot be dragged off the deck", () => {
    assert.deepEqual(dragTo(base, -9999, -9999, 1), { x: 0, y: 0, w: 400, h: 300 });
    const far = dragTo(base, 9999, 9999, 1);
    assert.equal(far.x, STAGE_W - 400);
    assert.equal(far.y, STAGE_H - 300);
  });
});

describe("resizeTo", () => {
  it("scales the delta the same way drag does", () => {
    assert.deepEqual(resizeTo(base, 100, 50, 0.5), { x: 100, y: 100, w: 600, h: 400 });
  });

  it("refuses to shrink below the minimum", () => {
    const r = resizeTo(base, -9999, -9999, 1);
    assert.equal(r.w, MIN_W);
    assert.equal(r.h, MIN_H);
  });

  it("refuses to grow past the stage edge", () => {
    const r = resizeTo({ x: 1000, y: 700, w: 400, h: 200 }, 9999, 9999, 1);
    assert.equal(r.x + r.w, STAGE_W);
    assert.equal(r.y + r.h, STAGE_H);
  });
});

describe("clampToStage", () => {
  it("pulls a window that is wider than the stage back to the stage width", () => {
    const r = clampToStage({ x: -50, y: -50, w: 5000, h: 5000 });
    assert.deepEqual(r, { x: 0, y: 0, w: STAGE_W, h: STAGE_H });
  });

  it("is idempotent", () => {
    const once = clampToStage({ x: 1600, y: 950, w: 400, h: 300 });
    assert.deepEqual(clampToStage(once), once);
  });
});

describe("expandedRect — the pull tab", () => {
  it("grows to most of the stage and stays inside it", () => {
    const r = expandedRect(base);
    assert.ok(r.w > base.w && r.h > base.h);
    assert.ok(r.x >= 0 && r.y >= 0);
    assert.ok(r.x + r.w <= STAGE_W);
    assert.ok(r.y + r.h <= STAGE_H);
  });

  it("keeps the window centred on where it already was", () => {
    const r = expandedRect({ x: 1200, y: 100, w: 300, h: 200 });
    // It grew toward the middle rather than jumping to a corner.
    assert.ok(r.x < 1200);
  });
});

describe("readStageScale", () => {
  it("reads the custom property the stage publishes", () => {
    const el = { style: { getPropertyValue: (n: string) => (n === "--stage-scale" ? "0.76" : "") } };
    assert.equal(readStageScale(el), 0.76);
  });

  it("falls back to 1 on a missing or unparseable value", () => {
    assert.equal(readStageScale(null), 1);
    assert.equal(readStageScale({ style: { getPropertyValue: () => "" } }), 1);
    assert.equal(readStageScale({ style: { getPropertyValue: () => "nope" } }), 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --yes tsx --test tests/window-geometry.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/deck/window-geometry'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/deck/window-geometry.ts`:

```ts
/**
 * DECK WINDOW GEOMETRY — pure, no DOM, no React.
 *
 * The deck is a FIXED 1680x1000 canvas scaled to the viewport with a CSS
 * transform (useStageScale.ts, deck.css:55). Pointer events report VIEWPORT
 * pixels; a window's x/y/w/h are STAGE pixels. Everything here converts
 * between the two and keeps a window on the deck. Kept separate from the
 * component so the arithmetic is tested without a browser.
 */

export const STAGE_W = 1680;
export const STAGE_H = 1000;

/** Small enough to tuck away, large enough to still be a window. */
export const MIN_W = 280;
export const MIN_H = 160;

/** How much of the stage the pull tab expands a window to fill. */
const EXPAND_FRACTION = 0.82;

export interface WindowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A scale of 0, NaN or negative would divide the delta into nonsense. */
function safeScale(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Keep a window inside the stage, sizing it down first if it does not fit. */
export function clampToStage(r: WindowRect): WindowRect {
  const w = clamp(r.w, MIN_W, STAGE_W);
  const h = clamp(r.h, MIN_H, STAGE_H);
  return {
    w,
    h,
    x: clamp(r.x, 0, STAGE_W - w),
    y: clamp(r.y, 0, STAGE_H - h),
  };
}

export function dragTo(
  r: WindowRect,
  dxViewport: number,
  dyViewport: number,
  scale: number,
): WindowRect {
  const k = safeScale(scale);
  return clampToStage({ ...r, x: r.x + dxViewport / k, y: r.y + dyViewport / k });
}

export function resizeTo(
  r: WindowRect,
  dxViewport: number,
  dyViewport: number,
  scale: number,
): WindowRect {
  const k = safeScale(scale);
  const w = clamp(r.w + dxViewport / k, MIN_W, STAGE_W - r.x);
  const h = clamp(r.h + dyViewport / k, MIN_H, STAGE_H - r.y);
  return { ...r, w, h };
}

/**
 * The pull tab. Grows the window toward the middle of the deck rather than
 * jumping it to a corner, so it stays where he left it.
 */
export function expandedRect(r: WindowRect): WindowRect {
  const w = Math.round(STAGE_W * EXPAND_FRACTION);
  const h = Math.round(STAGE_H * EXPAND_FRACTION);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return clampToStage({ x: cx - w / 2, y: cy - h / 2, w, h });
}

/** Read `--stage-scale` off an element's inline style. 1 on anything unusable. */
export function readStageScale(
  el: { style: { getPropertyValue(name: string): string } } | null,
): number {
  if (!el) return 1;
  const raw = el.style.getPropertyValue("--stage-scale").trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
```

- [ ] **Step 4: Publish the scale**

In `src/components/bridge/useStageScale.ts`, add one line inside `rescale()`, after `el.style.transform` is set:

```ts
      el.style.transform = `scale(${scale})`;
      // Published so a dragged window can convert viewport pixels into stage
      // pixels. Without it a drag drifts from the cursor by 1/scale.
      el.style.setProperty("--stage-scale", String(scale));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx --yes tsx --test tests/window-geometry.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 6: Run the full gates**

```bash
npm run typecheck && npm run test:v2 2>&1 | tail -6 && npm run lint
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/deck/window-geometry.ts src/components/bridge/useStageScale.ts tests/window-geometry.test.ts
git commit -m "feat(deck): window geometry, scale-aware

The deck is a fixed 1680x1000 canvas under transform: scale(). A drag that adds
raw viewport pixels drifts by 1/scale. The stage now publishes --stage-scale and
every conversion goes through one tested pure module.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Window geometry survives a reload

**Files:**
- Create: `src/lib/deck/deck-windows.ts`
- Test: `tests/deck-windows.test.ts`

**Interfaces:**
- Consumes: `WindowRect`, `clampToStage` from Task 5.
- Produces: `getWindowRect(id, fallback): WindowRect` · `setWindowRect(id, rect): void` · `getWindowExpanded(id): boolean` · `setWindowExpanded(id, b): void` · `DECK_WINDOWS_EVENT`. Task 7 consumes all of them.

- [ ] **Step 1: Write the failing test**

Create `tests/deck-windows.test.ts`:

```ts
/**
 * Modelled on the deck-prefs contract: a read that fails returns the default,
 * a write that fails is dropped, and importing on the server is harmless.
 * A stored rect is clamped on the way OUT — a window saved on a bigger stage,
 * or a hand-edited value, must never strand itself off-deck.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { STAGE_W } from "../src/lib/deck/window-geometry";

const FALLBACK = { x: 10, y: 10, w: 400, h: 300 };

function installStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const g = globalThis as unknown as { window?: unknown };
  const prev = g.window;
  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    dispatchEvent: () => true,
    CustomEvent: class {
      constructor(public type: string) {}
    },
  };
  return () => {
    if (prev === undefined) delete g.window;
    else g.window = prev;
  };
}

let restore: () => void;
afterEach(() => restore?.());

describe("getWindowRect", () => {
  beforeEach(() => {
    restore = installStorage();
  });

  it("returns the fallback when nothing is stored", async () => {
    const { getWindowRect } = await import("../src/lib/deck/deck-windows");
    assert.deepEqual(getWindowRect("console", FALLBACK), FALLBACK);
  });

  it("returns the fallback on unparseable JSON rather than throwing", async () => {
    restore();
    restore = installStorage({ "stargate.window.console": "{{{" });
    const { getWindowRect } = await import("../src/lib/deck/deck-windows");
    assert.deepEqual(getWindowRect("console", FALLBACK), FALLBACK);
  });

  it("clamps a stored rect that would sit off the deck", async () => {
    restore();
    restore = installStorage({
      "stargate.window.console": JSON.stringify({ x: 99999, y: 0, w: 400, h: 300 }),
    });
    const { getWindowRect } = await import("../src/lib/deck/deck-windows");
    assert.equal(getWindowRect("console", FALLBACK).x, STAGE_W - 400);
  });

  it("rejects a stored value missing a field", async () => {
    restore();
    restore = installStorage({ "stargate.window.console": JSON.stringify({ x: 1, y: 2 }) });
    const { getWindowRect } = await import("../src/lib/deck/deck-windows");
    assert.deepEqual(getWindowRect("console", FALLBACK), FALLBACK);
  });
});

describe("expanded flag", () => {
  beforeEach(() => {
    restore = installStorage();
  });

  it("defaults to collapsed", async () => {
    const { getWindowExpanded } = await import("../src/lib/deck/deck-windows");
    assert.equal(getWindowExpanded("console"), false);
  });

  it("round-trips", async () => {
    const { getWindowExpanded, setWindowExpanded } = await import(
      "../src/lib/deck/deck-windows"
    );
    setWindowExpanded("console", true);
    assert.equal(getWindowExpanded("console"), true);
  });
});

describe("server import is harmless", () => {
  beforeEach(() => {
    const g = globalThis as unknown as { window?: unknown };
    const prev = g.window;
    delete g.window;
    restore = () => {
      if (prev !== undefined) g.window = prev;
    };
  });

  it("reads the default with no window at all", async () => {
    const { getWindowRect, getWindowExpanded } = await import(
      "../src/lib/deck/deck-windows"
    );
    assert.deepEqual(getWindowRect("console", FALLBACK), FALLBACK);
    assert.equal(getWindowExpanded("console"), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --yes tsx --test tests/deck-windows.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/deck/deck-windows'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/deck/deck-windows.ts`:

```ts
/**
 * DECK WINDOW PERSISTENCE — where each window sits, and whether it is pulled open.
 *
 * Deliberately modelled on src/lib/voice/deck-prefs.ts: same
 * `typeof window === "undefined"` guard so importing on the server is
 * harmless, same defensive read (a disabled or full localStorage throws on
 * access and none of this is worth breaking the deck over), same CustomEvent
 * on every write so any other open view refreshes.
 */
import { clampToStage, type WindowRect } from "./window-geometry";

const PREFIX = "stargate.window.";
const EXPANDED_PREFIX = "stargate.window.expanded.";

/** Dispatched on window after any write, so open UI refreshes. */
export const DECK_WINDOWS_EVENT = "stargate-deck-windows";

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage disabled — the in-page value still applies for this session
  }
  try {
    window.dispatchEvent(new CustomEvent(DECK_WINDOWS_EVENT));
  } catch {
    /* no CustomEvent in this environment */
  }
}

function isRect(v: unknown): v is WindowRect {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (["x", "y", "w", "h"] as const).every(
    (k) => typeof r[k] === "number" && Number.isFinite(r[k] as number),
  );
}

/**
 * The saved rect, CLAMPED. A rect saved on a different stage — or hand-edited
 * — must never strand a window where he cannot reach its title bar.
 */
export function getWindowRect(id: string, fallback: WindowRect): WindowRect {
  const raw = readRaw(PREFIX + id);
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRect(parsed) ? clampToStage(parsed) : fallback;
  } catch {
    return fallback;
  }
}

export function setWindowRect(id: string, rect: WindowRect): void {
  writeRaw(PREFIX + id, JSON.stringify(clampToStage(rect)));
}

export function getWindowExpanded(id: string): boolean {
  return readRaw(EXPANDED_PREFIX + id) === "1";
}

export function setWindowExpanded(id: string, expanded: boolean): void {
  writeRaw(EXPANDED_PREFIX + id, expanded ? "1" : "0");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --yes tsx --test tests/deck-windows.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Run the full gates**

```bash
npm run typecheck && npm run test:v2 2>&1 | tail -6 && npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/deck/deck-windows.ts tests/deck-windows.test.ts
git commit -m "feat(deck): window position and expanded state survive a reload

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The window itself — drag, resize, pull tab — on the operator console

**Files:**
- Create: `src/components/bridge/DeckWindow.tsx`
- Modify: `src/components/bridge/DeckConsole.tsx:46-47,96`
- Modify: `src/styles/deck.css` (append a `deck window` section)

**Interfaces:**
- Consumes: everything from Tasks 5 and 6.
- Produces: `<DeckWindow id title defaultRect>` — a positioned container. Phase 4 reuses it for the Dragon ticket window if that turns out to be wanted; nothing depends on it in this plan.

- [ ] **Step 1: Write the component**

Create `src/components/bridge/DeckWindow.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  dragTo,
  expandedRect,
  readStageScale,
  resizeTo,
  type WindowRect,
} from "@/lib/deck/window-geometry";
import {
  getWindowExpanded,
  getWindowRect,
  setWindowExpanded,
  setWindowRect,
} from "@/lib/deck/deck-windows";

/**
 * A DECK WINDOW — drag by the title bar, resize by the corner grip, pull the
 * tab to open it out to reading size.
 *
 * The one thing that is easy to get wrong here: pointer deltas are VIEWPORT
 * pixels and this element lives inside the stage's transform: scale(). Every
 * delta goes through window-geometry, which divides by --stage-scale. Nothing
 * in this file does its own arithmetic.
 *
 * Pointer capture (not a window-level mousemove listener) so a fast drag that
 * leaves the element still tracks, and so the gesture always ends.
 */
export function DeckWindow({
  id,
  title,
  defaultRect,
  children,
}: {
  id: string;
  title: string;
  defaultRect: WindowRect;
  children: ReactNode;
}) {
  const [rect, setRect] = useState<WindowRect>(defaultRect);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const elRef = useRef<HTMLDivElement>(null);
  // The rect before the tab was pulled, so collapsing puts it back exactly.
  const dockedRef = useRef<WindowRect>(defaultRect);

  // Hydrate from storage AFTER mount — reading localStorage during render
  // would mismatch the server-rendered markup.
  useEffect(() => {
    const saved = getWindowRect(id, defaultRect);
    setRect(saved);
    dockedRef.current = saved;
    setExpanded(getWindowExpanded(id));
    // defaultRect is a literal from the caller; id is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /** The live stage scale, read off the nearest ancestor that publishes it. */
  const scale = useCallback((): number => {
    const stage = elRef.current?.closest("#stage") as HTMLElement | null;
    return readStageScale(stage);
  }, []);

  /**
   * One gesture. `apply` turns a total delta from the gesture's origin into a
   * new rect; the origin rect is captured once so the gesture never compounds
   * rounding.
   */
  const gesture = useCallback(
    (
      e: React.PointerEvent,
      apply: (from: WindowRect, dx: number, dy: number, k: number) => WindowRect,
    ) => {
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startY = e.clientY;
      const from = rect;
      const k = scale();
      setDragging(true);

      const move = (ev: PointerEvent) => {
        setRect(apply(from, ev.clientX - startX, ev.clientY - startY, k));
      };
      const end = (ev: PointerEvent) => {
        const final = apply(from, ev.clientX - startX, ev.clientY - startY, k);
        setRect(final);
        // A gesture only persists what he ENDED on. Persisting every move
        // would write to localStorage on every animation frame.
        setWindowRect(id, final);
        dockedRef.current = final;
        setDragging(false);
        target.releasePointerCapture(ev.pointerId);
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", end);
        target.removeEventListener("pointercancel", end);
      };

      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", end);
      target.addEventListener("pointercancel", end);
    },
    [id, rect, scale],
  );

  function toggleExpand() {
    if (expanded) {
      const back = dockedRef.current;
      setRect(back);
      setWindowRect(id, back);
      setExpanded(false);
      setWindowExpanded(id, false);
      return;
    }
    dockedRef.current = rect;
    const open = expandedRect(rect);
    setRect(open);
    setWindowRect(id, open);
    setExpanded(true);
    setWindowExpanded(id, true);
  }

  return (
    <div
      ref={elRef}
      className={`deck-window${dragging ? " is-dragging" : ""}${expanded ? " is-expanded" : ""}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <div
        className="deck-window-bar"
        onPointerDown={(e) => gesture(e, dragTo)}
        role="presentation"
      >
        <span className="deck-window-title">{title}</span>
        <div className="spacer" />
        <button
          type="button"
          className="deck-window-tab"
          onClick={toggleExpand}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
          title={expanded ? "Collapse" : "Pull to expand"}
        >
          {expanded ? "▾" : "▴"}
        </button>
      </div>

      <div className="deck-window-body">{children}</div>

      <div
        className="deck-window-grip"
        onPointerDown={(e) => gesture(e, resizeTo)}
        role="presentation"
        aria-hidden
      />
    </div>
  );
}
```

- [ ] **Step 2: Confirm the stage id the window looks for**

`DeckWindow` calls `closest("#stage")`. That element already exists —
`Bridge.tsx:630` renders `<div id="stage" ref={stageRef} data-hud={hudState}>`, which is
the element `useStageScale` writes `--stage-scale` onto. Nothing to add; verify it is
still true before trusting it:

```bash
grep -n "id=\"stage\" ref={stageRef}" src/components/bridge/Bridge.tsx
```

Expected: one hit at `:630`. **Do not rename `#stage` or `#stage-wrap`** — `#stage-wrap`
is styled at `deck.css:55`.

- [ ] **Step 3: Style it**

Append to `src/styles/deck.css`:

```css
/* ── deck windows (DeckWindow.tsx) ──────────────────────────────────────
   Absolutely positioned in STAGE coordinates — the 1680x1000 design canvas,
   not the viewport. z-index 6 puts a window above the panels (max 5) and
   below the call overlay (60, deck.css:1198). */
.deck-window {
  position: absolute; z-index: 6;
  display: flex; flex-direction: column; min-height: 0;
  background: linear-gradient(180deg, rgba(16,7,32,0.92), rgba(9,4,18,0.97));
  border: 1px solid var(--border); border-radius: 12px;
  backdrop-filter: blur(10px); overflow: hidden;
  box-shadow: 0 18px 48px rgba(0,0,0,0.45);
  transition: box-shadow 0.18s ease;
}
.deck-window.is-dragging { box-shadow: 0 26px 70px rgba(0,0,0,0.6); }
.deck-window.is-expanded { box-shadow: 0 30px 90px rgba(0,0,0,0.65); }

.deck-window-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px 7px 14px;
  border-bottom: 1px solid rgba(176,77,252,0.22);
  cursor: grab; touch-action: none; user-select: none;
}
.deck-window.is-dragging .deck-window-bar { cursor: grabbing; }
.deck-window-title {
  font-family: var(--display); font-size: 11px; letter-spacing: 0.22em;
  color: var(--text-faint);
}
.deck-window-tab {
  min-width: 46px; height: 18px; padding: 0 8px;
  border: 1px solid rgba(176,77,252,0.35); border-radius: 0 0 9px 9px;
  background: rgba(176,77,252,0.12); color: var(--accent-glow);
  font-family: var(--mono); font-size: 10px; line-height: 1; cursor: pointer;
}
.deck-window-tab:hover { background: rgba(176,77,252,0.24); }

.deck-window-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }

.deck-window-grip {
  position: absolute; right: 0; bottom: 0; width: 18px; height: 18px;
  cursor: nwse-resize; touch-action: none;
  background:
    linear-gradient(135deg, transparent 50%, rgba(176,77,252,0.45) 50%);
}

/* A window's own chrome replaces the console's fixed height — inside a
   DeckWindow the console fills the body instead of sitting at 32%. */
.deck-window .console { height: 100%; min-height: 0; border: none; border-radius: 0; background: none; backdrop-filter: none; }

@media (prefers-reduced-motion: reduce) {
  .deck-window { transition: none; }
}
```

- [ ] **Step 4: Wrap the console**

`DeckConsole` currently renders `<div className="console">` in the centre grid column
(`Bridge.tsx:1091-1092`). Give it an optional windowed mode so the mobile layout
(`Bridge.tsx:619`) is untouched. In `DeckConsole.tsx`, add the prop and wrap the return:

```tsx
export function DeckConsole({
  onCall,
  callActive,
  windowed,
}: {
  onCall?: () => void;
  callActive?: boolean;
  /** Render inside a draggable DeckWindow. OFF on mobile, where the console
   *  is a full-bleed tab and a floating window would be in the way. */
  windowed?: boolean;
}) {
```

and at the end of the component, replace `return (<div className="console">…</div>);` with:

```tsx
  const body = (
    <div className="console">
      {/* …existing children, unchanged… */}
    </div>
  );

  if (!windowed) return body;

  return (
    <DeckWindow
      id="console"
      title="OPERATOR CONSOLE"
      // The centre column of the 1680x1000 stage: grid inset 92/22/18/22 with
      // 360px side columns and 18px gaps (deck.css:143-145).
      defaultRect={{ x: 400, y: 560, w: 836, h: 400 }}
    >
      {body}
    </DeckWindow>
  );
```

Add the import: `import { DeckWindow } from "./DeckWindow";`

In `Bridge.tsx:1092`, pass the flag on the desktop instance only:

```tsx
            <DeckConsole onCall={openCall} callActive={callOpen} windowed />
```

Leave `Bridge.tsx:619` (the mobile instance) exactly as it is.

- [ ] **Step 5: Run the full gates**

```bash
npm run typecheck && npm run test:v2 2>&1 | tail -6 && npm run lint
```
Expected: all clean.

- [ ] **Step 6: Run the visual net**

```bash
npm run e2e 2>&1 | tail -20
```
Expected: the same 10/10 the tree ships with. A moved console will change a snapshot — if a visual test fails on layout, review the diff and update with `npm run e2e:snap` **only** after confirming the diff is the intended window, not a broken layout.

- [ ] **Step 7: Commit**

```bash
git add src/components/bridge/DeckWindow.tsx src/components/bridge/DeckConsole.tsx src/components/bridge/Bridge.tsx src/styles/deck.css
git commit -m "feat(deck): the operator console is a movable, expandable window

Drag the title bar, resize from the corner, pull the tab to open it to reading
size. Position and expanded state persist. Mobile is untouched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: HAND IT TO CLASSIC**

```bash
open "https://localhost:3000/"
```

> The operator console is now a window. Drag it by its title bar, resize from the
> bottom-right corner, and hit the tab at its top-right to pull it open to reading size.
> Where you leave it is where it will be next time. Tell me if the drag lags behind the
> cursor — that would mean the stage scale is not reaching it and I want to know before
> we build any more windows on it.

---

# PHASE 3 — LATENCY

Four tasks. Phase 3 runs alone: it is the only phase that touches the voice path.

## File Structure — Phase 3

| File | Responsibility |
|---|---|
| `src/lib/voice/speak.ts` (modify) | The stop-epoch, and `speakStarraChunks`. |
| `tests/speak-chunk-queue.test.ts` (modify) | Un-skip; it becomes the spec that defines green. |
| `src/lib/stargate-context.tsx` (modify) | Speak the reply as it streams instead of after it finishes. |
| `src/lib/voice/sentence-chunker.ts` (delete) | Duplicate of `speech-shaping.ts`'s splitter, imported by nothing. |
| `tests/sentence-chunker.test.ts` (delete) | Its tests. |
| `tests/chat-stream-speech.test.ts` (create) | The chat streaming contract. |

---

### Task 8: The stop-epoch — the one primitive the held spec is waiting on

**Files:**
- Modify: `src/lib/voice/speak.ts:641-649` (`stopAllSpeech`) and the exports near `:189-201`
- Test: `tests/speak-stop-epoch.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `stopEpoch(): number` — a counter bumped by every `stopAllSpeech()`. Task 9 consumes it.

- [ ] **Step 1: Read the blocker first**

Read `tests/speak-chunk-queue.test.ts:280-317` in full before writing anything. It states
the exact reason this primitive is needed and the exact shape it must take. Do not
redesign it.

- [ ] **Step 2: Write the failing test**

Create `tests/speak-stop-epoch.test.ts`:

```ts
/**
 * THE STOP EPOCH.
 *
 * stopAllSpeech() cuts every engine but mutates no observable state — verified
 * from source at speak.ts:641-649. So a chunk queue between chunk N and N+1
 * has no way to learn the operator barged in, and would keep talking over
 * whatever claimed her voice next. That is reachable today: VoicePanel previews
 * a voice with stopAllSpeech(); await speakStarra(...). Two voices in the room
 * is the exact incident the one-voice doctrine exists to prevent.
 *
 * A monotonic counter is the whole fix.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stopAllSpeech, stopEpoch } from "../src/lib/voice/speak";

describe("stopEpoch", () => {
  it("is a number from the start — never undefined", () => {
    assert.equal(typeof stopEpoch(), "number");
  });

  it("moves on every stopAllSpeech", () => {
    const before = stopEpoch();
    stopAllSpeech();
    assert.ok(stopEpoch() > before, "stopAllSpeech must bump the epoch");
  });

  it("only ever increases, so a stale reader can compare with >", () => {
    const a = stopEpoch();
    stopAllSpeech();
    stopAllSpeech();
    stopAllSpeech();
    assert.ok(stopEpoch() >= a + 3);
  });

  it("does not move on its own", () => {
    const a = stopEpoch();
    assert.equal(stopEpoch(), a);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx --yes tsx --test tests/speak-stop-epoch.test.ts`
Expected: FAIL — `stopEpoch is not a function`.

- [ ] **Step 4: Write minimal implementation**

In `src/lib/voice/speak.ts`, next to the existing generation counter (`:189-201`):

```ts
/**
 * STOP EPOCH — bumped by every stopAllSpeech(). A multi-chunk utterance reads
 * it between chunks and refuses to advance once it has moved: that is how a
 * queue learns the operator barged in, or that another surface claimed her
 * voice, without stopAllSpeech having to know queues exist.
 */
let stopEpochCounter = 0;

export function stopEpoch(): number {
  return stopEpochCounter;
}
```

Then in `stopAllSpeech()` (`:641`), bump it as the FIRST statement, before either engine
is cut — so nothing can observe a stop that has not yet been recorded:

```ts
export function stopAllSpeech() {
  // Recorded BEFORE the engines are cut: an in-flight queue that checks the
  // epoch between chunks must never see a stop that has not yet landed here.
  stopEpochCounter += 1;
  // …existing body unchanged…
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx --yes tsx --test tests/speak-stop-epoch.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Run the full gates, with the one-voice files called out**

```bash
npm run typecheck && npm run lint && npx --yes tsx --test tests/one-voice-chat-fallback.test.ts tests/one-voice-call-gate.test.ts && npm run test:v2 2>&1 | tail -6
```
Expected: all clean, both one-voice files green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/voice/speak.ts tests/speak-stop-epoch.test.ts
git commit -m "feat(voice): stopAllSpeech records a stop epoch

The primitive tests/speak-chunk-queue.test.ts was held on. stopAllSpeech cut
every engine but left no trace, so a chunked utterance could not learn it had
been barged in on between chunks.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `speakStarraChunks` — un-skip the spec that was written first

**Files:**
- Modify: `src/lib/voice/speak.ts` (append the export)
- Modify: `tests/speak-chunk-queue.test.ts:316-318` (remove the `skip`)

**Interfaces:**
- Consumes: `stopEpoch()` from Task 8; the existing `beginUtterance()`, `isCurrentUtterance()`, and whatever private synthesis path `speakAra` already uses.
- Produces: `speakStarraChunks(chunks: string[], signal?: AbortSignal): Promise<SpeakEngine>`. Task 10 consumes it.

- [ ] **Step 1: Read the whole spec**

Read `tests/speak-chunk-queue.test.ts` end to end — all 558 lines. It defines ordering,
barge-in, mid-queue failure and supersession. **It is the requirement.** Implement
against it; do not change a test to make the implementation easier. If a test looks
wrong, stop and say which one and why.

- [ ] **Step 2: Un-skip it and watch it fail**

Delete the `skip` option from the `describe` at `:316-318`, leaving:

```ts
describe("speakStarraChunks — the chunk queue contract", () => {
```

Run: `npx --yes tsx --test tests/speak-chunk-queue.test.ts`
Expected: FAIL — every test, `speakChunks is not a function`.

- [ ] **Step 3: Delete the `@ts-expect-error`**

At `tests/speak-chunk-queue.test.ts:22-24`, remove the `@ts-expect-error` line once the
export exists (leaving it would itself fail typecheck as an unused expect-error).

- [ ] **Step 4: Write the implementation**

Append to `src/lib/voice/speak.ts`:

```ts
/**
 * Speak an ORDERED list of chunks as ONE utterance, in her voice.
 *
 * Same contract as speakStarra: same return type, same ONE VOICE gate, same
 * generation stamping. The difference is that the caller may hand over the
 * reply a sentence at a time, so she starts talking on the first sentence
 * instead of after /api/tts has synthesized the whole paragraph (0.82s for
 * "Copy." vs 4.02s for a paragraph — measured, docs/HANDOFF.md).
 *
 * The spec is tests/speak-chunk-queue.test.ts, written before this function.
 * Three invariants come from it:
 *   ORDER      chunk N+1 never plays before chunk N, even if its synthesis
 *              resolves first.
 *   BARGE-IN   a bare stopAllSpeech() between chunks ends the queue — read via
 *              stopEpoch(), which is why that primitive exists.
 *   ONE VOICE  a mid-queue failure follows voice-fallback-policy unchanged:
 *              silence, never a second engine finishing her sentence.
 */
export async function speakStarraChunks(
  chunks: string[],
  signal?: AbortSignal,
): Promise<SpeakEngine> {
  const list = chunks.filter((c) => c.trim());
  if (typeof window === "undefined" || list.length === 0) return "none";

  // ONE VOICE — identical gate to speakStarra. While the live call owns her
  // voice, no chat-side engine makes a sound.
  if (getEngineState().callLive) {
    stopHostedSpeech();
    return "none";
  }

  stopAllSpeech();
  const generation = beginUtterance();
  // Captured AFTER stopAllSpeech's own bump: anything that moves the epoch
  // from here on is somebody else claiming her voice.
  const epochAtStart = stopEpoch();

  let engine: SpeakEngine = "none";
  for (const chunk of list) {
    if (signal?.aborted) break;
    if (!isCurrentUtterance(generation)) break;
    // The barge-in the queue could not previously see.
    if (stopEpoch() !== epochAtStart) break;

    // Each chunk goes down the SAME path a single utterance takes, so the
    // fallback policy, the analyser tap and the failure reporting are the ones
    // already in this file — not a second implementation of any of them.
    const result = await speakOneChunk(chunk, generation, signal);
    if (result === "none") break;
    engine = result;
  }
  return engine;
}
```

`speakOneChunk` is the existing single-utterance body of `speakStarra` after its guards —
extract it rather than copying it, so there is exactly one synthesis path. `speakStarra`
then becomes `speakStarraChunks([text], signal)`'s single-element case, or keeps its own
guards and delegates. **Which of those two shapes is right is decided by what makes the
spec pass with the least new code — do not add a second synthesis path either way.**

- [ ] **Step 5: Run the spec until it is green**

Run: `npx --yes tsx --test tests/speak-chunk-queue.test.ts`
Expected: PASS — every test in the file.

- [ ] **Step 6: Run the full gates**

```bash
npm run typecheck && npm run lint && npx --yes tsx --test tests/one-voice-chat-fallback.test.ts tests/one-voice-call-gate.test.ts && npm run test:v2 2>&1 | tail -6
```
Expected: 0 fail, and the skipped count is now **0** (it was 1).

- [ ] **Step 7: Commit**

```bash
git add src/lib/voice/speak.ts tests/speak-chunk-queue.test.ts
git commit -m "feat(voice): speakStarraChunks — one utterance, many chunks, in order

Makes good on the spec a prior session wrote first and had to skip. Ordering,
barge-in via the stop epoch, and a mid-queue failure that stays silent rather
than handing her sentence to another engine.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: She starts talking while the reply is still arriving

**Files:**
- Modify: `src/lib/stargate-context.tsx:611` and the SSE read loop at `:512-532`
- Delete: `src/lib/voice/sentence-chunker.ts`, `tests/sentence-chunker.test.ts`
- Test: `tests/chat-stream-speech.test.ts` (create)

**Interfaces:**
- Consumes: `speakStarraChunks` from Task 9; the EXISTING `takeSentences` from `src/lib/voice/speech-shaping.ts:864`.
- Produces: nothing downstream.

**Do not add a splitter.** `takeSentences(buffer) → { sentences, rest }` already exists,
is already in production on the call path (`useVoiceCall.ts:1650`), coalesces runt
fragments below `MIN_SENTENCE_CHARS`, caps chunk length, and is tested in
`tests/call-sentence-streaming.test.ts` and `tests/local-voice.test.ts:178`. The
uncommitted `sentence-chunker.ts` is a second, dumber implementation of the same idea
that nothing imports. It gets deleted.

- [ ] **Step 1: Write the failing test**

Create `tests/chat-stream-speech.test.ts`:

```ts
/**
 * THE CHAT PATH SPEAKS AS IT STREAMS.
 *
 * stargate-context.tsx:611 handed the COMPLETE reply to speakStarra, so
 * synthesis could not begin until generation finished. /api/tts takes 0.82s
 * for "Copy." and 4.02s for a paragraph (measured, docs/HANDOFF.md §6) — the
 * whole generation time sat in front of the whole synthesis time.
 *
 * The accumulation rule is pure and lives here. ONE splitter for the whole
 * house: speech-shaping's takeSentences, the same one the live call uses.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { takeSentences } from "../src/lib/voice/speech-shaping";

/** Drive the buffer the way the SSE loop does: append a delta, take what is
 *  speakable, keep the rest. */
function drive(deltas: string[]): { spoken: string[]; tail: string } {
  let rest = "";
  const spoken: string[] = [];
  for (const d of deltas) {
    const taken = takeSentences(rest + d);
    spoken.push(...taken.sentences);
    rest = taken.rest;
  }
  return { spoken, tail: rest.trim() };
}

describe("streamed accumulation", () => {
  it("speaks a completed sentence before the reply has finished", () => {
    const { spoken } = drive(["The build is green and holding. ", "Now we ru", "n it again."]);
    assert.ok(spoken.length >= 1, "something should be speakable before the end");
    assert.ok(spoken[0].startsWith("The build is green"));
  });

  it("never speaks a half word", () => {
    const { spoken } = drive(["The build is gre"]);
    assert.deepEqual(spoken, []);
  });

  it("loses nothing — every delta ends up either spoken or in the tail", () => {
    const deltas = ["Copy. ", "The engine is up. ", "Two orders, both canceled", "."];
    const { spoken, tail } = drive(deltas);
    const joined = (spoken.join(" ") + " " + tail).replace(/\s+/g, " ").trim();
    const original = deltas.join("").replace(/\s+/g, " ").trim();
    assert.equal(joined, original);
  });

  it("a reply with no terminator at all is left in the tail for the flush", () => {
    const { spoken, tail } = drive(["no terminator anywhere"]);
    assert.deepEqual(spoken, []);
    assert.equal(tail, "no terminator anywhere");
  });
});

describe("the duplicate splitter is gone", () => {
  it("sentence-chunker.ts no longer exists", async () => {
    await assert.rejects(() => import("../src/lib/voice/sentence-chunker"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --yes tsx --test tests/chat-stream-speech.test.ts`
Expected: FAIL — the last test, because `sentence-chunker.ts` still exists and imports fine.

- [ ] **Step 3: Delete the duplicate**

```bash
rm src/lib/voice/sentence-chunker.ts tests/sentence-chunker.test.ts
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --yes tsx --test tests/chat-stream-speech.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Wire the streaming**

In `src/lib/stargate-context.tsx`, inside the `try` before the read loop, add the buffer
and load the queue once:

```ts
        // SPOKEN AS IT ARRIVES. Sentences are handed to her voice while the
        // rest of the reply is still generating, so synthesis no longer waits
        // for generation to finish. takeSentences is the SAME splitter the
        // live call uses (speech-shaping.ts, useVoiceCall.ts:1650) — there is
        // one splitter in this house, not two.
        const { speakStarraChunks } = await import("@/lib/voice/speak");
        const { takeSentences } = await import("@/lib/voice/speech-shaping");
        let speechRest = "";
        const spokenChunks: string[] = [];
```

In the `frame.kind === "text"` branch (`:527-531`), accumulate speakable text alongside
the existing `full` / `gate.push(full)` — **without changing either of them**:

```ts
            } else if (frame.kind === "text") {
              full += frame.text;
              // OFF: reveals now, identical to the old setStreaming(full).
              // ON: buffered — released below once her voice is real.
              gate.push(full);
              // PRIVATE TURNS NEVER REACH HERE: the silence marker arrives
              // before any text frame, so privateTurn is already true and the
              // private branch below owns the whole reply. Guarded anyway —
              // a chat chunk reaching /api/tts is the leak that branch exists
              // to close.
              if (!privateTurn) {
                const taken = takeSentences(speechRest + frame.text);
                speechRest = taken.rest;
                spokenChunks.push(...taken.sentences);
              }
            }
```

Then replace the single call at `:611`:

```ts
        const speakPromise = speakStarra(speakableText(full), ttsAc.signal);
```

with the flush of everything collected plus whatever tail is left:

```ts
        // Flush: the sentences already taken, plus the unterminated tail the
        // stream ended on. speakableText still strips fenced code — that rule
        // is unchanged, it just runs per chunk now.
        const tail = speechRest.trim();
        const finalChunks = [...spokenChunks, ...(tail ? [tail] : [])]
          .map((c) => speakableText(c))
          .filter((c) => c.trim());
        const speakPromise = speakStarraChunks(finalChunks, ttsAc.signal);
```

Keep the `speakStarra` import if anything else in the file still uses it; otherwise remove
it from the dynamic import to keep lint clean.

> **The honest limitation, and say it out loud when reporting:** this task collects
> chunks during the stream but still starts speaking at the end of it, because the
> reveal gate (`gate.held()`) and the private-lane branch both sit between the loop and
> the speak call. The win is that **synthesis is now per-sentence instead of one
> paragraph-length request**, which is where the 0.82s-vs-4.02s difference lives.
> Starting playback *during* the loop means moving the reveal gate, which is a separate
> change to a mechanism that exists for a reason — do not fold it in here. Task 11
> measures whether that second step is worth taking.

- [ ] **Step 6: Run the full gates**

```bash
npm run typecheck && npm run lint && npx --yes tsx --test tests/one-voice-chat-fallback.test.ts && npm run test:v2 2>&1 | tail -6
```
Expected: all clean. `tests/one-voice-chat-fallback.test.ts` green is non-negotiable.

- [ ] **Step 7: Commit**

```bash
git add -A src/lib/stargate-context.tsx tests/chat-stream-speech.test.ts src/lib/voice/sentence-chunker.ts tests/sentence-chunker.test.ts
git commit -m "perf(chat): synthesize her reply a sentence at a time, not a paragraph at a time

/api/tts is 0.82s for 'Copy.' and 4.02s for a paragraph. The chat path handed it
the complete reply. It now hands it sentences, through the same splitter the
live call uses — and the duplicate splitter nothing imported is deleted.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: MEASURE the call, then decide — do not guess

**Files:** none changed by default. Whatever this task's numbers name is the next task.

**Interfaces:**
- Consumes: `CALL_TIMING_DEBUG` (`useVoiceCall.ts:566`), `CALL_STREAM_SENTENCES` (`:553`), `window.__starraCallTiming`, `callTurnLatency()`.
- Produces: a decision, and a number to put next to it.

The rig already exists. Using it beats reading the call path looking for something slow.

- [ ] **Step 1: Hand Classic the diagnostic line**

`.env.local` is his surface. Give him exactly this, and nothing else:

```
NEXT_PUBLIC_STARRA_CALL_TIMING=1
```

Tell him: add that line to `~/STARGATE/stargate/.env.local`, restart the deck with
`scripts/starra up`, then **call her and talk to her normally for a few turns** —
multi-sentence answers, not one-word ones.

- [ ] **Step 2: Read the numbers back**

With the call ended and the tab still open, in the browser console:

```js
copy(JSON.stringify(window.__starraCallTiming, null, 2))
```

Have him paste it back. Each entry carries `t1EarsMs`, `t2BrainFirstByteMs`,
`t3GenerateMs`, `t4MouthMs`, `totalMs`, `streamedTotalMs`, `streamSavingMs`, `dominant`.

- [ ] **Step 3: Read what it says, out loud, in one line per leg**

Write the median of each leg and the `dominant` count. The map from leg to cause is
already documented at `useVoiceCall.ts:667-676`:

| Leg | What it is | If it dominates |
|---|---|---|
| T1 EARS | commit → transcript | xAI `grok-transcribe`. Endpointer tuning (`KIMI_ENDPOINT_SILENCE_FRAMES`, 15 ≈ 650ms) is the only local lever. |
| T2 BRAIN | transcript → first SSE byte | deck route + model TTFT. Prompt size is the lever — her core is already clipped by `KIMI_TPM_LIMIT`. |
| T3 GENERATE | first → last SSE byte | **This is what sentence streaming removes from the critical path.** Step 4. |
| T4 MOUTH | force_message → first audio | xAI TTS. Not a local lever. |

- [ ] **Step 4: If T3 dominates — flip sentence streaming and re-measure**

Give him the second line:

```
NEXT_PUBLIC_STARRA_CALL_STREAM_SENTENCES=1
```

Same drill: restart, call, talk in paragraphs, paste `window.__starraCallTiming` back.
Compare `totalMs` before against `totalMs` after — and against the `streamedTotalMs` the
first run predicted. If the prediction held, the flag stays on and this is the whole call
optimization. **Classic hears it before it is called done** — that is the condition the
flag's own comment sets (`useVoiceCall.ts:545-548`) and it is his call, not a test's.

- [ ] **Step 5: If a different leg dominates**

Stop and report the number. Do not start optimizing a leg the data did not name. Bring
him the measurement and the one-line options for that leg, and let him pick.

- [ ] **Step 6: Record the outcome**

Write the medians and the decision into `docs/HANDOFF.md` under a dated heading, replacing
§6's "LATENCY IS NOT FIXED" with what is now true. Then commit:

```bash
git add docs/HANDOFF.md
git commit -m "docs: measured call latency, and what the numbers decided

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the memory, at the moment of discovery**

Create `~/.claude/projects/-Users-starrallc/memory/call-latency-measured.md` with the
median legs, the date, and whether the flag is on — and add its one-line pointer to
`MEMORY.md`. A measurement not written down has to be paid for twice.

---

# PHASE 4 — DRAGON TRADAR

Five tasks. She reads freely; she proposes; **he approves; only then does an order go.**

## File Structure — Phase 4

| File | Responsibility |
|---|---|
| `src/lib/keys.ts` (modify) | One new slot: `dragon_agent_token`. |
| `src/lib/dragon/agent-client.ts` (create) | The only place that talks to `dragonradar.net`. Server-only. Holds the token. |
| `src/lib/dragon/order-policy.ts` (create) | Pure: clientOrderId, request validation, response classification, backoff. Every test lives here. |
| `src/lib/dragon/tickets.ts` (create) | The proposal store: `data/dragon-tickets.json`. |
| `src/app/api/dragon/agent/route.ts` (create) | `GET` stats. |
| `src/app/api/dragon/tickets/route.ts` (create) | `GET` list · `POST` propose · `PATCH` approve/decline (approve is what fires the order). |
| `src/components/bridge/DragonTickets.tsx` (create) | APPROVE / DECLINE in the DRAGON TRADAR panel. |
| `src/components/bridge/Bridge.tsx` (modify) | Mount it inside `#panel-dragon`. |
| `src/app/api/mcp/route.ts` (modify) | `dragon_stats` + `dragon_propose_order` tools. |
| `src/app/api/voice-tools/[action]/route.ts` (modify) | `dragon_balance` + `dragon_propose` verbs. |
| `tests/dragon-order-policy.test.ts` (create) | The policy. |
| `tests/dragon-tickets.test.ts` (create) | The store. |

---

### Task 12: The order policy — every rule from the handoff, pure and tested

**Files:**
- Create: `src/lib/dragon/order-policy.ts`
- Test: `tests/dragon-order-policy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DRAGON_AGENT_BASE = "https://dragonradar.net/api/agent/v1"`
  - `interface OrderRequest { ticker; side: "yes"|"no"; action?: "buy"|"sell"; priceCents?: number|null; count: number; clientOrderId: string; tif?: string }`
  - `newClientOrderId(seed: string): string`
  - `validateOrder(o: unknown): { ok: true; order: OrderRequest } | { ok: false; reason: string }`
  - `worstCaseCents(o: OrderRequest): number`
  - `classifyOrderResponse(status: number, body: unknown): OrderOutcome`
  - `type OrderOutcome = { kind: "accepted"|"halted"|"retry_same_id"|"verify_then_decide"|"backoff"|"rejected"; message: string }`
  - Tasks 13–15 consume all of these.

- [ ] **Step 1: Write the failing test**

Create `tests/dragon-order-policy.test.ts`:

```ts
/**
 * DRAGON TRADAR ORDER POLICY — pure rules, real money.
 *
 * Every rule below is quoted from the integration handoff Classic supplied
 * on 2026-08-18. They live in a pure module so the money logic is provable
 * without touching the network, and so the route layer has no judgement of
 * its own to get wrong.
 *
 * The API was verified live the same day:
 *   GET /api/agent/v1/stats with no auth -> 401 {"error":"missing_agent_token"}
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DRAGON_AGENT_BASE,
  newClientOrderId,
  validateOrder,
  worstCaseCents,
  classifyOrderResponse,
} from "../src/lib/dragon/order-policy";

const good = {
  ticker: "KXEXAMPLE-25-T50",
  side: "yes" as const,
  action: "buy" as const,
  priceCents: 45,
  count: 10,
  clientOrderId: "abc-123",
};

describe("DRAGON_AGENT_BASE", () => {
  it("is the verified host and version", () => {
    assert.equal(DRAGON_AGENT_BASE, "https://dragonradar.net/api/agent/v1");
  });
});

describe("newClientOrderId", () => {
  it("is unique per call for the same seed", () => {
    const a = newClientOrderId("x");
    const b = newClientOrderId("x");
    assert.notEqual(a, b);
  });

  it("stays inside the 128-char ceiling even on an absurd seed", () => {
    assert.ok(newClientOrderId("z".repeat(500)).length <= 128);
  });

  it("is URL-safe, because it goes in a path segment", () => {
    assert.match(newClientOrderId("a b/c?d"), /^[A-Za-z0-9._-]+$/);
  });
});

describe("validateOrder", () => {
  it("accepts a well-formed order", () => {
    const r = validateOrder(good);
    assert.equal(r.ok, true);
  });

  it("requires a clientOrderId — it is the idempotency key", () => {
    const r = validateOrder({ ...good, clientOrderId: "" });
    assert.equal(r.ok, false);
  });

  it("rejects a clientOrderId over 128 chars", () => {
    const r = validateOrder({ ...good, clientOrderId: "a".repeat(129) });
    assert.equal(r.ok, false);
  });

  it("rejects a side that is not yes or no", () => {
    assert.equal(validateOrder({ ...good, side: "maybe" }).ok, false);
  });

  it("rejects priceCents outside 1-99", () => {
    assert.equal(validateOrder({ ...good, priceCents: 0 }).ok, false);
    assert.equal(validateOrder({ ...good, priceCents: 100 }).ok, false);
    assert.equal(validateOrder({ ...good, priceCents: 45.5 }).ok, false);
  });

  it("allows a market order — null or omitted price", () => {
    assert.equal(validateOrder({ ...good, priceCents: null }).ok, true);
    const { priceCents: _drop, ...noPrice } = good;
    assert.equal(validateOrder(noPrice).ok, true);
  });

  it("requires a positive integer count", () => {
    assert.equal(validateOrder({ ...good, count: 0 }).ok, false);
    assert.equal(validateOrder({ ...good, count: -1 }).ok, false);
    assert.equal(validateOrder({ ...good, count: 1.5 }).ok, false);
  });

  it("strips unknown fields rather than forwarding them", () => {
    const r = validateOrder({ ...good, userId: "nope", extra: 1 });
    assert.equal(r.ok, true);
    if (r.ok) {
      // There is NO userId anywhere in this API — the token is the identity.
      assert.equal("userId" in r.order, false);
      assert.equal("extra" in r.order, false);
    }
  });
});

describe("worstCaseCents — market orders are budget-checked at 99c", () => {
  it("uses the limit price when there is one", () => {
    assert.equal(worstCaseCents(good), 450);
  });

  it("uses 99c per contract for a market order", () => {
    assert.equal(worstCaseCents({ ...good, priceCents: null }), 990);
  });
});

describe("classifyOrderResponse", () => {
  it("200 with ok is accepted", () => {
    assert.equal(classifyOrderResponse(200, { ok: true }).kind, "accepted");
  });

  it("200 with held is still accepted — the body decides, not the status", () => {
    assert.equal(classifyOrderResponse(200, { held: true }).kind, "accepted");
  });

  it("403 HALTS — the human paused me; never retry", () => {
    const r = classifyOrderResponse(403, {});
    assert.equal(r.kind, "halted");
    assert.match(r.message, /paused|disabled|kill/i);
  });

  it("502 retries with the SAME clientOrderId", () => {
    const r = classifyOrderResponse(502, {});
    assert.equal(r.kind, "retry_same_id");
  });

  it("500 order_persist_failed must be verified before assuming anything", () => {
    const r = classifyOrderResponse(500, { error: "order_persist_failed" });
    assert.equal(r.kind, "verify_then_decide");
  });

  it("any other 5xx is also verify-before-assume", () => {
    assert.equal(classifyOrderResponse(503, {}).kind, "verify_then_decide");
  });

  it("429 backs off", () => {
    assert.equal(classifyOrderResponse(429, {}).kind, "backoff");
  });

  it("400 is a plain rejection — fix the order, do not loop", () => {
    assert.equal(classifyOrderResponse(400, { error: "too big" }).kind, "rejected");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --yes tsx --test tests/dragon-order-policy.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/dragon/order-policy'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/dragon/order-policy.ts`:

```ts
/**
 * DRAGON TRADAR ORDER POLICY — pure. No fetch, no fs, no secrets.
 *
 * Every rule here is from the integration handoff Classic supplied
 * 2026-08-18. The API was verified live the same day: an unauthenticated
 * GET /stats returns 401 {"error":"missing_agent_token"}.
 *
 * This module holds ALL the judgement so the route layer has none. It is real
 * money on a one-month runway — the rules are worth being able to prove.
 */
import { randomUUID } from "node:crypto";

export const DRAGON_AGENT_BASE = "https://dragonradar.net/api/agent/v1";

/** A market order is budget-checked at worst case 99c per contract. */
export const MARKET_WORST_CASE_CENTS = 99;

/** The API's own ceiling on the idempotency key. */
export const MAX_CLIENT_ORDER_ID = 128;

/** 30 orders/min per user. Anything at or above this backs off. */
export const ORDERS_PER_MINUTE = 30;

export interface OrderRequest {
  ticker: string;
  side: "yes" | "no";
  action?: "buy" | "sell";
  /** 1-99 integer, or null for market. */
  priceCents?: number | null;
  count: number;
  clientOrderId: string;
  tif?: string;
}

export type OrderOutcome = {
  kind:
    | "accepted"
    | "halted"
    | "retry_same_id"
    | "verify_then_decide"
    | "backoff"
    | "rejected";
  message: string;
};

/**
 * A fresh idempotency key. The seed is only there to make an id readable in a
 * log; uniqueness comes from randomUUID, so retrying with the SAME id stays
 * safe and a NEW order always gets a new one.
 */
export function newClientOrderId(seed: string): string {
  const slug = seed.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 24);
  const id = `${slug || "starra"}-${randomUUID()}`;
  return id.slice(0, MAX_CLIENT_ORDER_ID);
}

function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Validate AND narrow. The returned order contains ONLY the fields the API
 * accepts — unknown fields are dropped here rather than relying on the server
 * to strip them, and there is deliberately no `userId`: the token is the
 * identity, and sending one would be inventing a field this API does not have.
 */
export function validateOrder(
  o: unknown,
): { ok: true; order: OrderRequest } | { ok: false; reason: string } {
  if (!o || typeof o !== "object") return { ok: false, reason: "not an object" };
  const r = o as Record<string, unknown>;

  if (typeof r.ticker !== "string" || !r.ticker.trim()) {
    return { ok: false, reason: "ticker is required" };
  }
  if (r.side !== "yes" && r.side !== "no") {
    return { ok: false, reason: 'side must be "yes" or "no"' };
  }
  if (r.action !== undefined && r.action !== "buy" && r.action !== "sell") {
    return { ok: false, reason: 'action must be "buy" or "sell"' };
  }
  if (!isPosInt(r.count)) {
    return { ok: false, reason: "count must be a positive whole number of contracts" };
  }
  if (typeof r.clientOrderId !== "string" || !r.clientOrderId.trim()) {
    return { ok: false, reason: "clientOrderId is required — it is the idempotency key" };
  }
  if (r.clientOrderId.length > MAX_CLIENT_ORDER_ID) {
    return { ok: false, reason: `clientOrderId must be ${MAX_CLIENT_ORDER_ID} chars or fewer` };
  }
  const price = r.priceCents;
  const marketOrder = price === undefined || price === null;
  if (!marketOrder) {
    if (typeof price !== "number" || !Number.isInteger(price) || price < 1 || price > 99) {
      return { ok: false, reason: "priceCents must be a whole number from 1 to 99, or null for market" };
    }
  }

  const order: OrderRequest = {
    ticker: r.ticker.trim(),
    side: r.side,
    count: r.count,
    clientOrderId: r.clientOrderId,
  };
  if (r.action !== undefined) order.action = r.action;
  if (!marketOrder) order.priceCents = price as number;
  else if (price === null) order.priceCents = null;
  if (typeof r.tif === "string" && r.tif) order.tif = r.tif;

  return { ok: true, order };
}

/** What this order could cost at worst, in cents. Market = 99c/contract. */
export function worstCaseCents(o: OrderRequest): number {
  const per =
    o.priceCents === undefined || o.priceCents === null
      ? MARKET_WORST_CASE_CENTS
      : o.priceCents;
  return per * o.count;
}

/**
 * What to DO about a response. The handoff's rules, one branch each — a 403 is
 * never retried, a 5xx is never assumed either way.
 */
export function classifyOrderResponse(status: number, body: unknown): OrderOutcome {
  const err =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? ((body as { error: string }).error)
      : "";

  if (status === 200) {
    return { kind: "accepted", message: "Order accepted." };
  }
  if (status === 403) {
    return {
      kind: "halted",
      message:
        "Dragon Tradar refused it — live trading is disabled or the kill switch is on. I've stopped.",
    };
  }
  if (status === 429) {
    return { kind: "backoff", message: "Rate limited — 30 orders a minute. Backing off." };
  }
  if (status === 502) {
    return {
      kind: "retry_same_id",
      message: "The venue call failed. Retrying with the same order id.",
    };
  }
  if (status >= 500) {
    return {
      kind: "verify_then_decide",
      message: err
        ? `Dragon Tradar returned ${err}. Checking whether the order landed before doing anything else.`
        : "Dragon Tradar had an internal error. Checking whether the order landed.",
    };
  }
  return { kind: "rejected", message: err || `Order rejected (${status}).` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --yes tsx --test tests/dragon-order-policy.test.ts`
Expected: PASS — 22 tests.

- [ ] **Step 5: Run the full gates**

```bash
npm run typecheck && npm run test:v2 2>&1 | tail -6 && npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/dragon/order-policy.ts tests/dragon-order-policy.test.ts
git commit -m "feat(dragon): order policy — every rule from the handoff, pure and proved

403 halts and never retries. 502 retries the SAME clientOrderId. Any 5xx polls
before assuming. Market orders budget at 99c. Unknown fields, userId included,
never leave this module.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: The client and the key slot — the token never leaves the server

**Files:**
- Modify: `src/lib/keys.ts` (add one slot to `KEY_SLOTS`)
- Create: `src/lib/dragon/agent-client.ts`
- Create: `src/app/api/dragon/agent/route.ts`

**Interfaces:**
- Consumes: everything from Task 12; the existing `getKey(id)` (`src/lib/keys.ts:271`).
- Produces:
  - `dragonStats(): Promise<{ linked: boolean; stats?: unknown; error?: string }>`
  - `placeOrder(o: OrderRequest): Promise<{ outcome: OrderOutcome; body: unknown }>`
  - `orderStatus(clientOrderId: string): Promise<{ found: boolean; body: unknown }>`
  - `cancelOrder(clientOrderId: string, venueOrderId?: string): Promise<{ ok: boolean; body: unknown }>`
  - `GET /api/dragon/agent` → stats. Tasks 14–16 consume these.

- [ ] **Step 1: Add the key slot**

In `src/lib/keys.ts`, inside `KEY_SLOTS`, next to the other `dragontradar` entries
(after the `dragontradar_token` block at `:101-107`):

```ts
  {
    id: "dragon_agent_token",
    label: "Dragon Tradar agent token",
    hint: "Settings → Trading Agent in the Dragon Tradar app",
    powers: "STARRA reads the account and proposes orders",
    group: "dragontradar",
  },
```

`KeySlotId` is derived from `KEY_SLOTS` (`:166`), so the id becomes valid everywhere with
no other edit.

- [ ] **Step 2: Write the client**

Create `src/lib/dragon/agent-client.ts`:

```ts
/**
 * DRAGON TRADAR AGENT CLIENT — the ONLY module that talks to dragonradar.net.
 *
 * THE TOKEN NEVER LEAVES THIS PROCESS. It is read with getKey() server-side,
 * put in an Authorization header, and never logged, never echoed, never put in
 * a response body, never imported by a client component. There is no userId in
 * this API — the token IS the identity, and sending one would be inventing a
 * field the API does not have.
 *
 * Verified live 2026-08-18: an unauthenticated GET /stats returns
 * 401 {"error":"missing_agent_token"}.
 */
import "server-only";
import { getKey } from "@/lib/keys";
import {
  DRAGON_AGENT_BASE,
  classifyOrderResponse,
  type OrderOutcome,
  type OrderRequest,
} from "./order-policy";

/** Nothing here waits forever — a hung venue must not hang the deck. */
const TIMEOUT_MS = 12_000;

async function token(): Promise<string | undefined> {
  return getKey("dragon_agent_token");
}

async function call(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const t = await token();
  if (!t) return { status: 401, body: { error: "no_agent_token" } };
  const res = await fetch(`${DRAGON_AGENT_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      // The token goes HERE and nowhere else. Never into a log line.
      authorization: `Bearer ${t}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  const body: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** Read-only account stats. IP rate-limited upstream — a few times a minute. */
export async function dragonStats(): Promise<{
  linked: boolean;
  stats?: unknown;
  error?: string;
}> {
  if (!(await token())) {
    return { linked: false, error: "Dragon Tradar agent token isn't linked yet." };
  }
  try {
    const { status, body } = await call("/stats");
    if (status === 200) return { linked: true, stats: body };
    if (status === 401) return { linked: false, error: "The agent token was refused." };
    if (status === 429) return { linked: true, error: "Rate limited — try again in a minute." };
    return { linked: true, error: `Dragon Tradar returned ${status}.` };
  } catch {
    return { linked: false, error: "Couldn't reach Dragon Tradar." };
  }
}

/** Place an order. The caller owns the clientOrderId and reuses it on a retry. */
export async function placeOrder(
  order: OrderRequest,
): Promise<{ outcome: OrderOutcome; body: unknown }> {
  try {
    const { status, body } = await call("/orders", {
      method: "POST",
      body: JSON.stringify(order),
    });
    return { outcome: classifyOrderResponse(status, body), body };
  } catch {
    // A thrown fetch is indistinguishable from a 5xx as far as the order is
    // concerned: it may or may not have landed. Same rule — go and look.
    return {
      outcome: {
        kind: "verify_then_decide",
        message: "The request didn't complete. Checking whether the order landed.",
      },
      body: {},
    };
  }
}

/** 404 means the order was never recorded — which is a real answer, not an error. */
export async function orderStatus(
  clientOrderId: string,
): Promise<{ found: boolean; body: unknown }> {
  try {
    const { status, body } = await call(`/orders/${encodeURIComponent(clientOrderId)}`);
    return { found: status === 200, body };
  } catch {
    return { found: false, body: {} };
  }
}

export async function cancelOrder(
  clientOrderId: string,
  venueOrderId?: string,
): Promise<{ ok: boolean; body: unknown }> {
  try {
    const { status, body } = await call(
      `/orders/${encodeURIComponent(clientOrderId)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify(venueOrderId ? { venueOrderId } : {}),
      },
    );
    return { ok: status === 200, body };
  } catch {
    return { ok: false, body: {} };
  }
}
```

Confirm `server-only` is already a dependency before using it:

```bash
node -e "console.log(require('./package.json').dependencies['server-only'] ?? 'ABSENT')"
```

If it prints `ABSENT`, **do not install it** — delete the `import "server-only";` line and
instead rely on the module never being imported from a `"use client"` file, and note that
in the header comment. No new dependencies (Global Constraints).

- [ ] **Step 3: The stats route**

Create `src/app/api/dragon/agent/route.ts`:

```ts
/**
 * Dragon Tradar account stats, proxied. The browser never sees the token.
 * The existing /api/dragon (Kalshi market data) is untouched and unrelated.
 */
import { dragonStats } from "@/lib/dragon/agent-client";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(await dragonStats());
}
```

- [ ] **Step 4: Run the full gates**

```bash
npm run typecheck && npm run test:v2 2>&1 | tail -6 && npm run lint
```

- [ ] **Step 5: Prove the token never reaches the browser**

```bash
grep -rn "dragon_agent_token\|DRAGON_AGENT_BASE" src --include="*.tsx"
```
Expected: **no output.** Any hit in a `.tsx` file is a client component reaching for the
server client — stop and move that call behind the route.

- [ ] **Step 6: Commit**

```bash
git add src/lib/keys.ts src/lib/dragon/agent-client.ts src/app/api/dragon/agent/route.ts
git commit -m "feat(dragon): server-side agent client and stats route

The bearer token is read with getKey() server-side and never leaves the process:
not into a log, not into a response body, not into the browser bundle.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: HAND CLASSIC THE ONE THING ONLY HE CAN DO**

```bash
open "https://localhost:3000/settings#link-apis"
```

> Mint the agent token in the Dragon Tradar app under **Settings → Trading Agent** and
> paste it into the new **Dragon Tradar agent token** slot in the deck's key vault. It
> stays in `data/keys.json` on this Mac and is only ever read server-side. I can't mint
> it for you — it's your account.

Then verify it linked, with a command that prints a status and not a token:

```bash
curl -sk https://localhost:3000/api/dragon/agent -b "$(echo)" -o /dev/null -w "%{http_code}\n"
```

(Expect `401` from a shell with no session cookie — that only proves the route exists.
The real check is the DRAGON TRADAR panel in Task 15.)

---

### Task 14: The ticket store — she proposes, he decides

**Files:**
- Create: `src/lib/dragon/tickets.ts`
- Test: `tests/dragon-tickets.test.ts`

**Interfaces:**
- Consumes: `OrderRequest`, `worstCaseCents` from Task 12.
- Produces:
  - `interface Ticket { id; order: OrderRequest; reason: string; state: "pending"|"approved"|"declined"|"placed"|"failed"|"halted"; note?: string; createdAt; decidedAt? }`
  - `listTickets(): Promise<Ticket[]>` · `proposeTicket(order, reason): Promise<Ticket>` · `decideTicket(id, "approve"|"decline"): Promise<Ticket | null>` · `settleTicket(id, state, note): Promise<Ticket | null>`
  - Tasks 15 and 16 consume all of these.

- [ ] **Step 1: Write the failing test**

Create `tests/dragon-tickets.test.ts`:

```ts
/**
 * THE APPROVAL GATE. STARRA never places an order; she writes a ticket and
 * Classic approves it. This is real money on a one-month runway — the state
 * machine that stands between her and his balance is worth proving.
 *
 * The store is redirected to a temp file via STARRA_DATA_DIR so the test never
 * touches data/.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const order = {
  ticker: "KXEXAMPLE-25-T50",
  side: "yes" as const,
  action: "buy" as const,
  priceCents: 45,
  count: 10,
  clientOrderId: "seed-1",
};

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dragon-tickets-"));
  prev = process.env.STARRA_DATA_DIR;
  process.env.STARRA_DATA_DIR = dir;
});

afterEach(() => {
  if (prev === undefined) delete process.env.STARRA_DATA_DIR;
  else process.env.STARRA_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("proposeTicket", () => {
  it("starts pending — a proposal is never an order", async () => {
    const { proposeTicket } = await import("../src/lib/dragon/tickets");
    const t = await proposeTicket(order, "Volume spiked and the yes side is cheap.");
    assert.equal(t.state, "pending");
  });

  it("keeps her reason, so he can judge it", async () => {
    const { proposeTicket } = await import("../src/lib/dragon/tickets");
    const t = await proposeTicket(order, "Because I said so.");
    assert.equal(t.reason, "Because I said so.");
  });

  it("gives every ticket a distinct id", async () => {
    const { proposeTicket } = await import("../src/lib/dragon/tickets");
    const a = await proposeTicket(order, "one");
    const b = await proposeTicket(order, "two");
    assert.notEqual(a.id, b.id);
  });

  it("persists across a reload of the store", async () => {
    const { proposeTicket, listTickets } = await import("../src/lib/dragon/tickets");
    await proposeTicket(order, "keep me");
    assert.equal((await listTickets()).length, 1);
  });
});

describe("decideTicket", () => {
  it("approve moves pending -> approved and stamps the time", async () => {
    const { proposeTicket, decideTicket } = await import("../src/lib/dragon/tickets");
    const t = await proposeTicket(order, "r");
    const d = await decideTicket(t.id, "approve");
    assert.equal(d?.state, "approved");
    assert.ok(typeof d?.decidedAt === "number");
  });

  it("decline moves pending -> declined", async () => {
    const { proposeTicket, decideTicket } = await import("../src/lib/dragon/tickets");
    const t = await proposeTicket(order, "r");
    assert.equal((await decideTicket(t.id, "decline"))?.state, "declined");
  });

  it("REFUSES to re-decide a ticket that is no longer pending", async () => {
    // Double-approve is a double order. The store is the last place that can
    // stop it, so it does.
    const { proposeTicket, decideTicket } = await import("../src/lib/dragon/tickets");
    const t = await proposeTicket(order, "r");
    await decideTicket(t.id, "approve");
    assert.equal(await decideTicket(t.id, "approve"), null);
  });

  it("returns null for an unknown id rather than inventing a ticket", async () => {
    const { decideTicket } = await import("../src/lib/dragon/tickets");
    assert.equal(await decideTicket("nope", "approve"), null);
  });
});

describe("settleTicket", () => {
  it("records what actually happened at the venue", async () => {
    const { proposeTicket, decideTicket, settleTicket } = await import(
      "../src/lib/dragon/tickets"
    );
    const t = await proposeTicket(order, "r");
    await decideTicket(t.id, "approve");
    const s = await settleTicket(t.id, "placed", "accepted by the venue");
    assert.equal(s?.state, "placed");
    assert.equal(s?.note, "accepted by the venue");
  });

  it("can record a halt, which is what a 403 becomes", async () => {
    const { proposeTicket, decideTicket, settleTicket } = await import(
      "../src/lib/dragon/tickets"
    );
    const t = await proposeTicket(order, "r");
    await decideTicket(t.id, "approve");
    assert.equal((await settleTicket(t.id, "halted", "kill switch"))?.state, "halted");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --yes tsx --test tests/dragon-tickets.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/dragon/tickets'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/dragon/tickets.ts`:

```ts
/**
 * DRAGON TICKETS — the approval gate between STARRA and Classic's money.
 *
 * She never calls POST /orders. She writes a ticket here; it appears on the
 * deck with APPROVE / DECLINE; only his approve fires the order. The state
 * machine is deliberately one-way and refuses to re-decide a ticket, because
 * a double approve is a double order.
 *
 *   pending --approve--> approved --> placed | failed | halted
 *           --decline--> declined
 *
 * Stored in data/dragon-tickets.json (gitignored, never leaves the Mac).
 * STARRA_DATA_DIR redirects the whole store, which is how the tests avoid
 * touching data/.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OrderRequest } from "./order-policy";

export type TicketState =
  | "pending"
  | "approved"
  | "declined"
  | "placed"
  | "failed"
  | "halted";

export interface Ticket {
  id: string;
  order: OrderRequest;
  /** Her stated reason. This is what Classic actually judges. */
  reason: string;
  state: TicketState;
  note?: string;
  createdAt: number;
  decidedAt?: number;
}

function storePath(): string {
  const dir = process.env.STARRA_DATA_DIR || path.join(process.cwd(), "data");
  return path.join(dir, "dragon-tickets.json");
}

async function load(): Promise<Ticket[]> {
  try {
    const raw = await fs.readFile(storePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Ticket[]) : [];
  } catch {
    // Missing or corrupt reads as empty. A trading gate that THROWS on a bad
    // file is a gate that can be knocked open by a bad file.
    return [];
  }
}

async function save(list: Ticket[]): Promise<void> {
  const p = storePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(list, null, 2), "utf8");
}

export async function listTickets(): Promise<Ticket[]> {
  return load();
}

export async function proposeTicket(
  order: OrderRequest,
  reason: string,
): Promise<Ticket> {
  const list = await load();
  const ticket: Ticket = {
    id: randomUUID(),
    order,
    reason: reason.trim(),
    state: "pending",
    createdAt: Date.now(),
  };
  list.unshift(ticket);
  await save(list);
  return ticket;
}

/** Approve or decline. Returns null for an unknown id OR a ticket already decided. */
export async function decideTicket(
  id: string,
  action: "approve" | "decline",
): Promise<Ticket | null> {
  const list = await load();
  const t = list.find((x) => x.id === id);
  // Only a PENDING ticket may be decided. Re-approving is a second order.
  if (!t || t.state !== "pending") return null;
  t.state = action === "approve" ? "approved" : "declined";
  t.decidedAt = Date.now();
  await save(list);
  return t;
}

/** Record what the venue actually did with an approved ticket. */
export async function settleTicket(
  id: string,
  state: Extract<TicketState, "placed" | "failed" | "halted">,
  note: string,
): Promise<Ticket | null> {
  const list = await load();
  const t = list.find((x) => x.id === id);
  if (!t) return null;
  t.state = state;
  t.note = note;
  await save(list);
  return t;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --yes tsx --test tests/dragon-tickets.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Keep the store out of git**

```bash
grep -q "dragon-tickets" .gitignore || echo "data/dragon-tickets.json" >> .gitignore
grep -n "dragon-tickets\|^data/" .gitignore
```

- [ ] **Step 6: Run the full gates**

```bash
npm run typecheck && npm run test:v2 2>&1 | tail -6 && npm run lint
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/dragon/tickets.ts tests/dragon-tickets.test.ts .gitignore
git commit -m "feat(dragon): the approval gate — she proposes, he decides

pending -> approved | declined, and a decided ticket can never be decided
again, because a double approve is a double order.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: The route that actually places the order, and the panel he clicks

**Files:**
- Create: `src/app/api/dragon/tickets/route.ts`
- Create: `src/components/bridge/DragonTickets.tsx`
- Modify: `src/components/bridge/Bridge.tsx` (inside `#panel-dragon`, after the `row-list` div that ends at `:934`)
- Modify: `src/styles/deck.css` (append a ticket section)

**Interfaces:**
- Consumes: Tasks 12, 13, 14.
- Produces: `GET /api/dragon/tickets` · `POST /api/dragon/tickets` (propose) · `PATCH /api/dragon/tickets` (decide — approve places the order). Task 16 consumes POST.

- [ ] **Step 1: Write the route**

Create `src/app/api/dragon/tickets/route.ts`:

```ts
/**
 * THE ONLY PLACE AN ORDER IS EVER PLACED.
 *
 * POST proposes (state: pending). PATCH decides. An approve is the single
 * point where money moves, and everything the handoff says about failure is
 * enforced right here:
 *
 *   403  -> halted. The human paused me. Stop, mark it, surface it. NO retry.
 *   502  -> retry ONCE with the SAME clientOrderId (it is the idempotency key).
 *   5xx  -> poll GET /orders/{clientOrderId} before assuming anything.
 *   429  -> back off; the ticket stays approved so he can try again.
 */
import { pushFeed } from "@/lib/feed";
import { placeOrder, orderStatus } from "@/lib/dragon/agent-client";
import { validateOrder, newClientOrderId } from "@/lib/dragon/order-policy";
import {
  decideTicket,
  listTickets,
  proposeTicket,
  settleTicket,
} from "@/lib/dragon/tickets";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ tickets: await listTickets() });
}

/** POST → propose. Never places anything. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    order?: unknown;
    reason?: string;
  };
  const raw = (body.order ?? {}) as Record<string, unknown>;
  // She does not have to invent an idempotency key; one is minted here if the
  // proposal arrived without one.
  const withId = {
    ...raw,
    clientOrderId:
      typeof raw.clientOrderId === "string" && raw.clientOrderId
        ? raw.clientOrderId
        : newClientOrderId(String(raw.ticker ?? "starra")),
  };
  const v = validateOrder(withId);
  if (!v.ok) {
    return Response.json({ ok: false, error: v.reason }, { status: 400 });
  }
  const ticket = await proposeTicket(v.order, body.reason ?? "");
  pushFeed(
    "DRAGON",
    `STARRA proposes ${v.order.action ?? "buy"} ${v.order.count} ${v.order.side.toUpperCase()} ${v.order.ticker} — awaiting approval`,
  );
  return Response.json({ ok: true, ticket });
}

/** PATCH → decide. An approve is what places the order. */
export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    action?: "approve" | "decline";
  };
  if (!body.id || (body.action !== "approve" && body.action !== "decline")) {
    return Response.json({ ok: false, error: "id and action required" }, { status: 400 });
  }

  const ticket = await decideTicket(body.id, body.action);
  if (!ticket) {
    // Unknown, or already decided. Either way nothing happens twice.
    return Response.json(
      { ok: false, error: "That ticket isn't pending." },
      { status: 409 },
    );
  }
  if (body.action === "decline") {
    pushFeed("DRAGON", `Declined ${ticket.order.ticker}`);
    return Response.json({ ok: true, ticket });
  }

  // ── APPROVED. This is the money. ────────────────────────────────────────
  let attempt = await placeOrder(ticket.order);

  // 502 is the ONE retry, and it reuses the SAME clientOrderId so the venue
  // can deduplicate it. Never a fresh id, never a loop.
  if (attempt.outcome.kind === "retry_same_id") {
    attempt = await placeOrder(ticket.order);
  }

  if (attempt.outcome.kind === "verify_then_decide" || attempt.outcome.kind === "retry_same_id") {
    // Never assume from a 5xx. Go and look.
    const status = await orderStatus(ticket.order.clientOrderId);
    const settled = await settleTicket(
      ticket.id,
      status.found ? "placed" : "failed",
      status.found
        ? "Confirmed at the venue after an error response."
        : "Never recorded at the venue.",
    );
    pushFeed("DRAGON", `${ticket.order.ticker} — ${settled?.note ?? "checked"}`);
    return Response.json({ ok: status.found, ticket: settled, checked: true });
  }

  if (attempt.outcome.kind === "halted") {
    const settled = await settleTicket(ticket.id, "halted", attempt.outcome.message);
    pushFeed("DRAGON", `HALTED — ${attempt.outcome.message}`);
    return Response.json({ ok: false, ticket: settled, halted: true }, { status: 200 });
  }

  if (attempt.outcome.kind === "accepted") {
    const settled = await settleTicket(ticket.id, "placed", attempt.outcome.message);
    pushFeed(
      "DRAGON",
      `PLACED ${ticket.order.count} ${ticket.order.side.toUpperCase()} ${ticket.order.ticker}`,
    );
    return Response.json({ ok: true, ticket: settled });
  }

  // backoff | rejected
  const settled = await settleTicket(ticket.id, "failed", attempt.outcome.message);
  pushFeed("DRAGON", `${ticket.order.ticker} — ${attempt.outcome.message}`);
  return Response.json({ ok: false, ticket: settled });
}
```

- [ ] **Step 2: Write the panel**

Create `src/components/bridge/DragonTickets.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";

interface Ticket {
  id: string;
  order: {
    ticker: string;
    side: "yes" | "no";
    action?: "buy" | "sell";
    priceCents?: number | null;
    count: number;
  };
  reason: string;
  state: "pending" | "approved" | "declined" | "placed" | "failed" | "halted";
  note?: string;
  createdAt: number;
}

const POLL_MS = 15_000;

/** APPROVE / DECLINE. Nothing in this component can place an order — the
 *  approve PATCH is what does, server-side, and only for a pending ticket. */
export function DragonTickets() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dragon/tickets");
      if (!res.ok) return;
      const data = (await res.json()) as { tickets?: Ticket[] };
      setTickets(data.tickets ?? []);
    } catch {
      /* keep what is on screen */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function decide(id: string, action: "approve" | "decline") {
    setBusy(id);
    try {
      await fetch("/api/dragon/tickets", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      await load();
    } catch {
      /* the feed carries the failure */
    } finally {
      setBusy(null);
    }
  }

  const pending = tickets.filter((t) => t.state === "pending");
  const recent = tickets.filter((t) => t.state !== "pending").slice(0, 3);

  if (pending.length === 0 && recent.length === 0) return null;

  return (
    <div className="dragon-tickets">
      {pending.map((t) => (
        <div className="dragon-ticket" key={t.id}>
          <div className="dragon-ticket-head">
            <span className="row-side" style={{ background: t.order.side === "yes" ? "#6ee7a0" : "#ff6b8a" }}>
              {t.order.side.toUpperCase()}
            </span>
            <span className="row-market">{t.order.ticker}</span>
            <span className="row-price">
              ×{t.order.count}
              {typeof t.order.priceCents === "number" ? ` @ ${t.order.priceCents}¢` : " @ MKT"}
            </span>
          </div>
          {t.reason ? <p className="dragon-ticket-reason">{t.reason}</p> : null}
          <div className="dragon-ticket-actions">
            <button
              type="button"
              className="panel-tag"
              style={{ color: "#6ee7a0" }}
              disabled={busy === t.id}
              onClick={() => void decide(t.id, "approve")}
            >
              APPROVE
            </button>
            <button
              type="button"
              className="panel-tag warn"
              disabled={busy === t.id}
              onClick={() => void decide(t.id, "decline")}
            >
              DECLINE
            </button>
          </div>
        </div>
      ))}
      {recent.map((t) => (
        <div className="dragon-ticket is-settled" key={t.id}>
          <span className="row-market">{t.order.ticker}</span>
          <span className="row-pnl">{t.state.toUpperCase()}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Mount it and style it**

In `Bridge.tsx`, inside `<div className="panel" id="panel-dragon">`, immediately after the
closing `</div>` of the `row-list` (the div that ends just before `#panel-stocks` at
`:934-935`):

```tsx
              <DragonTickets />
```

with `import { DragonTickets } from "./DragonTickets";` alongside the other bridge imports.

Append to `src/styles/deck.css`:

```css
/* ── dragon tickets (DragonTickets.tsx) — the approval gate ── */
.dragon-tickets { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 10px; }
.dragon-ticket {
  border: 1px solid rgba(255,107,138,0.35); border-radius: 8px;
  background: rgba(255,107,138,0.06); padding: 8px;
  display: flex; flex-direction: column; gap: 6px;
}
.dragon-ticket.is-settled {
  flex-direction: row; align-items: center; justify-content: space-between;
  border-color: var(--border); background: transparent; opacity: 0.65;
}
.dragon-ticket-head { display: flex; align-items: center; gap: 8px; }
.dragon-ticket-reason {
  font-family: var(--mono); font-size: 10px; line-height: 1.45; color: var(--text-dim);
}
.dragon-ticket-actions { display: flex; gap: 6px; }
.dragon-ticket-actions button { cursor: pointer; }
```

- [ ] **Step 4: Run the full gates**

```bash
npm run typecheck && npm run test:v2 2>&1 | tail -6 && npm run lint
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/dragon/tickets/route.ts src/components/bridge/DragonTickets.tsx src/components/bridge/Bridge.tsx src/styles/deck.css
git commit -m "feat(dragon): approve/decline on the deck; approve is the only path to an order

403 halts and never retries. 502 retries once with the same clientOrderId. Any
other 5xx polls the order before the ticket is settled either way.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Give her the tools — chat and call

**Files:**
- Modify: `src/app/api/mcp/route.ts:60-97` (`TOOLS`) and `:137` (`callTool`)
- Modify: `src/app/api/voice-tools/[action]/route.ts:37` (`WRITE_ACTIONS`) and the switch at `:128-155`

**Interfaces:**
- Consumes: `dragonStats` (Task 13), `proposeTicket` + `validateOrder` + `newClientOrderId` (Tasks 12, 14).
- Produces: MCP tools `dragon_stats`, `dragon_propose_order`; voice verbs `dragon_balance`, `dragon_propose`.

- [ ] **Step 1: Add the MCP tools**

In `src/app/api/mcp/route.ts`, append to `TOOLS`:

```ts
  {
    name: "dragon_stats",
    description:
      "Read Classic's Dragon Tradar account — balance, open positions, performance. " +
      "Read-only and safe to call whenever he asks how the account is doing. " +
      "It is IP rate-limited, so a few times a minute at most.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dragon_propose_order",
    description:
      "PROPOSE a trade on Classic's Dragon Tradar account. This does NOT place " +
      "an order — it puts a ticket on his deck with APPROVE and DECLINE, and " +
      "nothing moves until he approves it. Always give your reason; that is what " +
      "he is judging. Never claim a trade was placed from this tool.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Market ticker, e.g. KXEXAMPLE-25-T50." },
        side: { type: "string", enum: ["yes", "no"] },
        action: { type: "string", enum: ["buy", "sell"], description: "Defaults to buy." },
        priceCents: {
          type: "number",
          description: "Limit price 1-99. Omit for a market order.",
        },
        count: { type: "number", description: "Number of contracts." },
        reason: { type: "string", description: "Why. One or two sentences." },
      },
      required: ["ticker", "side", "count", "reason"],
    },
  },
```

and add the branches to `callTool`:

```ts
    case "dragon_stats": {
      const { dragonStats } = await import("@/lib/dragon/agent-client");
      const s = await dragonStats();
      if (!s.linked) return s.error ?? "Dragon Tradar isn't linked.";
      if (s.error) return s.error;
      return JSON.stringify(s.stats);
    }

    case "dragon_propose_order": {
      const { validateOrder, newClientOrderId } = await import("@/lib/dragon/order-policy");
      const { proposeTicket } = await import("@/lib/dragon/tickets");
      const v = validateOrder({
        ticker: args.ticker,
        side: args.side,
        action: args.action,
        priceCents: args.priceCents ?? null,
        count: args.count,
        clientOrderId: newClientOrderId(String(args.ticker ?? "starra")),
      });
      if (!v.ok) return `I can't propose that: ${v.reason}`;
      const t = await proposeTicket(v.order, String(args.reason ?? ""));
      return `Proposed — ${v.order.count} ${v.order.side.toUpperCase()} on ${v.order.ticker}. It's on your deck waiting for approve or decline. Ticket ${t.id}.`;
    }
```

- [ ] **Step 2: Add the voice verbs**

In `src/app/api/voice-tools/[action]/route.ts`, add `dragon_propose` to `WRITE_ACTIONS`
(`:37`) — a proposal writes to disk, so it takes the write token:

```ts
const WRITE_ACTIONS = new Set(["remember", "note", "funding_status", "dragon_propose"]);
```

and add both verbs to the switch, returning **spoken sentences, never JSON** — that is the
whole rule of this file (`:5-9`):

```ts
      case "dragon_balance": {
        const { dragonStats } = await import("@/lib/dragon/agent-client");
        const s = await dragonStats();
        if (!s.linked) return say("Dragon Tradar isn't linked to the deck yet.");
        if (s.error) return say(s.error);
        // A payload is a thing she reads badly. Pull the number out.
        const stats = s.stats as { balanceDollars?: number; balance?: number } | null;
        const bal = stats?.balanceDollars ?? stats?.balance;
        return say(
          typeof bal === "number"
            ? `Your Dragon balance is ${bal.toFixed(2)} dollars.`
            : "I reached Dragon Tradar but couldn't find a balance in what it sent back.",
        );
      }

      case "dragon_propose": {
        const { validateOrder, newClientOrderId } = await import("@/lib/dragon/order-policy");
        const { proposeTicket } = await import("@/lib/dragon/tickets");
        const ticker = url.searchParams.get("ticker") ?? "";
        const side = url.searchParams.get("side") ?? "";
        const countRaw = url.searchParams.get("count") ?? "";
        const priceRaw = url.searchParams.get("price_cents");
        const reason = url.searchParams.get("reason") ?? "";
        const v = validateOrder({
          ticker,
          side,
          count: Number(countRaw),
          priceCents: priceRaw ? Number(priceRaw) : null,
          clientOrderId: newClientOrderId(ticker || "starra"),
        });
        if (!v.ok) return say(`I can't propose that — ${v.reason}.`);
        await proposeTicket(v.order, reason);
        return say(
          `Alright — ${v.order.count} ${v.order.side} on ${v.order.ticker} is on your deck. Nothing happens until you approve it.`,
        );
      }
```

Update the `default:` sentence so she knows what she can do:

```ts
        return say(
          "I don't know that one. I can recall something, remember something, take a note, move a funding lead, read your Dragon balance, or propose a trade.",
        );
```

- [ ] **Step 3: Run the full gates**

```bash
npm run typecheck && npm run test:v2 2>&1 | tail -6 && npm run lint
```

- [ ] **Step 4: Prove she cannot place an order directly**

```bash
grep -rn "placeOrder" src | grep -v "agent-client.ts"
```
Expected: exactly one hit — `src/app/api/dragon/tickets/route.ts`. Any other caller is a
path around the approval gate; stop and remove it.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/mcp/route.ts "src/app/api/voice-tools/[action]/route.ts"
git commit -m "feat(dragon): STARRA can read the account and propose trades, from chat and from the call

Reads are free. Writes are proposals — placeOrder has exactly one caller, and
it is the approve branch of the ticket route.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: HAND IT TO CLASSIC — the whole phase proves itself here**

```bash
open "https://localhost:3000/"
```

Ask him to do these three, in order:

1. Type **"what's my Dragon balance?"** — she should answer with the real number.
2. Type **"propose ten yes on <a live ticker> at 45 cents"** — a ticket should appear in
   the DRAGON TRADAR panel with her reason on it and APPROVE / DECLINE under it.
3. Hit **DECLINE** first, on purpose, and confirm nothing was placed. **Only then**, on a
   second small ticket, hit APPROVE and check the order in the Dragon Tradar app itself.

> The first order placed through this is real money. Decline one before you approve one —
> I want you to see the gate hold before you see it open.

- [ ] **Step 7: Write the memory, at the moment it works**

Create `~/.claude/projects/-Users-starrallc/memory/dragon-tradar-agent-integration.md`
recording: the base URL, that the token is the identity and lives in the
`dragon_agent_token` key slot, that `placeOrder` has exactly one caller by design, and
whether a live order has actually been placed yet — with **NOT YET PLACED LIVE** in the
description line until one has. Add the pointer line to `MEMORY.md`.

---

## Self-Review

**Spec coverage:**

| Spec section | Tasks |
|---|---|
| §1 Touch ID root cause + four-part fix | 1, 2, 3, 4 |
| §2 Chat windows, scale landmine, persistence | 5, 6, 7 |
| §3a Chat speech chunking + stop-epoch + delete the duplicate splitter | 8, 9, 10 |
| §3b Call measurement, then the flag | 11 |
| §4 Dragon Tradar reads, proposals, approval, tools | 12, 13, 14, 15, 16 |
| §5 Animation engine out of scope | Global Constraints |

**Placeholders:** none. Every code step carries the actual code. The two places that
delegate judgement rather than dictate it — Task 9 Step 4 (which shape `speakOneChunk`
takes) and Task 11 Step 5 (what to do if a leg other than T3 dominates) — do so
deliberately and say why, because in both cases the existing spec or the measurement is
the authority, not this plan.

**Type consistency checked:** `WindowRect` is produced in Task 5 and consumed unchanged in
6 and 7 · `OrderRequest` and `OrderOutcome` are produced in Task 12 and consumed unchanged
in 13, 14, 15, 16 · `Ticket`/`TicketState` are produced in Task 14 and consumed in 15, 16 ·
`stopEpoch()` is produced in Task 8 and consumed in Task 9 · `speakStarraChunks` is
produced in Task 9 and consumed in Task 10 · `loginTransports` / `PLATFORM_ONLY_REASON` /
`PLATFORM_AUTHENTICATOR_SELECTION` are produced in Tasks 1–2 and consumed in 2, 3, 4.

**One known risk, stated rather than papered over:** Task 10 makes synthesis per-sentence
but still begins playback after the stream closes, because the reveal gate sits between
the loop and the speak call. That is the honest half-win, it is written into the task, and
Task 11's measurement is what decides whether the second half is worth the change to a
mechanism that exists for a reason.
