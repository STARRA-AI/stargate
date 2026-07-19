"use client";

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
      const fileset = await FilesetResolver.forVisionTasks(
        "/vendor/mediapipe/wasm",
      );
      const detector = await FaceDetector.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: "/vendor/mediapipe/blaze_face_short_range.tflite",
          delegate: "CPU",
        },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.4,
      });
      return {
        detect: async (source) => {
          const res = detector.detect(source as HTMLCanvasElement);
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

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current = null;
    }
    prevRef.current = null;
    gazeRef.current = { x: 0, y: 0 };
    setActive(false);
  }, []);

  const tickCountRef = useRef(0);
  const lastTickLogRef = useRef(0);
  const sizedRef = useRef(false);
  const lastTickAtRef = useRef(0);
  const lastDetectAtRef = useRef(0);
  const lastFaceRef = useRef<{ x: number; y: number; at: number } | null>(null);

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

    // Mirror so operator motion matches iris direction
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();

    let nx = 0;
    let ny = 0;
    let gotFace = false;

    if (detectorRef.current) {
      // Real detector present: throttle inference to ~150ms (~6-7fps) — the
      // hardware budget on a dual-core i5. The gaze lerp below still runs every
      // tick, so detection at 6-7fps + lerp = smooth pursuit, no jitter.
      if (now - lastDetectAtRef.current >= 150) {
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
          } else if (
            lastFaceRef.current &&
            now - lastFaceRef.current.at > 2000
          ) {
            lastFaceRef.current = null; // face lost > 2s → release to idle wander
          }
        } catch {
          /* keep last face briefly */
        }
      }
      if (lastFaceRef.current) {
        nx = lastFaceRef.current.x;
        ny = lastFaceRef.current.y;
        gotFace = true;
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
    g.x += (nx - g.x) * 0.18;
    g.y += (ny - g.y) * 0.18;

    tickCountRef.current += 1;
    if (now - lastTickLogRef.current > 2000) {
      // #region agent log
      fetch("http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": "f8c9f7",
        },
        body: JSON.stringify({
          sessionId: "f8c9f7",
          location: "useCameraGaze.ts:tick",
          message: "camera tick sample",
          data: {
            ticks: tickCountRef.current,
            gotFace,
            nx: Number(nx.toFixed(3)),
            ny: Number(ny.toFixed(3)),
            gazeX: Number(g.x.toFixed(3)),
            gazeY: Number(g.y.toFixed(3)),
            canvasW: canvas.width,
            canvasH: canvas.height,
            throttled: true,
          },
          timestamp: Date.now(),
          hypothesisId: "H-E3",
          runId: "pre",
        }),
      }).catch(() => {});
      // #endregion
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
      rafRef.current = requestAnimationFrame(() => void tick());
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Camera permission denied.";
      setError(msg);
      setActive(false);
    }
  }, [tick]);

  const toggle = useCallback(() => {
    if (active) stop();
    else void start();
  }, [active, start, stop]);

  useEffect(() => () => stop(), [stop]);

  return { active, error, gazeRef, start, stop, toggle };
}
