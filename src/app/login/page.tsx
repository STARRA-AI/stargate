"use client";

import { useState, type FormEvent } from "react";

function redirectTarget(): string {
  return new URLSearchParams(window.location.search).get("next") || "/";
}

/**
 * Why Touch ID can't run in THIS window, or null if it can. Two dead ends we
 * hit for real: the dock app's WKWebView has no WebAuthn at all, and an
 * IP-address host (127.0.0.1 / LAN) is forbidden as a passkey rpID — the
 * browser throws before the Touch ID sheet ever appears.
 */
function passkeyUnavailable(): string | null {
  if (!window.PublicKeyCredential) {
    return "This window can't do Touch ID — open the deck in Safari or Chrome at https://localhost:3000.";
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$|:/.test(window.location.hostname)) {
    return "Touch ID needs https://localhost:3000 — open the deck there (same login) and set it up.";
  }
  return null;
}

export default function LoginPage() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  // "login" = enter password / use passkey; "setup" = offer Touch ID after a
  // password login (registering a passkey needs an active session).
  const [mode, setMode] = useState<"login" | "setup">("login");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        setMode("setup"); // logged in — offer to add Touch ID for next time
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(data.error || "Login failed.");
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  async function passkeyLogin() {
    const blocked = passkeyUnavailable();
    if (blocked) {
      setErr(blocked);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const optRes = await fetch("/api/auth/passkey/login");
      if (optRes.status === 404) {
        setErr("No passkey yet — sign in with your password, then set up Touch ID.");
        return;
      }
      if (!optRes.ok) throw new Error("options failed");
      const optionsJSON = await optRes.json();
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const assertion = await startAuthentication({ optionsJSON });
      const verRes = await fetch("/api/auth/passkey/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(assertion),
      });
      if (verRes.ok) {
        window.location.href = redirectTarget();
        return;
      }
      setErr("Passkey rejected.");
    } catch (e) {
      setErr(e instanceof Error && e.name === "NotAllowedError" ? "Cancelled." : "Passkey failed.");
    } finally {
      setBusy(false);
    }
  }

  async function passkeyRegister() {
    const blocked = passkeyUnavailable();
    if (blocked) {
      setErr(blocked);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const optRes = await fetch("/api/auth/passkey/register");
      if (!optRes.ok) {
        const data = (await optRes.json().catch(() => ({}))) as { error?: string };
        setErr(data.error || "Session expired — log in with your password again.");
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
      if (verRes.ok) {
        window.location.href = redirectTarget();
        return;
      }
      const data = (await verRes.json().catch(() => ({}))) as { error?: string };
      setErr(data.error || "Touch ID setup failed.");
    } catch (e) {
      setErr(
        e instanceof Error && e.name === "NotAllowedError" ? "Cancelled." : "Touch ID setup failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  const panel: React.CSSProperties = {
    width: "min(360px, 90vw)",
    padding: "16px",
    borderRadius: 16,
    background: "rgba(12, 5, 24, 0.72)",
    border: "1px solid rgba(176, 77, 252, 0.34)",
    boxShadow: "0 0 40px rgba(176, 77, 252, 0.22)",
    backdropFilter: "blur(10px)",
    textAlign: "center",
  };
  const primaryBtn = (enabled: boolean): React.CSSProperties => ({
    width: "100%",
    padding: "12px 14px",
    borderRadius: 10,
    border: "1px solid rgba(176, 77, 252, 0.5)",
    background: enabled ? "rgba(176, 77, 252, 0.28)" : "rgba(176,77,252,0.12)",
    color: "#f2e9ff",
    fontFamily: "inherit",
    fontSize: 13,
    letterSpacing: "0.16em",
    cursor: enabled ? "pointer" : "default",
  });
  const ghostBtn: React.CSSProperties = {
    width: "100%",
    marginTop: 12,
    padding: "11px 14px",
    borderRadius: 10,
    border: "1px solid rgba(176, 77, 252, 0.3)",
    background: "transparent",
    color: "#b98cff",
    fontFamily: "inherit",
    fontSize: 12,
    letterSpacing: "0.12em",
    cursor: busy ? "default" : "pointer",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        margin: 0,
        display: "grid",
        placeItems: "center",
        background: "radial-gradient(circle at 50% 42%, #0d0620 0%, #05020a 60%, #000 100%)",
        fontFamily: "ui-monospace, Menlo, monospace",
        color: "#c9b8ff",
      }}
    >
      {mode === "setup" ? (
        <div style={panel}>
          <div style={{ fontSize: 12, letterSpacing: "0.34em", fontWeight: 700, color: "#b98cff" }}>
            STARGATE
          </div>
          <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "#7a63a8", marginTop: 12 }}>
            YOU&apos;RE IN
          </div>
          <div style={{ marginTop: 12, fontSize: 12.5, color: "#c9b8ff", lineHeight: 1.6 }}>
            Set up Touch&nbsp;ID / Face&nbsp;ID so you can unlock STARGATE without the password
            next time?
          </div>
          {err ? (
            <div style={{ marginTop: 12, fontSize: 12, color: "#ff6b8a" }}>{err}</div>
          ) : null}
          <button
            type="button"
            onClick={passkeyRegister}
            disabled={busy}
            style={{ ...primaryBtn(!busy), marginTop: 12 }}
          >
            {busy ? "…" : "SET UP TOUCH ID"}
          </button>
          <button
            type="button"
            onClick={() => (window.location.href = redirectTarget())}
            style={ghostBtn}
          >
            CONTINUE TO DECK
          </button>
        </div>
      ) : (
        <form onSubmit={submit} style={panel}>
          <div style={{ fontSize: 12, letterSpacing: "0.34em", fontWeight: 700, color: "#b98cff" }}>
            STARGATE
          </div>
          <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "#7a63a8", marginTop: 12 }}>
            OPERATOR ACCESS
          </div>

          <div style={{ position: "relative", marginTop: 12 }}>
            <input
              type={show ? "text" : "password"}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="password"
              autoFocus
              autoComplete="current-password"
              aria-label="Password"
              style={{
                width: "100%",
                padding: "12px 46px 12px 14px",
                borderRadius: 10,
                border: "1px solid rgba(176, 77, 252, 0.4)",
                background: "rgba(5, 2, 10, 0.6)",
                color: "#e9deff",
                fontFamily: "inherit",
                fontSize: 15,
                letterSpacing: "0.08em",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? "Hide password" : "Show password"}
              title={show ? "Hide password" : "Show password"}
              tabIndex={-1}
              style={{
                position: "absolute",
                right: 6,
                top: "50%",
                transform: "translateY(-50%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 34,
                height: 34,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: 0,
                color: show ? "#b98cff" : "#7a63a8",
              }}
            >
              {show ? (
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>

          {err ? (
            <div style={{ marginTop: 12, fontSize: 12, color: "#ff6b8a", letterSpacing: "0.04em" }}>
              {err}
            </div>
          ) : null}

          <button type="submit" disabled={busy || !pw} style={{ ...primaryBtn(!busy && !!pw), marginTop: 12 }}>
            {busy ? "…" : "ENTER"}
          </button>

          <button type="button" onClick={passkeyLogin} disabled={busy} style={ghostBtn}>
            UNLOCK WITH TOUCH ID
          </button>
        </form>
      )}
    </div>
  );
}
