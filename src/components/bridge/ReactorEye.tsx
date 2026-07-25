"use client";

import { useCameraGaze } from "@/lib/vision/useCameraGaze";
import {
  eyeCineForHud,
  pupilScaleForHud,
} from "@/lib/motion/assets";
import { useCineVideo } from "@/lib/motion/useCineVideo";
import type { HudState } from "@/lib/tokens";
import { memo, useEffect, useRef, useState } from "react";

/**
 * STARRA's living eye — 4-layer gimbal + cinematic weather.
 * Cursor + camera gaze remain; saccades / blinks / pupil leak state.
 * Hardware budget: transform + opacity only; webm carries heavy visuals.
 */

const MAX_X = 24; // idle saccade / cursor range (widened for the larger galaxy eye)
const MAX_Y = 18;
// Camera face-tracking gets its OWN, much larger range + gain so moving in front
// of the webcam clearly moves the eye. The old ±14px cap was ~4% of the 360px
// galaxy eye — imperceptible, which read as "not tracking at all".
const CAMERA_GAIN = 55;
const CAMERA_MAX_X = 54;
const CAMERA_MAX_Y = 40;
const LERP_SACCADE = 0.25;
const LERP_TRACK = 0.14;
const LERP_FOLLOW = 0.45; // snappy pursuit for live camera / cursor tracking
const BLINK_MS = 140;
const REACTION_MIN = 150;
const REACTION_MAX = 280;
const SLEEP_AFTER_MS = 5 * 60 * 1000;

type Vec = { x: number; y: number };

function clampGaze(v: Vec): Vec {
  return {
    x: Math.max(-MAX_X, Math.min(MAX_X, v.x)),
    y: Math.max(-MAX_Y, Math.min(MAX_Y, v.y)),
  };
}

function reactionDelay() {
  return REACTION_MIN + Math.random() * (REACTION_MAX - REACTION_MIN);
}

