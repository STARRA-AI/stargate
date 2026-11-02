/** Cinematic motion loops — public/brand/motion (Animation Spec §5). */

import type { HudState } from "@/lib/tokens";

export const MOTION = {
  eyeIdle: "/brand/motion/eye_idle.webm",
  eyeThink: "/brand/motion/eye_think.webm",
  eyeAlert: "/brand/motion/eye_alert.webm",
  /* PERFORMANCE 2026-09-30: points at the 116x116 transcode, not the 960x960
     master. This loop plays FOREVER behind the topbar badge, which CSS draws at
     58x58 (.badge-cine = a 50px badge with inset:-4px) under
     mix-blend-mode:screen — so 960x960 @24fps was decoding ~22.1M px/sec to
     fill a 58px square, ~68x more pixels than the display needs.
     The transcode is a faithful match, verified with ffprobe: same yuv420p (no
     alpha to lose — `screen` does the keying), same 121 frames, same 5.042s,
     same 24fps. 529KB -> 42KB.
     The 960x960 master is still on disk at badge_heartbeat.webm; reverting is
     this one line. */
  badgeHeartbeat: "/brand/motion/badge_heartbeat_116.webm",
  panelBoot: "/brand/motion/panel_boot.webm",
  wordmarkShine: "/brand/motion/wordmark_shine.webm",
} as const;

export type EyeCineKind = "idle" | "think" | "alert" | "none";

/** Map HUD state → cinematic eye weather (rig remains the climate). */
export function eyeCineForHud(hud: HudState): {
  kind: EyeCineKind;
  src: string | null;
  opacity: number;
  loop: boolean;
} {
  switch (hud) {
    case "thinking":
    case "transcribing":
    case "tool":
      return { kind: "think", src: MOTION.eyeThink, opacity: 0.4, loop: true };
    case "error":
      return { kind: "alert", src: MOTION.eyeAlert, opacity: 0.6, loop: false };
    case "offline":
      return { kind: "none", src: null, opacity: 0, loop: false };
    case "idle":
    case "wake":
    case "listening":
    case "streaming":
    case "speaking":
    default:
      return { kind: "idle", src: MOTION.eyeIdle, opacity: 0.22, loop: true };
  }
}

/** Pupil scale by state (Animation Spec §3.4). */
export function pupilScaleForHud(hud: HudState): number {
  switch (hud) {
    case "listening":
    case "wake":
      return 1.12;
    case "thinking":
    case "transcribing":
    case "tool":
      return 0.86;
    case "error":
      return 0.78;
    case "offline":
      return 0.92;
    default:
      return 1;
  }
}
