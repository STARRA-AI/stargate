"use client";

/**
 * OPTIONS — the engine's operator surface.
 *
 * SECRET DISCIPLINE, PROVEN BY THE IMPORT GRAPH: this file imports React and its
 * own stylesheet. NOTHING else. It does not import `@/lib/engine`,
 * `@/lib/keys`, `@/lib/security/redact`, or the routes' `_shared.ts` — anything
 * a client component imports is public, and those modules read process.env.
 * Every type below is declared locally on purpose; the only channel to the
 * server is fetch() against /api/engine/*, which returns masked views only.
 * A key is written by the operator and never read back — there is no reveal
 * path in this component or in the routes behind it.
 *
 * VOICE OUTRANKS EVERYTHING: nothing here awaits, gates, or touches the audio
 * path. Every fetch is fire-and-forget with a catch, the panel renders from
 * defaults when the engine is unreachable, and the edge tab sits below the call
 * overlay's z-index so a live call is never covered.
 *
 * macOS 12 / WKWebView: no regex lookbehind, no AbortSignal.timeout, no
 * structuredClone. Plain fetch, plain state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import "@/styles/options.css";

/* ─────────────────────────── local wire types ─────────────────────────── */

type ProviderView = {
  id: string;
  label: string;
  capabilities: string[];
  paid: boolean;
  local: boolean;
  enabled: boolean;
  status: string;
  hasKey: boolean;
  last4: string | null;
  /** Env var NAMES backing this provider. Names only — never values. */
  envKeys: string[];
  detail: string;
  notes: string;
};

type ChainLinkView = { id: string; eligible: boolean; status: string; why: string };

type ResolutionView = {
  capability: string;
  providerId: string | null;
  why: string;
  chain: ChainLinkView[];
};

type Fault = {
  severity: "error" | "warn";
  what: string;
  fix: string;
  capability?: string;
  providerId?: string;
};

type StatusPayload = {
  ok: boolean;
  probed: boolean;
  checkedAt: string;
  capabilities: ResolutionView[];
  providers: ProviderView[];
  broken: Fault[];
};

type Cosmetics = {
  accentHue: number;
  glowIntensity: number;
  reduceMotion: boolean;
  idlePool: string[];
  mouthSync: boolean;
  fontScale: number;
  /** "still" = base_loop + composited mouth (shipped). "alive" = the moving
   *   832x1248 anchor family. See starra-clip-map.ts ALIVE_POOL. */
  bodyMode: "still" | "alive";
};

type ProbeResult = {
  ok: boolean;
  probed: boolean;
  status: string;
  latencyMs: number;
  detail: string;
  error: string | null;
};

/* ──────────────────────────────── defaults ────────────────────────────── */

/** Mirrors DEFAULT_COSMETICS in src/app/api/engine/_shared.ts. Duplicated by
 *  design — see the import-graph note above. Kept in sync by
 *  tests/engine-api-cosmetics-parity.test.ts. */
const DEFAULT_COSMETICS: Cosmetics = {
  accentHue: 271,
  glowIntensity: 1,
  reduceMotion: false,
  idlePool: ["idle_a1", "idle_c1", "idle_a2"],
  mouthSync: true,
  fontScale: 1,
  bodyMode: "still",
};


/* ───────────────────────────────── utils ─────────────────────────────── */

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Apply cosmetics as CSS custom properties on <html>. No rebuild, no reload.
 * `--purple` / `--magenta` / `--star` are re-derived from one hue, and every
 * downstream token in globals.css + deck.css is a color-mix over those, so the
 * whole deck follows. `--void` is never touched — dark-only is not negotiable.
 *
 * Hue offsets are measured from the shipped palette, not invented:
 *   #a855f7 → hsl(271 91% 65%)   (base)
 *   #d946ef → hsl(292 84% 61%)   (base + 21)
 *   #c4b5fd → hsl(253 95% 85%)   (base - 18)
 * So at accentHue 271 — the default, and the engine's stored default too
 * (src/lib/engine/config.ts:92) — this reproduces the shipped deck exactly.
 */
