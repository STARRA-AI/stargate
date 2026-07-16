"use client";

import { useEffect, useRef, type RefObject } from "react";

type Opts = {
  src: string | null;
  active: boolean;
  loop: boolean;
  /** When false, pause and keep at opacity 0 (ECO / reduced-motion / hidden). */
  allowPlay: boolean;
};

/**
 * Drive a muted <video> for cinematic overlays.
 * Pauses when inactive, hidden, or ECO — never burns GPU on invisible loops.
 */
export function useCineVideo(
  videoRef: RefObject<HTMLVideoElement | null>,
  { src, active, loop, allowPlay }: Opts,
) {
  const lastSrc = useRef<string | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    el.loop = loop;
    el.muted = true;
    el.playsInline = true;

    if (!src || !allowPlay || !active) {
      el.pause();
      return;
    }

    if (lastSrc.current !== src) {
      el.src = src;
      lastSrc.current = src;
      el.load();
    }

    const play = () => {
      void el.play().catch(() => {
        /* autoplay policy / missing file — rig-only degrade */
      });
    };

    if (el.readyState >= 2) play();
    else el.addEventListener("canplay", play, { once: true });

    return () => {
      el.removeEventListener("canplay", play);
    };
  }, [videoRef, src, active, loop, allowPlay]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const onVis = () => {
      if (document.hidden) el.pause();
      else if (allowPlay && active && src) void el.play().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [videoRef, allowPlay, active, src]);
}
