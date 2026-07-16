"use client";

import { useEffect, useRef } from "react";

/**
 * STARRA's living eye — the reactor core tracks the operator's cursor
 * like an iris, with smooth easing, bounded travel inside the inner ring,
 * blinks, idle saccades, and a subtle parallax on the HUD rings.
 *
 * The deck stage is a fixed 1680x1000 canvas scaled via transform, so
 * cursor direction is computed in client space from the eye's rendered
 * center, then converted to stage pixels for the bounded offset.
 */

const MAX_TRAVEL = 62; // stage px — stays inside the 250px inner ring
const FOLLOW_GAIN = 0.16; // fraction of cursor distance the iris moves
const LERP = 0.1; // easing toward gaze target per frame
const IDLE_AFTER_MS = 4000;
const BLINK_MS = 150;

type Vec = { x: number; y: number };

export function ReactorEye({
  speaking,
  label,
  onMic,
}: {
  speaking: boolean;
  label: string;
  onMic?: () => void;
}) {
  const centerRef = useRef<HTMLDivElement>(null);
  const eyeRef = useRef<HTMLDivElement>(null);
  const ringOuterRef = useRef<HTMLDivElement>(null);
  const ringInnerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const eyeEl = eyeRef.current;
    const centerEl = centerRef.current;
    if (!eyeEl || !centerEl) return;

    const gaze: Vec = { x: 0, y: 0 };
    const target: Vec = { x: 0, y: 0 };
    let lastMouseAt = 0;
    let cursorInWindow = false;
    let nextSaccadeAt = performance.now() + 2500;
    let nextBlinkAt = performance.now() + 3200;
    let blinkStartedAt = -1;
    let raf = 0;

    const stageScale = () => {
      const stage = document.getElementById("stage");
      if (!stage) return 1;
      return stage.getBoundingClientRect().width / 1680 || 1;
    };

    const onMouseMove = (ev: MouseEvent) => {
      lastMouseAt = performance.now();
      cursorInWindow = true;
      const rect = centerEl.getBoundingClientRect();
      const scale = stageScale();
      const dx = (ev.clientX - rect.left) / scale;
      const dy = (ev.clientY - rect.top) / scale;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) return;
      const travel = Math.min(dist * FOLLOW_GAIN, MAX_TRAVEL);
      target.x = (dx / dist) * travel;
      target.y = (dy / dist) * travel;
    };

    const onMouseLeave = () => {
      cursorInWindow = false;
      target.x = 0;
      target.y = 0;
    };

    const frame = (now: number) => {
      // Idle life: gentle drift + occasional saccade when cursor is quiet
      const idle = !cursorInWindow || now - lastMouseAt > IDLE_AFTER_MS;
      if (idle) {
        if (now >= nextSaccadeAt) {
          const angle = Math.random() * Math.PI * 2;
          const radius = Math.random() * MAX_TRAVEL * 0.45;
          target.x = Math.cos(angle) * radius;
          target.y = Math.sin(angle) * radius * 0.7;
          nextSaccadeAt = now + 1800 + Math.random() * 3200;
        }
        // slow breathing wander layered on top
        target.x += Math.sin(now / 2300) * 0.06;
        target.y += Math.cos(now / 2900) * 0.05;
      }

      gaze.x += (target.x - gaze.x) * LERP;
      gaze.y += (target.y - gaze.y) * LERP;

      // Blink: quick scale-y squash, occasionally a double blink
      let blinkScale = 1;
      if (blinkStartedAt >= 0) {
        const t = (now - blinkStartedAt) / BLINK_MS;
        if (t >= 1) {
          blinkStartedAt = -1;
          nextBlinkAt =
            now +
            (Math.random() < 0.18
              ? 260 // double blink
              : 2800 + Math.random() * 3800);
        } else {
          // 1 → 0.08 → 1 triangle
          blinkScale = t < 0.5 ? 1 - t * 2 * 0.92 : 0.08 + (t - 0.5) * 2 * 0.92;
        }
      } else if (now >= nextBlinkAt) {
        blinkStartedAt = now;
      }

      eyeEl.style.transform = `translate(${gaze.x}px, ${gaze.y}px) scaleY(${blinkScale})`;
      if (ringInnerRef.current) {
        ringInnerRef.current.style.transform = `translate(${gaze.x * 0.18}px, ${gaze.y * 0.18}px)`;
      }
      if (ringOuterRef.current) {
        ringOuterRef.current.style.transform = `translate(${gaze.x * 0.08}px, ${gaze.y * 0.08}px)`;
      }

      raf = requestAnimationFrame(frame);
    };

    window.addEventListener("mousemove", onMouseMove);
    document.documentElement.addEventListener("mouseleave", onMouseLeave);
    window.addEventListener("blur", onMouseLeave);
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMouseMove);
      document.documentElement.removeEventListener("mouseleave", onMouseLeave);
      window.removeEventListener("blur", onMouseLeave);
    };
  }, []);

  return (
    <div className="reactor-stage">
      <div className="reactor" ref={centerRef}>
        <div className="ring-parallax" ref={ringOuterRef}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="ring ring-outer" src="/brand/hud_ring.png" alt="" />
        </div>
        <div className="ring-parallax" ref={ringInnerRef}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="ring ring-inner" src="/brand/hud_ring.png" alt="" />
        </div>
        <div className="eye" ref={eyeRef}>
          <button
            type="button"
            className={`reactor-core${speaking ? " speaking" : ""}`}
            id="reactor-core"
            aria-label="Activate voice"
            onClick={onMic}
          />
        </div>
        <div className="reactor-status">
          <span id="core-status">{label}</span>
          <span className="reactor-cursor" />
        </div>
      </div>
    </div>
  );
}
