"use client";

import { useEffect, useRef } from "react";

const DESIGN_W = 1680;
const DESIGN_H = 1000;

/** Scale the fixed 1680×1000 design canvas to fit the viewport. */
export function useStageScale() {
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    const rescale = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const scale = Math.min(vw / DESIGN_W, vh / DESIGN_H);
      el.style.width = `${DESIGN_W}px`;
      el.style.height = `${DESIGN_H}px`;
      el.style.transform = `scale(${scale})`;
      // Published so a dragged window can convert viewport pixels into stage
      // pixels. Without it a drag drifts from the cursor by 1/scale.
      el.style.setProperty("--stage-scale", String(scale));
      el.style.left = `${(vw - DESIGN_W * scale) / 2}px`;
      el.style.top = `${(vh - DESIGN_H * scale) / 2}px`;
    };

    rescale();
    window.addEventListener("resize", rescale);
    return () => window.removeEventListener("resize", rescale);
  }, []);

  return stageRef;
}
