"use client";

/**
 * useCosmetics — the CLIENT's door to /api/engine/cosmetics.
 *
 * WHY IT EXISTS. The Options panel persisted cosmetics to data/engine.json and
 * nothing on the client ever read them back at runtime, so two controls reported
 * a state they did not control: MOUTH SYNC (the real gate was a build-time env
 * read) and IDLE POOL (the real pool was a frozen const). This module is the
 * runtime channel that makes those toggles true.
 *
 * ── THREE NON-NEGOTIABLES ──────────────────────────────────────────────────
 * 1. HER VOICE AND HER FACE OUTRANK THIS. Cosmetics are BEST-EFFORT. The hook
 *    returns its defaults SYNCHRONOUSLY on the very first render and updates
 *    later if a read succeeds. Nothing here is awaited by a render, a rAF tick,
 *    or any audio path. A 401 (logged out), a 404 (engine absent), a 500, a
 *    rejected fetch or a garbage body are all the same thing: keep the defaults,
 *    say nothing to the operator.
 * 2. NO SECRETS. This module is imported by StarraClipFace, a client component —
 *    anything it imports ships to the browser. It imports "react" and the
 *    client-safe "./bus" and NOTHING else. It never touches the SERVER-ONLY
 *    barrel "@/lib/engine", nor config/providers/router/health, nor process.env.
 *    tests/cosmetics-live-hook.test.ts enforces that on the source.
 * 3. NO NEW DEPENDENCY, NO PAID CALL. One plain fetch against a local route.
 *
 * macOS 12 / WKWebView: no AbortSignal.timeout, no structuredClone, no regex
 * lookbehind. Plain fetch, plain state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { clearEngineError, getEngineState, publishEngineError } from "./bus";

/* ────────────────────────────── the contract ───────────────────────────── */

/**
 * The cosmetics shape as the client consumes it. Declared locally rather than
 * imported from the route's `_shared.ts`, which reads process.env — see
 * non-negotiable 2. tests/cosmetics-live-hook.test.ts asserts field-for-field
 * parity with the server's DEFAULT_COSMETICS so this copy cannot drift.
 */
export interface LiveCosmetics {
  accentHue: number;
  glowIntensity: number;
  reduceMotion: boolean;
  idlePool: string[];
  mouthSync: boolean;
  fontScale: number;
}

export const COSMETICS_URL = "/api/engine/cosmetics";

/**
 * MIRROR of src/app/api/engine/_shared.ts DEFAULT_COSMETICS (itself a mirror of
 * the engine store's DEFAULT_COSMETICS, src/lib/engine/config.ts). Third copy by
 * necessity — this module must stay server-free — and guarded by a parity test.
 *
 * mouthSync defaults ON and idlePool defaults to the three vetted clips, so with
 * cosmetics UNAVAILABLE her face behaves exactly as it does today.
 */
export const DEFAULT_LIVE_COSMETICS: LiveCosmetics = {
  accentHue: 271,
  glowIntensity: 1,
  reduceMotion: false,
  idlePool: ["idle_a1", "idle_c1", "idle_a2"],
  mouthSync: true,
  fontScale: 1,
};

/**
 * BOUNDS. These are the NARROW set — the ones the panel's sliders and the route's
 * `cosmeticsSchema` enforce (glowIntensity <= 1.6, fontScale 0.85-1.35).
 *
 * Deliberately narrower than the STORE's sanitizer (src/lib/engine/config.ts
 * RawCosmeticsSchema accepts glowIntensity up to 3 and fontScale 0.5-2), so a
 * hand-edited data/engine.json can hold a value the UI can never produce. The
 * client clamps rather than renders it: an unreadable deck is a real failure mode.
 * Reported to the board as a schema-bounds mismatch to reconcile in the two files
 * this division does not own.
 */
const BOUNDS = {
  accentHue: [0, 360],
  glowIntensity: [0, 1.6],
  fontScale: [0.85, 1.35],
} as const;

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/* ──────────────────────────── pure normalisation ───────────────────────── */

/**
 * Turn ANYTHING into a valid LiveCosmetics. Every bad field falls back to its own
 * default; the good fields around it survive. Never throws, and never returns an
 * empty idlePool (an empty pool would leave her face with nothing to play).
 *
 * Pure and DOM-free, so it is unit-testable without a renderer.
 */
