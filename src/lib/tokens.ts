/** Design Spec §3 semantic tokens */
export const TOKENS = {
  void: "#0a0414",
  void2: "#140826",
  chrome: "#e9d5ff",
  purple: "#a855f7",
  magenta: "#d946ef",
  star: "#c4b5fd",
  danger: "#ff3d81",
  ok: "#8b5cf6",
} as const;

export type HudState =
  | "idle"
  | "wake"
  | "listening"
  | "transcribing"
  | "thinking"
  | "streaming"
  | "speaking"
  | "tool"
  | "error"
  | "offline";
