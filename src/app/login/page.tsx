"use client";

import { useState, type FormEvent } from "react";

export default function LoginPage() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

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
        const params = new URLSearchParams(window.location.search);
        window.location.href = params.get("next") || "/";
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

  return (
    <div
      style={{
        minHeight: "100vh",
        margin: 0,
        display: "grid",
        placeItems: "center",
        background:
          "radial-gradient(circle at 50% 42%, #0d0620 0%, #05020a 60%, #000 100%)",
        fontFamily: "ui-monospace, Menlo, monospace",
        color: "#c9b8ff",
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: "min(360px, 90vw)",
          padding: "34px 28px",
          borderRadius: 16,
          background: "rgba(12, 5, 24, 0.72)",
          border: "1px solid rgba(176, 77, 252, 0.34)",
          boxShadow: "0 0 40px rgba(176, 77, 252, 0.22)",
          backdropFilter: "blur(10px)",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: 12,
            letterSpacing: "0.34em",
            fontWeight: 700,
            color: "#b98cff",
          }}
        >
          STARGATE
        </div>
        <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "#7a63a8", marginTop: 6 }}>
          OPERATOR ACCESS
        </div>

        <div style={{ position: "relative", marginTop: 26 }}>
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

        <button
          type="submit"
          disabled={busy || !pw}
          style={{
            width: "100%",
            marginTop: 18,
            padding: "12px 14px",
            borderRadius: 10,
            border: "1px solid rgba(176, 77, 252, 0.5)",
            background: busy || !pw ? "rgba(176,77,252,0.12)" : "rgba(176, 77, 252, 0.28)",
            color: "#f2e9ff",
            fontFamily: "inherit",
            fontSize: 13,
            letterSpacing: "0.16em",
            cursor: busy || !pw ? "default" : "pointer",
          }}
        >
          {busy ? "…" : "ENTER"}
        </button>
      </form>
    </div>
  );
}
