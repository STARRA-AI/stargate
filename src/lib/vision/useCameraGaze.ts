"use client";

/* ===========================================================================
 * useCameraGaze — SECURITY INVARIANTS (never-record, never-hacked)
 * ---------------------------------------------------------------------------
 * These guarantees are load-bearing. Do not weaken them.
 *
 *  1. CONSENT-GATED CAMERA. The camera is armed only on an explicit user
 *     toggle (start()/toggle()). It is never auto-started on mount/import.
 *  2. FRAMES STAY LOCAL. Video frames are drawn only into an in-memory
 *     offscreen <canvas> for on-device detection (MediaPipe BlazeFace) and an
 *     in-memory getImageData() motion fallback. Pixels never leave the tab.
 *  3. NOTHING IS RECORDED. There is no MediaRecorder, no captureStream sink,
 *     no persistence of frames or gaze data.
 *  4. NOTHING IS UPLOADED. No fetch / XHR / WebSocket / sendBeacon, and no
 *     canvas.toBlob() / toDataURL() serialization of frame data. Frame bytes
 *     have no path off the device.
 *  5. FULLY VENDORED MODEL. WASM + .tflite load from /vendor/mediapipe
 *     (local origin) — no runtime CDN, so the feature is offline-capable and
 *     has no third-party network dependency.
 *  6. BULLETPROOF TEARDOWN. Camera stops on explicit toggle, on component
 *     unmount, and on tab hide / pagehide / beforeunload. stop() is idempotent
 *     and releases every MediaStreamTrack.
 * ========================================================================= */

import { useCallback, useEffect, useRef, useState } from "react";

export type GazeVec = { x: number; y: number };

type FaceDetectorLike = {
  detect: (source: ImageBitmapSource) => Promise<
    Array<{
      boundingBox: { x: number; y: number; width: number; height: number };
    }>
  >;
};

declare global {
  interface Window {
    FaceDetector?: new (opts?: {
      fastMode?: boolean;
      maxDetectedFaces?: number;
    }) => FaceDetectorLike;
  }
}

/**
 * Lazily load a MediaPipe BlazeFace (short-range) detector from the locally
 * vendored WASM + model (public/vendor/mediapipe — provision with
 * `npm run face:download`). No CDN at runtime; STARGATE stays offline-capable.
 * Wrapped to the FaceDetectorLike interface (originX/originY → x/y). Cached; on
 * failure returns null so tick() degrades to the motion-centroid fallback.
 * NOTE: frames never leave the browser — detection is entirely local, nothing
 * is saved or uploaded.
 */
let mpDetectorPromise: Promise<FaceDetectorLike | null> | null = null;
async function loadMediaPipeDetector(): Promise<FaceDetectorLike | null> {
  if (mpDetectorPromise) return mpDetectorPromise;
  mpDetectorPromise = (async () => {
    try {
      const { FaceDetector, FilesetResolver } = await import(
        "@mediapipe/tasks-vision"
      );
      // The TFLite/XNNPACK runtime emits "INFO: Created TensorFlow Lite XNNPACK
      // delegate for CPU." through the Emscripten module's console during init,
      // which Next.js surfaces as a console error. Install a NARROW, TEMPORARY
      // filter that drops ONLY that line and delegates everything else to the
      // real console. It is uninstalled in the finally below — success OR throw
      // — so it never leaks past initialization.
      const orig = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
      };
      const isNoise = (first: unknown) =>
        /XNNPACK|Created TensorFlow Lite/.test(String(first));
      let detector;
      try {
        console.log = (...args: unknown[]) => {
          if (!isNoise(args[0])) orig.log(...args);
        };
        console.info = (...args: unknown[]) => {
          if (!isNoise(args[0])) orig.info(...args);
        };
        console.warn = (...args: unknown[]) => {
          if (!isNoise(args[0])) orig.warn(...args);
        };
        console.error = (...args: unknown[]) => {
          if (!isNoise(args[0])) orig.error(...args);
        };

        const fileset = await FilesetResolver.forVisionTasks(
          "/vendor/mediapipe/wasm",
        );
        detector = await FaceDetector.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: "/vendor/mediapipe/blaze_face_short_range.tflite",
            delegate: "CPU",
          },
          // VIDEO mode is the correct running mode for a live camera feed —
          // IMAGE mode re-initialises the graph on every frame (wasteful, and it
          // re-logs the XNNPACK delegate line that surfaces as a console error).
          runningMode: "VIDEO",
          minDetectionConfidence: 0.4,
        });
      } finally {
        // Restore the originals immediately after init, no matter what.
        console.log = orig.log;
        console.info = orig.info;
        console.warn = orig.warn;
        console.error = orig.error;
      }
      // detectForVideo needs a strictly-increasing timestamp; performance.now()
      // is monotonic and the tick is throttled to ~150ms, so it always advances.
      let lastTs = 0;
      return {
        detect: async (source) => {
          const ts = Math.max(performance.now(), lastTs + 1);
          lastTs = ts;
          const res = detector.detectForVideo(source as HTMLCanvasElement, ts);
          return (res.detections ?? [])
            .filter((d) => d.boundingBox)
            .map((d) => ({
              boundingBox: {
                x: d.boundingBox!.originX,
                y: d.boundingBox!.originY,
                width: d.boundingBox!.width,
                height: d.boundingBox!.height,
              },
            }));
        },
      };
    } catch (err) {
      console.warn(
        "[useCameraGaze] MediaPipe face detector unavailable — run `npm run face:download`. Falling back to motion tracking.",
        err,
      );
      mpDetectorPromise = null; // allow a retry next time the camera is armed
      return null;
    }
  })();
  return mpDetectorPromise;
}