function applyCosmetics(c: Cosmetics): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root?.style) return; // guard: nothing here may throw into a render
  const hue = clamp(c.accentHue, 0, 360);
  root.style.setProperty("--purple", `hsl(${hue} 91% 65%)`);
  root.style.setProperty("--magenta", `hsl(${(hue + 21) % 360} 84% 61%)`);
  root.style.setProperty("--star", `hsl(${(hue + 342) % 360} 95% 85%)`);
  root.style.setProperty("--glow-intensity", String(clamp(c.glowIntensity, 0, 1.6)));
  root.style.setProperty("--font-scale", String(clamp(c.fontScale, 0.85, 1.35)));
  root.setAttribute("data-starra-cosmetics", "1");
  root.setAttribute("data-reduce-motion", c.reduceMotion ? "1" : "0");
}

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const STATUS_LABEL: Record<string, string> = {
  ok: "OK",
  configured: "CONFIGURED",
  "missing-key": "NO KEY",
  unreachable: "UNREACHABLE",
  disabled: "DISABLED",
  unknown: "UNKNOWN",
};

function statusTone(s: string): string {
  if (s === "ok") return "good";
  if (s === "configured") return "idle";
  if (s === "missing-key" || s === "unreachable") return "bad";
  return "dim";
}

/* ────────────────────────────── the panel ────────────────────────────── */