export function normalizeLiveCosmetics(raw: unknown): LiveCosmetics {
  const d = DEFAULT_LIVE_COSMETICS;
  const out: LiveCosmetics = {
    accentHue: d.accentHue,
    glowIntensity: d.glowIntensity,
    reduceMotion: d.reduceMotion,
    idlePool: [...d.idlePool],
    mouthSync: d.mouthSync,
    fontScale: d.fontScale,
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;

  out.accentHue = Math.round(
    clampNum(src.accentHue, BOUNDS.accentHue[0], BOUNDS.accentHue[1], d.accentHue),
  );
  out.glowIntensity = clampNum(
    src.glowIntensity,
    BOUNDS.glowIntensity[0],
    BOUNDS.glowIntensity[1],
    d.glowIntensity,
  );
  out.fontScale = clampNum(
    src.fontScale,
    BOUNDS.fontScale[0],
    BOUNDS.fontScale[1],
    d.fontScale,
  );
  // A non-boolean toggle is DROPPED, never coerced: `"off"` is truthy, and
  // coercing it would flip a gate the operator never touched.
  if (typeof src.reduceMotion === "boolean") out.reduceMotion = src.reduceMotion;
  if (typeof src.mouthSync === "boolean") out.mouthSync = src.mouthSync;

  if (Array.isArray(src.idlePool)) {
    const pool: string[] = [];
    for (const id of src.idlePool) {
      // Clip-id shape only — no path characters, no unbounded strings. The face
      // narrows this further against the vetted pool (starra-clip-map
      // resolveIdlePool); this is just the wire-level sanity pass.
      if (typeof id !== "string") continue;
      if (!/^[a-z0-9_]{1,32}$/.test(id)) continue;
      if (pool.indexOf(id) !== -1) continue;
      pool.push(id);
    }
    // Empty stays DEFAULT — never an empty pool.
    if (pool.length > 0) out.idlePool = pool;
  }

  return out;
}

/* ─────────────────────────────── the read ──────────────────────────────── */

/** The minimal response shape this module consumes. `Response` satisfies it. */
export interface CosmeticsResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Injectable fetch, so the read is testable without a network or a DOM. */
export type CosmeticsFetch = (url: string) => Promise<CosmeticsResponse>;

/** Where a bus error from this module is filed. Scoped so clearing is safe. */
const ERROR_WHERE = "engine/cosmetics";

/**
 * Read cosmetics once. Resolves to null for EVERY failure — non-2xx, rejected
 * fetch, synchronous throw, non-JSON body, missing `cosmetics` object — and never
 * rejects. The caller keeps its defaults on null.
 *
 * Only a genuine SERVER FAULT (5xx) is reported to the engine bus. 401 (logged
 * out), 404 (engine route absent) and an offline network are EXPECTED states on
 * this deck, not faults, and reporting them would put permanent noise in front of
 * Classic for something that is working as designed.
 */
export async function readLiveCosmetics(
  fetchImpl?: CosmeticsFetch,
): Promise<LiveCosmetics | null> {
  try {
    const doFetch: CosmeticsFetch | null =
      fetchImpl ??
      (typeof fetch === "function"
        ? (url: string) => fetch(url, { cache: "no-store" })
        : null);
    if (!doFetch) return null;

    const res = await doFetch(COSMETICS_URL);
    if (!res || typeof res !== "object") return null;
    if (!res.ok) {
      if (res.status >= 500) {
        publishEngineError(ERROR_WHERE, new Error(`cosmetics read failed (HTTP ${res.status})`));
      }
      return null;
    }

    const body = (await res.json()) as { cosmetics?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const c = body.cosmetics;
    if (typeof c !== "object" || c === null || Array.isArray(c)) return null;

    const normalized = normalizeLiveCosmetics(c);
    // A previously-reported fault from THIS module is resolved. Scoped on
    // purpose: clearEngineError() is global, so clearing someone else's error
    // would erase a fault the operator still needs to see.
    try {
      if (getEngineState().lastError?.where === ERROR_WHERE) clearEngineError();
    } catch {
      /* the bus is best-effort observation; never let it affect the read */
    }
    return normalized;
  } catch {
    // Offline, blocked, aborted, or a body that would not parse. Silent by
    // design — the deck must work with the engine absent.
    return null;
  }
}

/* ─────────────────────────────── the hook ──────────────────────────────── */

export interface UseCosmetics {
  /** Always a valid value. Defaults on the first render, live after a read. */
  cosmetics: LiveCosmetics;
  /** True once a read has SUCCEEDED. False means "these are the defaults". */
  loaded: boolean;
  /** Re-read now. Fire-and-forget; never throws, never returns a promise. */
  refresh: () => void;
}

/**
 * Subscribe a client component to live cosmetics.
 *
 * FIRST PAINT IS NEVER BLOCKED: state is seeded with DEFAULT_LIVE_COSMETICS, so
 * the first render is synchronous and identical to today's shipped behaviour. The
 * fetch runs in an effect (after paint) and, if it succeeds, swaps the value in.
 * If it fails, nothing changes and nothing is shown to the operator.
 *
 * No polling. Cosmetics change when the operator changes them, and the panel that
 * changes them lives in the same tab; `refresh()` is the explicit re-read.
 */
export function useCosmetics(): UseCosmetics {
  const [cosmetics, setCosmetics] = useState<LiveCosmetics>(DEFAULT_LIVE_COSMETICS);
  const [loaded, setLoaded] = useState(false);
  // Guards a setState after unmount, and lets refresh() reuse one code path.
  const aliveRef = useRef(true);

  const load = useCallback(() => {
    void readLiveCosmetics()
      .then((next) => {
        if (!aliveRef.current || !next) return;
        setCosmetics(next);
        setLoaded(true);
      })
      .catch(() => {
        /* readLiveCosmetics already swallows everything; belt and braces */
      });
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  return { cosmetics, loaded, refresh: load };
}
