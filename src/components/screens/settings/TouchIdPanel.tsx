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
 *  login page names (src/app/login/page.tsx:15): no WebAuthn at all (the dock
 *  app's WKWebView), and an IP-address host, which WebAuthn forbids as an rpID.
 *  Duplicated rather than imported — the login copy lives inside a Next.js
 *  page module, and importing a page from a component is not a thing we do. */
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

/** The list could not be READ — distinct from "there is nothing registered".
 *  Conflating the two tells Classic he has no passkey when his cookie merely
 *  expired, and he then walks into an excludeCredentials collision against a
 *  credential the panel just swore did not exist. */
type LoadState = "loading" | "error";

/** A credential that can summon the phone/QR sheet instead of the fingerprint.
 *  The record on disk from 7/31 has NO `attachment` (it predates the field) and
 *  `transports: ["hybrid","internal"]` — `hybrid` IS the QR-your-phone channel.
 *  Both halves of this test must flag it. */
export function isRoaming(p: PasskeyRow): boolean {
  return p.attachment !== "platform" || p.transports.includes("hybrid");
}

export function TouchIdPanel() {
  const [rows, setRows] = useState<PasskeyRow[] | LoadState>("loading");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/passkey");
      // 401 (expired session) or any non-2xx means we do not KNOW what is
      // registered. Falling back to [] here would render NOTHING REGISTERED
      // over a credential that is still on disk.
      if (!res.ok) {
        setRows("error");
        return;
      }
      const data = (await res.json()) as { passkeys?: PasskeyRow[] };
      setRows(data.passkeys ?? []);
    } catch {
      setRows("error");
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
      // Same reason as remove(): the route answers with { ok } in the BODY.
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
      // 200 + { ok: false } is how this route reports "no such credential"
      // (src/app/api/auth/passkey/route.ts:44). res.ok alone would say
      // "Removed." while the credential is still sitting there.
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      setMsg(data.ok ? "Removed." : "Nothing was removed — reload and try again.");
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

      {rows === "loading" ? (
        <p className="font-[family-name:var(--font-mono)] text-xs text-[var(--star)]">
          PROCESSING
        </p>
      ) : rows === "error" ? (
        <p className="font-[family-name:var(--font-mono)] text-xs text-[var(--danger)]">
          COULD NOT READ THE LIST — RELOAD
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
                <span className="ml-2 text-[var(--danger)]">
                  ▲ phone / security key — remove and re-add
                </span>
              ) : (
                <span className="ml-2 text-[var(--ok)]">● this Mac</span>
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

      {/* Disabled on "error" on purpose: the register route sends the existing
          credentials as excludeCredentials, so offering setup when we could not
          read that list is how the collision happens. Reload first. */}
      <button
        type="button"
        className="deck-badge is-ok mt-2"
        disabled={busy || rows === "error"}
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