export function OptionsPanel() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [cosmetics, setCosmetics] = useState<Cosmetics>(DEFAULT_COSMETICS);
  const [engineFault, setEngineFault] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmPaidFor, setConfirmPaidFor] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});

  /** Key inputs are UNCONTROLLED and read through refs on save, so a typed key
   *  never enters React state and never appears in a render tree. */
  const keyInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── cosmetics load: runs whether or not the panel is open, so persisted
        look-and-feel takes effect on deck boot. ── */
  useEffect(() => {
    let alive = true;
    fetch("/api/engine/cosmetics", { cache: "no-store" })
      .then((r) => (r.ok ? readJson<{ cosmetics: Cosmetics }>(r) : null))
      .then((d) => {
        if (!alive || !d?.cosmetics) return;
        setCosmetics(d.cosmetics);
        applyCosmetics(d.cosmetics);
      })
      .catch(() => {
        /* engine not up yet — deck keeps its shipped look. Never surface noise. */
      });
    return () => {
      alive = false;
    };
  }, []);

  /** `deep` runs the engine's real health probes (?probe=1). Used on open and on
   *  RECHECK only — the 8s poll stays cheap so nothing hammers an upstream. */
  const loadStatus = useCallback(async (deep = false) => {
    try {
      const res = await fetch(`/api/engine/status${deep ? "?probe=1" : ""}`, {
        cache: "no-store",
      });
      if (res.status === 401) {
        setEngineFault("Session expired. Reload the deck to sign in again.");
        return;
      }
      const body = await readJson<StatusPayload & { error?: string }>(res);
      if (!res.ok || !body || body.error) {
        setEngineFault(body?.error ?? `Engine did not answer (HTTP ${res.status}).`);
        setStatus(null);
        return;
      }
      setEngineFault(null);
      setStatus(body);
    } catch {
      setEngineFault("Engine unreachable. Deck and voice are unaffected.");
      setStatus(null);
    }
  }, []);

  /* ── poll status only while open: zero background cost when closed ── */
  useEffect(() => {
    if (!open) return;
    void loadStatus(true); // one deep pass on open
    const id = setInterval(() => void loadStatus(false), 8000);
    return () => clearInterval(id);
  }, [open, loadStatus]);

  /* ── Escape closes ── */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  /* ── cosmetics: apply instantly, persist debounced ── */
  const patchCosmetics = useCallback(
    (patch: Partial<Cosmetics>) => {
      setCosmetics((prev) => {
        const next = { ...prev, ...patch };
        applyCosmetics(next);
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          fetch("/api/engine/cosmetics", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          }).catch(() => setNotice("Could not persist cosmetics. Applied locally."));
        }, 400);
        return next;
      });
    },
    [],
  );

  /* ── provider writes ── */
  const postProvider = useCallback(
    async (body: { id: string; key?: string; enabled?: boolean; confirmPaid?: boolean }) => {
      setBusy(body.id);
      setNotice(null);
      try {
        const res = await fetch("/api/engine/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await readJson<{ ok?: boolean; masked?: string | null; error?: string }>(res);
        if (!res.ok || data?.error) {
          setNotice(data?.error ?? `Write refused (HTTP ${res.status}).`);
          return false;
        }
        // The response carries a masked form at most. Nothing to render but the mask.
        setNotice(
          body.key !== undefined
            ? body.key.trim()
              ? `Key stored — ${data?.masked ?? "masked"}.`
              : "Key override cleared. Falling back to .env.local."
            : `Updated ${body.id}.`,
        );
        await loadStatus();
        return true;
      } catch {
        setNotice("Write failed — engine unreachable.");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [loadStatus],
  );

  const saveKey = useCallback(
    async (id: string) => {
      const el = keyInputs.current[id];
      if (!el) return;
      const value = el.value;
      const ok = await postProvider({ id, key: value });
      // Wipe the field either way — a key must not linger in the DOM.
      if (ok || !ok) el.value = "";
    },
    [postProvider],
  );

  const runProbe = useCallback(async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch("/api/engine/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await readJson<ProbeResult & { error?: string }>(res);
      setProbes((p) => ({
        ...p,
        [id]: {
          ok: Boolean(data?.ok),
          probed: data?.probed !== false,
          status: data?.status ?? "unknown",
          latencyMs: typeof data?.latencyMs === "number" ? data.latencyMs : 0,
          detail: data?.detail ?? "",
          error: data?.error ?? null,
        },
      }));
    } catch {
      setProbes((p) => ({
        ...p,
        [id]: {
          ok: false,
          probed: true,
          status: "unreachable",
          latencyMs: 0,
          detail: "",
          error: "probe did not run",
        },
      }));
    } finally {
      setBusy(null);
    }
  }, []);

  const toggleProvider = useCallback(
    (p: ProviderView) => {
      if (p.enabled) {
        setConfirmPaidFor(null);
        void postProvider({ id: p.id, enabled: false });
        return;
      }
      if (p.paid) {
        // Explicit confirm step. No paid provider is ever enabled in one click.
        setConfirmPaidFor(p.id);
        return;
      }
      void postProvider({ id: p.id, enabled: true });
    },
    [postProvider],
  );

  const providers = status?.providers ?? [];
  const resolutions = status?.capabilities ?? [];
  const faults = status?.broken ?? [];

  return (
    <>
      {/* Right-gutter edge tab. The deck's stage panels are inset 22px from the
          right (deck.css #stage panels), so this gutter is empty by design — the
          tab collides with no existing chrome. z-index 40 keeps it under the
          voice call overlay (z 60): a live call is never covered. */}
      <button
        type="button"
        className="opt-tab"
        aria-expanded={open}
        aria-controls="opt-panel"
        onClick={() => setOpen((v) => !v)}
      >
        OPTIONS
      </button>

      {open && (
        <>
          <div className="opt-scrim" onClick={() => setOpen(false)} aria-hidden />
          <aside
            id="opt-panel"
            className="opt-panel"
            role="dialog"
            aria-modal="false"
            aria-label="Engine options"
          >
            <header className="opt-head">
              <div>
                <h2 className="opt-title">ENGINE OPTIONS</h2>
                <p className="opt-sub">
                  {status
                    ? `${status.probed ? "Probed" : "Read"} ${new Date(
                        status.checkedAt,
                      ).toLocaleTimeString()}`
                    : "Reading engine…"}
                </p>
              </div>
              <div className="opt-head-actions">
                <button type="button" className="opt-btn" onClick={() => void loadStatus(true)}>
                  RECHECK
                </button>
                <button type="button" className="opt-btn" onClick={() => setOpen(false)}>
                  CLOSE
                </button>
              </div>
            </header>

            {engineFault && (
              <p className="opt-fault" role="status">
                ENGINE — {engineFault}
              </p>
            )}
            {notice && (
              <p className="opt-notice" role="status">
                {notice}
              </p>
            )}

            {/* ── 1. PROVIDERS AND KEYS ── */}
            <section className="opt-section">
              <h3 className="opt-h3">PROVIDERS AND KEYS</h3>
              <p className="opt-note">
                Keys are stored server-side and never sent back to this screen. Only the last four
                characters are ever shown. Paste a new key to replace one; save an empty field to
                clear the override and fall back to .env.local.
              </p>

              {providers.length === 0 && !engineFault && (
                <p className="opt-empty">No providers reported.</p>
              )}

              {providers.map((p) => {
                const probe = probes[p.id];
                const confirming = confirmPaidFor === p.id;
                return (
                  <div className="opt-provider" key={p.id} data-paid={p.paid ? "1" : "0"}>
                    <div className="opt-provider-top">
                      <span className="opt-provider-label">{p.label}</span>
                      <span className={`opt-badge ${p.paid ? "paid" : "free"}`}>
                        {p.paid ? "PAID" : "FREE"}
                      </span>
                      <span className={`opt-pill ${statusTone(p.status)}`}>
                        {STATUS_LABEL[p.status] ?? p.status.toUpperCase()}
                      </span>
                      <span className="opt-spacer" />
                      <button
                        type="button"
                        className="opt-btn"
                        disabled={busy === p.id}
                        onClick={() => toggleProvider(p)}
                        aria-pressed={p.enabled}
                      >
                        {p.enabled ? "DISABLE" : "ENABLE"}
                      </button>
                    </div>

                    <div className="opt-provider-meta">
                      <span>{p.capabilities.length ? p.capabilities.join(" · ") : "no capability"}</span>
                      <span>
                        {p.local
                          ? "LOCAL — NO KEY NEEDED"
                          : p.hasKey
                            ? `KEY ••••${p.last4 ?? "????"}`
                            : "NO KEY LINKED"}
                      </span>
                      {p.envKeys.length > 0 && <span>{p.envKeys.join(" · ")}</span>}
                    </div>
                    {p.detail && <p className="opt-why">{p.detail}</p>}

                    {confirming && (
                      <div className="opt-confirm">
                        <p>
                          {p.label} bills per request. Enabling it will spend real money. STARRA runs
                          on the free path without it.
                        </p>
                        <div className="opt-row">
                          <button
                            type="button"
                            className="opt-btn danger"
                            disabled={busy === p.id}
                            onClick={() => {
                              setConfirmPaidFor(null);
                              void postProvider({ id: p.id, enabled: true, confirmPaid: true });
                            }}
                          >
                            CONFIRM SPEND
                          </button>
                          <button
                            type="button"
                            className="opt-btn"
                            onClick={() => setConfirmPaidFor(null)}
                          >
                            CANCEL
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="opt-row">
                      {!p.local && (
                      <input
                        ref={(el) => {
                          keyInputs.current[p.id] = el;
                        }}
                        className="opt-input"
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        aria-label={`${p.label} key`}
                        placeholder={
                          p.hasKey
                            ? `stored ••••${p.last4 ?? "????"} — paste to replace`
                            : "paste key"
                        }
                      />
                      )}
                      {!p.local && (
                      <button
                        type="button"
                        className="opt-btn"
                        disabled={busy === p.id}
                        onClick={() => void saveKey(p.id)}
                      >
                        SAVE
                      </button>
                      )}
                      <button
                        type="button"
                        className="opt-btn"
                        disabled={busy === p.id}
                        onClick={() => void runProbe(p.id)}
                      >
                        TEST
                      </button>
                    </div>

                    {probe && (
                      <p
                        className={`opt-probe ${probe.ok ? "good" : probe.probed ? "bad" : "dim"}`}
                      >
                        {probe.ok
                          ? `PROBE OK — ${probe.latencyMs}ms${probe.detail ? ` — ${probe.detail}` : ""}`
                          : probe.probed
                            ? `PROBE FAILED — ${probe.status}${probe.error ? ` — ${probe.error}` : ""}`
                            : `NO PROBE — ${probe.detail || probe.status}`}
                      </p>
                    )}
                  </div>
                );
              })}
            </section>

            {/* ── 2. CAPABILITY ROUTING ── */}
            <section className="opt-section">
              <h3 className="opt-h3">CAPABILITY ROUTING</h3>
              <p className="opt-note">
                Ordered fallback per capability. The router takes the first provider that is enabled,
                configured and healthy, and it will not route to a paid provider unless you enabled
                it above.
              </p>
              {resolutions.length === 0 && !engineFault && (
                <p className="opt-empty">No routing reported.</p>
              )}
              {resolutions.map((r) => (
                <div className="opt-cap" key={r.capability}>
                  <div className="opt-cap-top">
                    <span className="opt-cap-name">{r.capability.toUpperCase()}</span>
                    <span className={`opt-pill ${r.providerId ? "good" : "bad"}`}>
                      {r.providerId ? `LIVE · ${r.providerId}` : "NO PROVIDER"}
                    </span>
                  </div>
                  {r.why && <p className="opt-why">{r.why}</p>}
                  {r.chain.length > 0 && (
                    <ol className="opt-chain">
                      {r.chain.map((link) => (
                        <li
                          key={`${r.capability}-${link.id}`}
                          className={link.eligible ? "eligible" : "skipped"}
                          title={link.why || link.status}
                        >
                          {link.id}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              ))}
            </section>

            {/* ── 3. COSMETICS ── */}
            <section className="opt-section">
              <h3 className="opt-h3">COSMETICS</h3>
              <p className="opt-note">
                Applied live as CSS custom properties on the root element — no rebuild, no reload.
                Persisted server-side so the deck boots this way next time.
              </p>

              <label className="opt-field">
                <span>
                  ACCENT HUE <em>{cosmetics.accentHue}</em>
                </span>
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={1}
                  value={cosmetics.accentHue}
                  onChange={(e) => patchCosmetics({ accentHue: Number(e.target.value) })}
                />
              </label>

              <label className="opt-field">
                <span>
                  GLOW <em>{cosmetics.glowIntensity.toFixed(2)}</em>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1.6}
                  step={0.05}
                  value={cosmetics.glowIntensity}
                  onChange={(e) => patchCosmetics({ glowIntensity: Number(e.target.value) })}
                />
              </label>

              <label className="opt-field">
                <span>
                  TYPE SCALE <em>{cosmetics.fontScale.toFixed(2)}</em>
                </span>
                <input
                  type="range"
                  min={0.85}
                  max={1.35}
                  step={0.05}
                  value={cosmetics.fontScale}
                  onChange={(e) => patchCosmetics({ fontScale: Number(e.target.value) })}
                />
              </label>

              <div className="opt-row opt-toggles">
                <button
                  type="button"
                  className="opt-btn"
                  aria-pressed={cosmetics.reduceMotion}
                  onClick={() => patchCosmetics({ reduceMotion: !cosmetics.reduceMotion })}
                >
                  REDUCE MOTION · {cosmetics.reduceMotion ? "ON" : "OFF"}
                </button>
                <button
                  type="button"
                  className="opt-btn"
                  aria-pressed={cosmetics.mouthSync}
                  onClick={() => patchCosmetics({ mouthSync: !cosmetics.mouthSync })}
                >
                  MOUTH SYNC · {cosmetics.mouthSync ? "ON" : "OFF"}
                </button>
                <button
                  type="button"
                  className="opt-btn"
                  aria-pressed={cosmetics.bodyMode === "alive"}
                  onClick={() =>
                    patchCosmetics({
                      bodyMode: cosmetics.bodyMode === "alive" ? "still" : "alive",
                    })
                  }
                >
                  BODY · {cosmetics.bodyMode === "alive" ? "ALIVE" : "STILL"}
                </button>
              </div>
              <p className="opt-note">
                Mouth sync drives the viseme patch from her live audio. It never gates playback — her
                voice plays either way.
              </p>
              <p className="opt-note">
                BODY picks which footage she is. STILL is the shipped one: base_loop holds a single
                pose forever and the viseme patch moves her mouth, so speech is genuinely synced to
                her words. ALIVE plays her 832x1248 anchor clips — she nods, glances, tilts, laughs
                and raises an eyebrow between turns, at higher resolution — but her mouth then runs
                on her real talking footage, which moves photorealistically without matching the
                actual words. Measured 2026-08-22: every seam in that family is 0.81x-1.17x the
                loop seam base_loop already ships, so the switching is invisible. The two families
                cannot cut into each other, which is why this is a choice. Takes effect on her next
                call — it never tears her face down mid-call.
              </p>

              <div className="opt-field opt-field-col">
                <span>FACE ENGINE — CURRENT STATE</span>
                <p className="opt-note">
                  Continuous body: one clip (base_loop) loops forever and the viseme engine
                  composites her mouth from live audio — 16 real-footage shapes, nose-clear
                  placement, full articulation. The old idle-clip pool is RETIRED: no clip
                  switching exists any more, so there is nothing to configure here. Voice is
                  Eve on every surface (call, typed replies, briefing). Memory, transcripts
                  and facts are one shared store across chat and calls. BRIEF on the deck
                  header opens the morning briefing call.
                </p>
              </div>
            </section>

            {/* ── 4. DIAGNOSTICS ── */}
            <section className="opt-section">
              <h3 className="opt-h3">DIAGNOSTICS</h3>
              <p className="opt-note">What is broken right now, and the move that fixes it.</p>

              {engineFault ? (
                <p className="opt-empty">Engine did not answer. Nothing else to report.</p>
              ) : faults.length === 0 ? (
                <p className="opt-clear">All capabilities resolved. No spend enabled.</p>
              ) : (
                <ul className="opt-faults">
                  {faults.map((f, i) => (
                    <li key={`${f.severity}-${i}`} className={f.severity}>
                      <span className="opt-fault-tag">
                        {f.severity === "error" ? "FAULT" : "WARN"}
                      </span>
                      <span className="opt-fault-what">{f.what}</span>
                      <span className="opt-fault-fix">{f.fix}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </>
      )}
    </>
  );
}

export default OptionsPanel;
