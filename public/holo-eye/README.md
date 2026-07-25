# STARGATE — Holographic Eye

Self-contained holographic eye: an independently-spinning galaxy data ring around
a cybernetic eye that tracks your face (webcam) or cursor, blinks for real, and
floats gently. Pure HTML + CSS + JS, one file (`index.html`). Free stack
(MediaPipe Face Landmarker).

## 1. Drop in your two PNGs

Put both transparent PNGs **in this same folder**, named exactly:

```
public/holo-eye/
├── index.html
├── eye.png     ← the cybernetic eye (the main tracking element)
└── ring.png    ← the large empty purple galaxy data ring
```

Until the PNGs are present, the page shows a glowing placeholder ring + pupil so
you can see the motion immediately — they vanish the moment the real PNGs load.

## 2. Serve it over http:// (required)

The webcam and MediaPipe (an ES-module import) **do not work from `file://`** —
they need an http origin.

**Option A — it's already served by your deck.** With STARGATE running
(`starra up`), open:

```
http://127.0.0.1:3000/holo-eye/index.html
```

**Option B — any static server** (no deck needed):

```
cd public/holo-eye
python3 -m http.server 8080
# then open http://localhost:8080/
```

## 3. Turn the camera on / off

- **Buttons:** `ENABLE CAMERA` / `DISABLE CAMERA` (bottom center).
- **From code / console:** `enableCamera()` and `disableCamera()` are exposed on
  `window`.
- **Camera off →** the eye smoothly falls back to following your mouse.
- **Camera on →** the eye follows your face (MediaPipe Face Landmarker) and blinks
  when you blink; the mouse still nudges it as a secondary input.

## What each behavior lives on (so nothing fights over `transform`)

| Behavior | Element | Driven by |
|---|---|---|
| Continuous ring spin (22s) | `.holo-ring` | CSS `@keyframes holo-spin` (independent, GPU) |
| Subtle ring breathe | `.holo-ring img` | CSS `@keyframes holo-breathe` (scale — different channel) |
| Face / cursor gaze | `.holo-eye-track` | JS lerp in the rAF loop |
| Blink (webcam + idle) | `.holo-eye` | JS `scaleY` state machine |
| Gentle float of the whole assembly | `.holo-assembly` | JS sine motion in the rAF loop |

## Tuning (top of the `<script>`)

- `--spin-seconds` (CSS var) — ring rotation period (18–25s).
- `GAZE_RANGE_X` / `GAZE_RANGE_Y` — how far the eye can travel.
- `GAZE_DAMP` — smoothing; lower = heavier/slower, higher = snappier.
- `BLINK_ON` / `BLINK_OFF` — blink sensitivity from the blendshape score.
- `IDLE_BLINK_MIN/MAX` — random idle-blink cadence when the camera is off.
- `MIRROR` — selfie mirroring (move right → eye looks right).
- `MP_VERSION` — MediaPipe version; bump only if the CDN import 404s.

## Privacy

The webcam feed is used **only** for on-device tracking. Nothing is recorded
(no `MediaRecorder`) and no frame is ever uploaded. The camera is torn down when
you disable it, hide the tab, or close the page. (The model itself is fetched
once from Google's public MediaPipe CDN, per the URL you specified — swap it for
a self-hosted copy if you want fully offline.)

## Layering over your existing UI

`.holo-stage` is `position: fixed`, transparent, and `pointer-events: none`
(click-through) — only the control bar captures clicks. Adjust its `z-index`
(currently 40) to sit above/below your layout, and set `--eye-size` / `--ring-size`
to scale the assembly.