export const ReactorEye = memo(function ReactorEye({
  hudState,
  label,
  onMic,
}: {
  hudState: HudState;
  label: string;
  onMic?: () => void;
}) {
  const centerRef = useRef<HTMLDivElement>(null);
  const gimbalRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const pupilRef = useRef<HTMLDivElement>(null);
  const lidRef = useRef<HTMLDivElement>(null);
  const glintRef = useRef<HTMLDivElement>(null);
  const cineRef = useRef<HTMLVideoElement>(null);
  const hudRef = useRef(hudState);
  hudRef.current = hudState;
  // Tracked mirror of the reduced-motion media query for the 60fps rAF loop
  // below — that loop must not call matchMedia() itself every frame.
  const reducedMotionRef = useRef(false);
  // Same idea for ECO (low-power) state: mirrored by the MutationObserver
  // below so the 60fps rAF loop reads a ref instead of calling
  // document.body.classList.contains() every frame.
  const ecoRef = useRef(false);

  const signalRef = useRef<{
    doubleBlink: boolean;
    alertBlink: boolean;
    forceGaze: Vec | null;
  }>({ doubleBlink: false, alertBlink: false, forceGaze: null });

  const { active: camActive, error: camError, gazeRef: camGaze, toggle: toggleCam } =
    useCameraGaze();
  // Continuously-updated cursor position (window coords), written on every
  // mousemove. The eye follows the cursor whenever it's on the page (camera on
  // or off); an actively-detected face takes priority over it.
  const cursorRef = useRef<{ x: number; y: number } | null>(null);

  const [eco, setEco] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [sleeping, setSleeping] = useState(false);
  const [alertFlare, setAlertFlare] = useState(false);

  const cine = eyeCineForHud(hudState);
  const allowPlay = !eco && !reduced && !sleeping;
  const cineActive = Boolean(cine.src) && cine.opacity > 0 && allowPlay;

  useCineVideo(cineRef, {
    src: cine.src,
    active: cineActive,
    loop: cine.loop,
    allowPlay,
  });

  useEffect(() => {
    const syncEco = () => {
      const isEco = document.body.classList.contains("low-power");
      setEco(isEco);
      ecoRef.current = isEco;
    };
    syncEco();
    const mo = new MutationObserver(syncEco);
    mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMq = () => {
      setReduced(mq.matches);
      reducedMotionRef.current = mq.matches;
    };
    onMq();
    mq.addEventListener("change", onMq);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", onMq);
    };
  }, []);

  useEffect(() => {
    if (hudState !== "error") {
      setAlertFlare(false);
      return;
    }
    setAlertFlare(false);
    signalRef.current.alertBlink = true;
    const t = window.setTimeout(() => setAlertFlare(true), 320);
    return () => clearTimeout(t);
  }, [hudState]);

  useEffect(() => {
    if (
      hudState === "thinking" ||
      hudState === "transcribing" ||
      hudState === "tool"
    ) {
      signalRef.current.doubleBlink = true;
      signalRef.current.forceGaze = { x: -8, y: -6 };
    } else if (hudState === "listening" || hudState === "wake") {
      signalRef.current.forceGaze = { x: 0, y: MAX_Y * 0.8 };
    } else if (hudState === "speaking" || hudState === "streaming") {
      signalRef.current.forceGaze = { x: 0, y: 0 };
    } else {
      signalRef.current.forceGaze = null;
    }
  }, [hudState]);

  useEffect(() => {
    const el = cineRef.current;
    if (!el || cine.kind !== "alert") return;
    const onEnded = () => {
      el.style.opacity = "0";
    };
    el.addEventListener("ended", onEnded);
    return () => el.removeEventListener("ended", onEnded);
  }, [cine.kind]);

  useEffect(() => {
    const root = centerRef.current;
    if (!root) return;
    let scale = pupilScaleForHud(hudState);
    if (hudState === "error" && alertFlare) scale = 1.15;
    if (sleeping) scale = 0.92;
    root.style.setProperty("--pupil-scale", String(scale));
  }, [hudState, alertFlare, sleeping]);

  useEffect(() => {
    const gimbal = gimbalRef.current;
    const outer = outerRef.current;
    const inner = innerRef.current;
    const pupil = pupilRef.current;
    const lid = lidRef.current;
    const glint = glintRef.current;
    const centerEl = centerRef.current;
    if (!gimbal || !outer || !inner || !pupil || !lid || !centerEl) return;

    const current: Vec = { x: 0, y: 0 };
    const target: Vec = { x: 0, y: 0 };
    let lastInteractAt = performance.now();
    let nextSaccadeAt = performance.now() + 2500;
    let nextBlinkAt = performance.now() + 3200;
    let blinkPhase: "open" | "closing" | "gap" = "open";
    let blinkT0 = 0;
    let blinksLeft = 0;
    let inSaccade = false;
    let pendingTarget: Vec | null = null;
    let pendingAt = 0;
    let sleepLocal = false;
    let frameSkip = 0;
    let raf = 0;

    const scheduleTarget = (x: number, y: number) => {
      pendingTarget = clampGaze({ x, y });
      pendingAt = performance.now() + reactionDelay();
      inSaccade = true;
    };

    const queueBlink = (count: number, now: number) => {
      if (inSaccade) {
        nextBlinkAt = now + 100;
        return;
      }
      if (blinkPhase !== "open") return;
      blinkPhase = "closing";
      blinkT0 = now;
      blinksLeft = Math.max(0, count - 1);
    };

    const onMouseMove = (ev: MouseEvent) => {
      lastInteractAt = performance.now();
      cursorRef.current = { x: ev.clientX, y: ev.clientY };
      if (sleepLocal) {
        sleepLocal = false;
        setSleeping(false);
      }
    };

    const onMouseLeave = () => {
      cursorRef.current = null;
    };

    const onFocusIn = (ev: FocusEvent) => {
      const t = ev.target as HTMLElement | null;
      if (!t?.closest?.("textarea, input, .console, [data-console]")) return;
      lastInteractAt = performance.now();
      if (sleepLocal) {
        sleepLocal = false;
        setSleeping(false);
      }
      scheduleTarget(0, MAX_Y * 0.8);
    };

    const onPointer = () => {
      lastInteractAt = performance.now();
      if (sleepLocal) {
        sleepLocal = false;
        setSleeping(false);
      }
    };

    const frame = (now: number) => {
      const ecoPaused = ecoRef.current;
      const reduce = reducedMotionRef.current;

      if (ecoPaused || reduce) {
        gimbal.style.transform = "translate(0px, 0px) scaleY(1)";
        outer.style.transform = "translate(0px, 0px)";
        inner.style.transform = "translate(0px, 0px)";
        pupil.style.transform = "translate(0px, 0px) scale(var(--pupil-scale))";
        lid.style.opacity = "0";
        if (glint) glint.style.opacity = "0.85";
        raf = window.setTimeout(
          () => {
            raf = requestAnimationFrame(frame);
          },
          250,
        ) as unknown as number;
        return;
      }

      if (!sleepLocal && now - lastInteractAt > SLEEP_AFTER_MS) {
        sleepLocal = true;
        setSleeping(true);
      }
      if (sleepLocal) {
        frameSkip += 1;
        if (frameSkip % 4 !== 0) {
          raf = requestAnimationFrame(frame);
          return;
        }
      }

      const sig = signalRef.current;
      if (sig.doubleBlink) {
        sig.doubleBlink = false;
        queueBlink(2, now);
      }
      if (sig.alertBlink) {
        sig.alertBlink = false;
        queueBlink(2, now);
      }

      if (pendingTarget && now >= pendingAt) {
        target.x = pendingTarget.x;
        target.y = pendingTarget.y;
        pendingTarget = null;
      }

      const hud = hudRef.current;
      const cam = camGaze.current;
      const camMag = Math.hypot(cam.x, cam.y);
      const useCam = camMag > 0.12; // a clearly off-center face; else the cursor takes over

      let desired: Vec;
      if (sig.forceGaze) {
        desired = clampGaze(sig.forceGaze);
      } else if (useCam) {
        // Clamp to the LARGER camera range (not the modest saccade range) so the
        // eye visibly follows your face across a wide arc.
        desired = {
          x: Math.max(-CAMERA_MAX_X, Math.min(CAMERA_MAX_X, cam.x * CAMERA_GAIN)),
          y: Math.max(-CAMERA_MAX_Y, Math.min(CAMERA_MAX_Y, cam.y * CAMERA_GAIN)),
        };
        lastInteractAt = now;
        if (sleepLocal) {
          sleepLocal = false;
          setSleeping(false);
        }
      } else if (cursorRef.current) {
        // Continuous cursor-follow whenever the mouse is on the page (camera on
        // OR off). Mapped to the wide camera range (×1.4 so mid-screen moves
        // already swing the eye clearly).
        const rect = centerEl.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = cursorRef.current.x - cx;
        const dy = cursorRef.current.y - cy;
        const halfW = window.innerWidth / 2 || 1;
        const halfH = window.innerHeight / 2 || 1;
        desired = {
          x: Math.max(-CAMERA_MAX_X, Math.min(CAMERA_MAX_X, (dx / halfW) * CAMERA_MAX_X * 1.4)),
          y: Math.max(-CAMERA_MAX_Y, Math.min(CAMERA_MAX_Y, (dy / halfH) * CAMERA_MAX_Y * 1.4)),
        };
        lastInteractAt = now;
        if (sleepLocal) {
          sleepLocal = false;
          setSleeping(false);
        }
      } else {
        if (now >= nextSaccadeAt && !pendingTarget) {
          const wide = sleepLocal || now - lastInteractAt > 90_000;
          const mag = Math.random() < 0.7 && !wide ? 0.35 : 1.0;
          scheduleTarget(
            (Math.random() * 2 - 1) * MAX_X * mag,
            (Math.random() * 2 - 1) * MAX_Y * mag * 0.8,
          );
          nextSaccadeAt = now + 800 + Math.random() * 3200;
        }
        desired = { x: target.x, y: target.y };
      }

      if (!pendingTarget) {
        target.x = desired.x;
        target.y = desired.y;
      }

      const dist = Math.hypot(target.x - current.x, target.y - current.y);
      // Snappy pursuit while actively tracking a face or the cursor; gentler
      // lerp for idle saccades.
      const tracking = useCam || (!sig.forceGaze && Boolean(cursorRef.current));
      const lerp = tracking ? LERP_FOLLOW : dist > 6 ? LERP_SACCADE : LERP_TRACK;
      current.x += (target.x - current.x) * lerp;
      current.y += (target.y - current.y) * lerp;
      if (dist < 0.45) inSaccade = false;

      const t = now / 1000;
      const gx = current.x + Math.sin(t * 1.7) * 0.6 + Math.sin(t * 3.1) * 0.3;
      const gy = current.y + Math.cos(t * 1.3) * 0.5;

      /* Blink state machine */
      let blinkScale = 1;
      let lidOp = sleepLocal ? 0.35 : 0;

      if (blinkPhase === "closing") {
        const bt = (now - blinkT0) / BLINK_MS;
        if (bt >= 1) {
          if (blinksLeft > 0) {
            blinkPhase = "gap";
            blinkT0 = now;
          } else {
            blinkPhase = "open";
            nextBlinkAt =
              now +
              (sleepLocal
                ? 6000 + Math.random() * 4000
                : 3000 + Math.random() * 4000);
          }
        } else {
          const ease = bt < 0.5 ? bt * 2 : (1 - bt) * 2;
          blinkScale = 1 - ease * 0.88;
          lidOp = Math.max(lidOp, ease * 0.92);
        }
      } else if (blinkPhase === "gap") {
        if (now - blinkT0 >= 180) {
          blinksLeft -= 1;
          blinkPhase = "closing";
          blinkT0 = now;
        }
      } else if (
        now >= nextBlinkAt &&
        hud !== "speaking" &&
        hud !== "streaming"
      ) {
        queueBlink(Math.random() < 0.12 ? 2 : 1, now);
      }

      if (glint) {
        glint.style.opacity =
          blinkPhase === "closing"
            ? String(0.85 * blinkScale)
            : sleepLocal
              ? "0.4"
              : "0.85";
      }

      gimbal.style.transform = `translate(${gx}px, ${gy}px) scaleY(${blinkScale})`;
      pupil.style.transform = `translate(${gx * 0.35}px, ${gy * 0.35}px) scale(var(--pupil-scale))`;
      outer.style.transform = `translate(${gx * -0.3}px, ${gy * -0.3}px)`;
      inner.style.transform = `translate(${gx * 0.15}px, ${gy * 0.15}px)`;
      lid.style.opacity = String(lidOp);

      raf = requestAnimationFrame(frame);
    };

    window.addEventListener("mousemove", onMouseMove, { passive: true });
    document.documentElement.addEventListener("mouseleave", onMouseLeave);
    window.addEventListener("blur", onMouseLeave);
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("pointerdown", onPointer, { passive: true });
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(raf);
      window.removeEventListener("mousemove", onMouseMove);
      document.documentElement.removeEventListener("mouseleave", onMouseLeave);
      window.removeEventListener("blur", onMouseLeave);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [camGaze]);

  const speaking =
    hudState === "speaking" ||
    hudState === "streaming" ||
    hudState === "thinking";

  const thinkSpin =
    hudState === "thinking" ||
    hudState === "transcribing" ||
    hudState === "tool";

  const cineOpacity = allowPlay && cineActive ? cine.opacity : 0;

  return (
    <div className="reactor-stage">
      <div
        className={`reactor${sleeping ? " sleep" : ""}${thinkSpin ? " think" : ""}`}
        ref={centerRef}
      >
        <div className="eye-socket">
          {/* Outer galaxy data ring — spins independently; sits OUTSIDE the
              gimbal so it never gaze-tracks or blink-squashes with the eye. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="star-ring" src="/brand/star-ring.png" alt="" aria-hidden />

          <div className="eye-gimbal" ref={gimbalRef}>
            {/* outer/inner parallax layers kept empty — the rAF loop still drives
                their refs; the galaxy look no longer needs ring art in them. */}
            <div className="ring-parallax eye-outer" ref={outerRef} />
            <div className="ring-parallax eye-inner" ref={innerRef} />
            <div className="ring-parallax eye-pupil" ref={pupilRef}>
              {/* The cybernetic eye — tracks (gimbal translate) + blinks (scaleY)
                  + pupil dilation (scale) via the existing rAF loop. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="star-eye" src="/brand/star-eye.png" alt="" />
              <button
                type="button"
                className={`reactor-core${speaking ? " speaking" : ""}`}
                id="reactor-core"
                aria-label="Call STARRA"
                onClick={onMic}
              />
            </div>
          </div>
          <div className="eye-glint" ref={glintRef} aria-hidden />
          <div className="eye-lid" ref={lidRef} aria-hidden />
          <video
            ref={cineRef}
            className="eye-cine"
            muted
            playsInline
            preload="metadata"
            style={{ opacity: cineOpacity }}
            aria-hidden
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
        {camActive ? (
          <span className="eye-cam-safe">LOCAL · NOT RECORDED</span>
        ) : null}
        {camError ? (
          <span className="eye-cam-err" title={camError}>
            CAM DENIED
          </span>
        ) : null}
      </div>
    </div>
  );
});
