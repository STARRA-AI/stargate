# Living Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deck's decorative spinning center with a purple sphere that visibly moves
when STARRA speaks, and give the whole deck one coherent, fluid motion layer built on anime.js v4.

**Architecture:** Her audio already flows through a unified `AnalyserNode` bus — no new audio
plumbing. A small hook reads three frequency bands off that bus; a canvas-2D sphere consumes them.
anime.js v4 drives *state-change* motion only (reveal, slide, brighten), while Book 1's long ring
loops stay in CSS untouched.

**Tech Stack:** Next.js 15 / React / TypeScript, anime.js 4.5.0 (installed, named exports),
Canvas 2D, Web Audio `AnalyserNode`. **No three.js.**

## Verified Ground Truth (from source, 2026-08-07 — do not re-derive)

| Fact | Evidence |
| --- | --- |
| anime.js v4.5.0 installed; **no default export** | `package.json:41`; runtime key dump shows `animate`, `createTimeline`, `createAnimatable`, `stagger`, `createSpring`, `utils`, `svg` |
| Her TTS publishes a live analyser | `speak.ts:55` `TtsAudioSnapshot = { playing, analyser: AnalyserNode \| null }`; tap created at `speak.ts:471` |
| The **realtime call** analyser is mirrored onto that same bus | `useVoiceCall.ts:451` `mirrorAnalyserToEngineBus`; tap created at `useVoiceCall.ts:2501` |
| Consumers already resolve bus/tts/call | `StarraClipFace.tsx:85-89` `pickAnalyser({ busAnalyser, ttsAnalyser, callAnalyser })` |
| Existing ring loops (Book 1 cadence) | `deck.css:321` spin-cw 75s, `:356` 18s, `:360` spin-ccw 45s, `:364` 90s |
| Reduced-motion already honored in 3 sheets | `globals.css:228`, `options.css:474`, `deck.css:386`, `deck.css:458` |
| Reference motion model | `vendor/jarvis-realtime-agentic/visual-3d.ts:205-236` — FFT bands 0/1/2 drive scale, rotation, displacement; `analyser.ts` uses `fftSize = 32` |

## Global Constraints

- **The design doctrine governs** (`.claude/skills/starra-design`): reactor verbs are breathe /
  pulse / rotate; panels slide / reveal; console reveals; chrome brightens / dims. Panel and state
  shifts **180–240ms**, badge breathe **~3s**, **ring rotation loops preserved as-is**.
- **Ease-out or smooth custom curves. No springs, no bounce.**
- **Subtract before adding.** Reduce competing motion before introducing new motion. One animated
  focal point: the reactor must dominate side-panel motion.
- **Every new motion respects `prefers-reduced-motion`** and has a calm resting state.
- Transform + opacity only. No layout-thrashing animation.
- Dark only; existing tokens only (`--void`, `--void-2`, `--chrome`, `--purple`, `--magenta`,
  `--star`, `--danger`, `--ok`, `--warn`). No new colors. No emojis. Operator voice.
- **New CSS goes in a NEW stylesheet**, never `deck.css` / `options.css` / `globals.css` — a
  starra-loop run owns those files concurrently. Avoiding the collision is a requirement, not a
  preference.
- **Do not change the audio graph.** The sphere is a read-only consumer of the existing bus.
  Adding a `connect()` or reordering nodes in the call path is out of scope.
- No regex lookbehind under `src/lib/voice` or `src/components` (WKWebView).
- Gates: `npm run test:v2` 0 failing, `npx tsc --noEmit` clean, `npm run lint` 0 errors
  (86 warnings is the baseline — do not add more).

---

### Task 1: Audio-level hook

**Files:**
- Create: `src/lib/voice/useAudioBands.ts`
- Test: `tests/audio-bands.test.ts`

**Interfaces:**
- Produces: `readBands(analyser, out): void` — pure, fills a 3-slot Float32Array with bands 0/1/2
  normalized to 0..1; `useAudioBands(): { bands: Float32Array; playing: boolean }` React hook.
