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

// PREFIX and EXPANDED_PREFIX are structural siblings under "stargate.window."
// (rect. vs expanded.) so no window id can ever make the two collide — an id
// of "expanded.foo" still lands under stargate.window.rect.expanded.foo, not
// on top of the "foo" expanded flag.
const PREFIX = "stargate.window.rect.";
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
    // storage disabled — the write is dropped, the value is not persisted
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