/**
 * Camera gaze — STARRA watches the operator through the webcam.
 * Real face tracking via MediaPipe BlazeFace (vendored, offline); if that model
 * can't load, degrades to a frame-differencing motion centroid. Returns a
 * unit-ish gaze vector in screen space (x right, y down), mirrored so looking
 * left at the camera drives the iris left on the HUD.
 */
export function useCameraGaze() {
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gazeRef = useRef<GazeVec>({ x: 0, y: 0 });
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevRef = useRef<Uint8ClampedArray | null>(null);
  const rafRef = useRef(0);
  const detectorRef = useRef<FaceDetectorLike | null>(null);
  const tickCountRef = useRef(0);
  const lastTickLogRef = useRef(0);
  const sizedRef = useRef(false);
  const lastTickAtRef = useRef(0);
  const lastDetectAtRef = useRef(0);
  const lastFaceRef = useRef<{ x: number; y: number; at: number } | null>(null);

  // Bound lifecycle listeners — stored so removeEventListener targets the exact
  // same function objects registered in start(). These enforce teardown when
  // the tab is hidden or the page is navigated away, so the camera can never
  // stay live in a backgrounded/abandoned tab.
  const onVisibilityRef = useRef<(() => void) | null>(null);
  const onPageHideRef = useRef<(() => void) | null>(null);
  const onBeforeUnloadRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    // Idempotent + exhaustive: safe to call twice, releases every resource.
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;

    // Stop EVERY track on the stream (video only here, but be exhaustive).
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current = null;
    }
    canvasRef.current = null;
    prevRef.current = null;
    detectorRef.current = null;
    lastFaceRef.current = null;
    sizedRef.current = false;
    gazeRef.current = { x: 0, y: 0 };

    // Remove the lifecycle listeners we registered in start() — using the exact
    // same bound function objects so removal is guaranteed.
    if (typeof document !== "undefined" && onVisibilityRef.current) {
      document.removeEventListener("visibilitychange", onVisibilityRef.current);
    }
    if (typeof window !== "undefined") {
      if (onPageHideRef.current) {
        window.removeEventListener("pagehide", onPageHideRef.current);
      }
      if (onBeforeUnloadRef.current) {
        window.removeEventListener("beforeunload", onBeforeUnloadRef.current);
      }
    }
    onVisibilityRef.current = null;
    onPageHideRef.current = null;
    onBeforeUnloadRef.current = null;

    setActive(false);
  }, []);

  const tick = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(() => void tick());
      return;
    }

    // Throttle camera processing (~15fps) — full RAF + canvas resize was hot
    const now = performance.now();
    if (now - lastTickAtRef.current < 66) {
      rafRef.current = requestAnimationFrame(() => void tick());
      return;
    }
    lastTickAtRef.current = now;

    const w = 160;
    const h = Math.round((video.videoHeight / video.videoWidth) * w) || 120;
    if (!sizedRef.current || canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      sizedRef.current = true;
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      rafRef.current = requestAnimationFrame(() => void tick());
      return;
    }

    // ---- NO network / NO recording boundary ------------------------------
    // From here down, raw camera frame data is handled. It is ONLY drawn into
    // this in-memory offscreen canvas and read via getImageData()/detect() for
    // on-device analysis. It is NEVER serialized (no toBlob/toDataURL), NEVER
    // recorded (no MediaRecorder), and NEVER sent anywhere (no fetch/XHR/WS).
    // ----------------------------------------------------------------------
    // Mirror so operator motion matches iris direction
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();

    let nx = 0;
    let ny = 0;

    if (detectorRef.current) {
      // Real detector present: throttle inference to ~150ms (~6-7fps) — the
      // hardware budget on a dual-core i5. The gaze lerp below still runs every
      // tick, so detection at 6-7fps + lerp = smooth pursuit, no jitter.
      if (now - lastDetectAtRef.current >= 90) {
        lastDetectAtRef.current = now;
        try {
          const faces = await detectorRef.current.detect(canvas);
          if (faces[0]) {
            const b = faces[0].boundingBox;
            // Map face center from canvas mid to [-1, 1]
            lastFaceRef.current = {
              x: ((b.x + b.width / 2) / w - 0.5) * 2,
              y: ((b.y + b.height / 2) / h - 0.5) * 2,
              at: now,
            };
          }
        } catch {
          /* keep last face briefly */
        }
        // Runs regardless of whether detect() succeeded, threw, or found no
        // face — otherwise a persistently-throwing detector would never age
        // out a stale face and the gaze would stick forever.
        if (lastFaceRef.current && now - lastFaceRef.current.at > 2000) {
          lastFaceRef.current = null; // face lost > 2s → release to idle wander
        }
      }
      if (lastFaceRef.current) {
        nx = lastFaceRef.current.x;
        ny = lastFaceRef.current.y;
      }
      // Detector present but no face → nx/ny stay 0, gaze decays, eye idles.
    } else {
      // No real detector — legacy frame-differencing motion centroid fallback.
      const frame = ctx.getImageData(0, 0, w, h).data;
      const prev = prevRef.current;
      if (prev && prev.length === frame.length) {
        let sumX = 0;
        let sumY = 0;
        let mass = 0;
        for (let i = 0; i < frame.length; i += 16) {
          const diff =
            Math.abs(frame[i] - prev[i]) +
            Math.abs(frame[i + 1] - prev[i + 1]) +
            Math.abs(frame[i + 2] - prev[i + 2]);
          if (diff > 60) {
            const px = (i / 4) % w;
            const py = Math.floor(i / 4 / w);
            sumX += px * diff;
            sumY += py * diff;
            mass += diff;
          }
        }
        if (mass > 800) {
          nx = (sumX / mass / w - 0.5) * 2;
          ny = (sumY / mass / h - 0.5) * 2;
        }
      }
      prevRef.current = new Uint8ClampedArray(frame);
    }

    // Soft clamp + lerp into gaze ref
    nx = Math.max(-1, Math.min(1, nx));
    ny = Math.max(-1, Math.min(1, ny));
    const g = gazeRef.current;
    g.x += (nx - g.x) * 0.5;
    g.y += (ny - g.y) * 0.5;

    tickCountRef.current += 1;
    if (now - lastTickLogRef.current > 2000) {
      lastTickLogRef.current = now;
    }

    rafRef.current = requestAnimationFrame(() => void tick());
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Camera API unavailable in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      });
      streamRef.current = stream;
      // Real face detection via vendored MediaPipe BlazeFace; if it can't load,
      // fall back to Chromium's FaceDetector (rarely present) then motion tracking.
      detectorRef.current = await loadMediaPipeDetector();
      if (!detectorRef.current && window.FaceDetector) {
        detectorRef.current = new window.FaceDetector({
          fastMode: true,
          maxDetectedFaces: 1,
        });
      }
      const video = document.createElement("video");
      video.playsInline = true;
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      videoRef.current = video;
      canvasRef.current = document.createElement("canvas");
      setActive(true);

      // Register bulletproof teardown listeners AFTER the camera is live. Any
      // of these firing calls stop(), which releases the camera and removes
      // these very listeners — so the camera can never linger in a hidden or
      // abandoned tab. Bound refs are stored so removal targets these exact fns.
      const onVisibility = () => {
        if (document.hidden) stop();
      };
      const onPageHide = () => stop();
      const onBeforeUnload = () => stop();
      onVisibilityRef.current = onVisibility;
      onPageHideRef.current = onPageHide;
      onBeforeUnloadRef.current = onBeforeUnload;
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("beforeunload", onBeforeUnload);

      rafRef.current = requestAnimationFrame(() => void tick());
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Camera permission denied.";
      setError(msg);
      setActive(false);
    }
  }, [tick, stop]);

  const toggle = useCallback(() => {
    if (active) stop();
    else void start();
  }, [active, start, stop]);

  useEffect(() => () => stop(), [stop]);

  return { active, error, gazeRef, start, stop, toggle };
}