- Consumes: the existing engine bus via `subscribeTtsAudio` / `getTtsAudio` (`speak.ts:168-173`).

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readBands } from "../src/lib/voice/useAudioBands";

describe("readBands", () => {
  it("normalizes byte bins to 0..1", () => {
    const fake = { frequencyBinCount: 16,
      getByteFrequencyData(a: Uint8Array) { a[0] = 255; a[1] = 128; a[2] = 0; } };
    const out = new Float32Array(3);
    readBands(fake as unknown as AnalyserNode, out);
    assert.equal(out[0], 1);
    assert.ok(Math.abs(out[1] - 128 / 255) < 1e-6);
    assert.equal(out[2], 0);
  });

  it("a null analyser decays toward silence instead of freezing", () => {
    const out = new Float32Array([1, 1, 1]);
    readBands(null, out);
    assert.ok(out[0] < 1, "must decay, not hold the last loud frame");
    assert.ok(out[0] >= 0);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx tsx --test tests/audio-bands.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Port `vendor/jarvis-realtime-agentic/analyser.ts` (28 lines, Apache-2.0, no deps): `fftSize = 32`,
`getByteFrequencyData`, read bins 0/1/2, divide by 255. On a null analyser, decay each band toward
0 by a fixed factor per frame so the sphere settles instead of freezing mid-pulse. The hook
subscribes to `subscribeTtsAudio`, seeds from `getTtsAudio()` to catch a reply already in flight
(the pattern `VoiceCallOverlay.tsx:317` already uses), and unsubscribes on unmount.

- [ ] **Step 4: Verify it passes**

Run: `npx tsx --test tests/audio-bands.test.ts` → PASS.

- [ ] **Step 5: Commit** — `feat(voice): read her speaking level off the existing analyser bus`

---

### Task 2: The reactor sphere

**Files:**
- Create: `src/components/hud/ReactorSphere.tsx`, `src/styles/reactor.css`
- Test: `tests/reactor-sphere.test.ts`

**Interfaces:**
- Consumes: `useAudioBands()` from Task 1.
- Produces: `<ReactorSphere size={number} />` — a canvas that fills its container.

- [ ] **Step 1: Write the failing test** for the pure geometry function

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sphereRadiusAt } from "../src/components/hud/ReactorSphere";

describe("sphereRadiusAt", () => {
  it("is a calm circle when she is silent", () => {
    const r0 = sphereRadiusAt(0, 0, new Float32Array([0, 0, 0]));
    const r1 = sphereRadiusAt(Math.PI, 0, new Float32Array([0, 0, 0]));
    assert.ok(Math.abs(r0 - r1) < 1e-9, "silence must not deform the sphere");
  });

  it("deforms when she speaks", () => {
    const quiet = sphereRadiusAt(1, 0, new Float32Array([0, 0, 0]));
    const loud = sphereRadiusAt(1, 0, new Float32Array([1, 1, 1]));
    assert.ok(loud !== quiet, "loud audio must move the surface");
  });

  it("stays bounded so it never blows past its container", () => {
    for (let t = 0; t < 6.3; t += 0.2) {
      const r = sphereRadiusAt(t, 5, new Float32Array([1, 1, 1]));
      assert.ok(r > 0.2 && r < 1.8, `radius out of bounds: ${r}`);
    }
  });
});
```

- [ ] **Step 2: Run it and verify it fails.** `npx tsx --test tests/reactor-sphere.test.ts`

- [ ] **Step 3: Implement.** Port the displacement model from `sphere-shader.ts:27-33` to 2D polar:
`r = 1 + amp * dir * (0.5 + 0.5 * sin(freq * theta + time))`, with `amp` from band 0 and `freq`
from band 2, exactly as `visual-3d.ts:233-236` maps them. Draw with a radial gradient from
`--magenta` core through `--purple` to transparent so it reads as the existing reactor, not a new
object. Clamp the radius. Under `prefers-reduced-motion`, render one static circle and never start
the rAF loop.

- [ ] **Step 4: Verify it passes.**

- [ ] **Step 5: Commit** — `feat(hud): a sphere that moves when she speaks`

---

### Task 3: Mount it in the deck center

**Files:**
- Modify: `src/components/bridge/Bridge.tsx` (the reactor center only)

- [ ] **Step 1** — Read the existing center block and identify the element the rings orbit.
- [ ] **Step 2** — Mount `<ReactorSphere />` as the core, **keeping every existing ring**
  (`deck.css:321/356/360/364`). Doctrine: preserve Book 1's long loops.
- [ ] **Step 3** — Verify by source that no ring rule was edited; `git diff --stat` touches only
  `Bridge.tsx`.
- [ ] **Step 4** — Gates: `npm run test:v2`, `tsc --noEmit`, `npm run lint`.
- [ ] **Step 5: Commit** — `feat(deck): the reactor core is now her voice`

---

### Task 4: The deck motion layer

**Files:**
- Create: `src/lib/ui/motion.ts`, `tests/motion-doctrine.test.ts`
- Modify: `src/components/bridge/Bridge.tsx`

**Interfaces:**
- Produces: `DUR` (the duration scale), `reveal(el)`, `slideIn(el)`, `brighten(el)`,
  `prefersReducedMotion(): boolean`.

- [ ] **Step 1: Write the failing test** — pin the doctrine numerically so drift is caught:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DUR } from "../src/lib/ui/motion";

describe("motion doctrine", () => {
  it("panel and state shifts are 180-240ms", () => {
    for (const k of ["panel", "state", "reveal"] as const) {
      assert.ok(DUR[k] >= 180 && DUR[k] <= 240, `${k}=${DUR[k]} outside doctrine`);
    }
  });
  it("the badge breathes at about 3 seconds", () => {
    assert.ok(Math.abs(DUR.badgeBreathe - 3000) <= 200);
  });
});
```

- [ ] **Step 2: Run it and verify it fails.**
- [ ] **Step 3: Implement** with anime.js v4 **named** imports (`import { animate, stagger } from
  "animejs"` — v4 has no default export). Ease-out only. Every helper returns immediately without
  animating when `prefersReducedMotion()` is true.
- [ ] **Step 4: Verify it passes.**
- [ ] **Step 5: Apply, subtracting first.** Before adding motion, remove or weaken competing
  decorative loops so the reactor leads. Then: panels reveal on mount, feed rows enter with
  `stagger`, active tab brightens. Nothing loops that does not need to.
- [ ] **Step 6: Gates + commit** — `feat(deck): one motion layer, doctrine-pinned`

---

### Task 5: open-jarvis feature ports

**Files:** determined by the reconnaissance result; each port gets its own failing test first.

- [ ] **Step 1** — Take the ranked candidate list from the open-jarvis recon (value × ease,
  free-only, nothing touching the call path).
- [ ] **Step 2** — For each accepted candidate: failing test → minimal implementation → verify →
  commit, one at a time.
- [ ] **Step 3** — Explicitly record every REJECTED candidate and why, so the decision is not
  re-litigated later.

---

## Self-Review

- **Spec coverage:** talking sphere (Tasks 1-3), anime.js across the deck (Task 4), repo feature
  comb (Task 5), design tooling (the doctrine skill governs every task).
- **Placeholders:** none — Task 5's file list is genuinely unknown until recon returns, and that is
  stated rather than faked.
- **Type consistency:** `readBands` / `useAudioBands` (Task 1) are consumed by Task 2 under those
  exact names; `DUR` keys asserted in Task 4's test match the keys the implementation must define.
- **Known risk, stated not papered over:** the sphere is only as alive as the bus. If the realtime
  call ever stops mirroring its analyser (`useVoiceCall.ts:451`), the sphere goes still during a
  call. Task 1's decay behavior makes that degrade calmly instead of freezing, but the real
  end-to-end proof needs Classic on a live call — **UNVERIFIED until then.**
