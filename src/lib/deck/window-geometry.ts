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
