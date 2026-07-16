"use client";

import { useCameraGaze } from "@/lib/vision/useCameraGaze";
import { useEffect, useRef } from "react";

/**
 * STARRA's living eye — swirling HUD rings + iris that tracks the
 * operator's cursor and (when armed) their face/motion via webcam.
 * Think J.A.R.V.I.S.: she watches, she blinks, she is alive.
 *
 * The deck stage is a fixed 1680×1000 canvas scaled via transform, so
 * cursor direction is computed in client space from the eye's rendered
 * center, then converted to stage pixels for the bounded offset.
 */

const MAX_TRAVEL = 62; // stage px — stays inside the 250px inner ring
const FOLLOW_GAIN = 0.16;
const CAMERA_GAIN = 48; // stage px at full |gaze| = 1
const LERP = 0.12;
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
  const { active: camActive, error: camError, gazeRef: camGaze, toggle: toggleCam } =
    useCameraGaze();

  useEffect(() => {
    const eyeEl = eyeRef.current;
    const centerEl = centerRef.current;
    if (!eyeEl || !centerEl) return;

    const gaze: Vec = { x: 0, y: 0 };
    const cursorTarget: Vec = { x: 0, y: 0 };
    let lastMouseAt = 0;
    let cursorInWindow = false;
    let nextSaccadeAt = performance.now() + 2500;
    let nextBlinkAt = performance.now() + 3200;
    let blinkStartedAt = -1;
    let raf = 0;

    let cachedScale = 1;
    let scaleAt = 0;
    let frameCount = 0;
    let mouseMoveCount = 0;
    let lastLogAt = 0;
    let ecoPaused = false;

    const stageScale = () => {
      const now = performance.now();
      // Cache scale briefly — getBoundingClientRect every mousemove thrashs layout
      if (now - scaleAt < 250) return cachedScale;
      const stage = document.getElementById("stage");
      if (!stage) return cachedScale;
      cachedScale = stage.getBoundingClientRect().width / 1680 || 1;
      scaleAt = now;
      return cachedScale;
    };

    const onMouseMove = (ev: MouseEvent) => {
      lastMouseAt = performance.now();
      cursorInWindow = true;
      mouseMoveCount += 1;
      const rect = centerEl.getBoundingClientRect();
      const scale = stageScale();
      const dx = (ev.clientX - rect.left) / scale;
      const dy = (ev.clientY - rect.top) / scale;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) return;
      const travel = Math.min(dist * FOLLOW_GAIN, MAX_TRAVEL);
      cursorTarget.x = (dx / dist) * travel;
      cursorTarget.y = (dy / dist) * travel;
    };

    const onMouseLeave = () => {
      cursorInWindow = false;
      cursorTarget.x = 0;
      cursorTarget.y = 0;
    };

    const frame = (now: number) => {
      // ECO / low-power: skip iris RAF work (CSS anims already stilled)
      ecoPaused = document.body.classList.contains("low-power");
      if (ecoPaused) {
        frameCount += 1;
        if (now - lastLogAt > 2000) {
          // #region agent log
          fetch(
            "http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Debug-Session-Id": "f8c9f7",
              },
              body: JSON.stringify({
                sessionId: "f8c9f7",
                location: "ReactorEye.tsx:frame",
                message: "eye RAF eco-paused",
                data: { frameCount, mouseMoveCount, ecoPaused: true },
                timestamp: Date.now(),
                hypothesisId: "H-E1",
                runId: "pre",
              }),
            },
          ).catch(() => {});
          // #endregion
          lastLogAt = now;
        }
        // ECO: poll at ~4Hz instead of 60fps idle work
        raf = window.setTimeout(
          () => {
            raf = requestAnimationFrame(frame);
          },
          250,
        ) as unknown as number;
        return;
      }

      const target: Vec = { x: 0, y: 0 };

      // Camera gaze takes priority when armed and seeing motion/face
      const cam = camGaze.current;
      const camMag = Math.hypot(cam.x, cam.y);
      const useCam = camMag > 0.08;

      if (useCam) {
        target.x = cam.x * CAMERA_GAIN;
        target.y = cam.y * CAMERA_GAIN;
        const mag = Math.hypot(target.x, target.y);
        if (mag > MAX_TRAVEL) {
          target.x = (target.x / mag) * MAX_TRAVEL;
          target.y = (target.y / mag) * MAX_TRAVEL;
        }
      } else if (cursorInWindow && now - lastMouseAt <= IDLE_AFTER_MS) {
        target.x = cursorTarget.x;
        target.y = cursorTarget.y;
      } else {
        // Idle life: gentle drift + occasional saccade
        if (now >= nextSaccadeAt) {
          const angle = Math.random() * Math.PI * 2;
          const radius = Math.random() * MAX_TRAVEL * 0.45;
          cursorTarget.x = Math.cos(angle) * radius;
          cursorTarget.y = Math.sin(angle) * radius * 0.7;
          nextSaccadeAt = now + 1800 + Math.random() * 3200;
        }
        target.x = cursorTarget.x + Math.sin(now / 2300) * 0.06;
        target.y = cursorTarget.y + Math.cos(now / 2900) * 0.05;
      }

      gaze.x += (target.x - gaze.x) * LERP;
      gaze.y += (target.y - gaze.y) * LERP;

      let blinkScale = 1;
      if (blinkStartedAt >= 0) {
        const t = (now - blinkStartedAt) / BLINK_MS;
        if (t >= 1) {
          blinkStartedAt = -1;
          nextBlinkAt =
            now +
            (Math.random() < 0.18 ? 260 : 2800 + Math.random() * 3800);
        } else {
          blinkScale = t < 0.5 ? 1 - t * 2 * 0.92 : 0.08 + (t - 0.5) * 2 * 0.92;
        }
      } else if (now >= nextBlinkAt) {
        blinkStartedAt = now;
      }

      eyeEl.style.transform = `translate(${gaze.x}px, ${gaze.y}px) scaleY(${blinkScale})`;
      if (ringInnerRef.current) {
        ringInnerRef.current.style.transform = `translate(${gaze.x * 0.22}px, ${gaze.y * 0.22}px)`;
      }
      if (ringOuterRef.current) {
        ringOuterRef.current.style.transform = `translate(${gaze.x * 0.1}px, ${gaze.y * 0.1}px)`;
      }

      frameCount += 1;
      if (now - lastLogAt > 2000) {
        // #region agent log
        fetch(
          "http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Debug-Session-Id": "f8c9f7",
            },
            body: JSON.stringify({
              sessionId: "f8c9f7",
              location: "ReactorEye.tsx:frame",
              message: "eye RAF sample",
              data: {
                frameCount,
                mouseMoveCount,
                cachedScale,
                camMag: Number(camMag.toFixed(3)),
                useCam,
                gazeX: Number(gaze.x.toFixed(2)),
                gazeY: Number(gaze.y.toFixed(2)),
                ecoPaused: false,
              },
              timestamp: Date.now(),
              hypothesisId: "H-E4",
              runId: "pre",
            }),
          },
        ).catch(() => {});
        // #endregion
        lastLogAt = now;
      }

      raf = requestAnimationFrame(frame);
    };

    window.addEventListener("mousemove", onMouseMove);
    document.documentElement.addEventListener("mouseleave", onMouseLeave);
    window.addEventListener("blur", onMouseLeave);
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(raf);
      window.removeEventListener("mousemove", onMouseMove);
      document.documentElement.removeEventListener("mouseleave", onMouseLeave);
      window.removeEventListener("blur", onMouseLeave);
    };
  }, [camGaze]);

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
        <button
          type="button"
          className={`eye-cam-btn${camActive ? " on" : ""}`}
          title={
            camActive
              ? "Camera tracking ON — STARRA is watching"
              : "Arm camera — STARRA tracks your face like a real eye"
          }
          onClick={toggleCam}
        >
          {camActive ? "EYE ON" : "EYE CAM"}
        </button>
        {camError ? (
          <span className="eye-cam-err" title={camError}>
            CAM DENIED
          </span>
        ) : null}
      </div>
    </div>
  );
}
