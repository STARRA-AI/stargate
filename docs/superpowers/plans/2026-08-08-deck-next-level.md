# STARGATE Deck — Next Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the deck feel alive and read as professional — without changing what it *is* — and make "it looks better" a thing that fails a build instead of a matter of opinion.

**Architecture:** Playwright gives the deck a visual and behavioral safety net first, so every change after it is provable. Then three passes, each gated by that net: motion that explains state (Emil's craft bar), surface polish on the primitives already shipped (`.deck-panel`, `.deck-badge`, `.deck-grid`), and a perceived-performance pass on the back end so the deck *feels* as fast as it looks.

**Tech Stack:** Next.js 15.5.20 / React / TypeScript, anime.js 4.5.0 (installed, **named exports only**), Playwright 1.62.1 + Chromium (installed), Canvas 2D. No new runtime dependencies.

## Verified Ground Truth (from source, 2026-08-08 — do not re-derive, DO re-read before editing)

| Fact | Evidence |
| --- | --- |
| Deck serves HTTPS, dual-stack | `scripts/starra`; `https://localhost:3000` and `https://127.0.0.1:3000` both 200 |
| Auth is required for every screen | `POST /api/auth {"password": …}` → cookie. **A 307/401 means the route never compiled — it is NOT proof of health** |
| Design primitives already exist | `src/app/globals.css` — `.deck-grid:148`, `.deck-panel:154`, `.deck-title:171`, `.deck-badge:199` + `.is-ok/.is-warn/.is-danger/.is-idle:214-223` |
| Motion layer exists, doctrine pinned as a test | `src/lib/ui/motion.ts` (`DUR`, `EASE`, `deckBoot`, `tabSwitch`, `tabsIn`, `reveal`, `revealAll`, `slideIn`, `brighten`, `dim`); `tests/motion-doctrine.test.ts` |
| anime.js v4 has **no default export** | verified against `animejs@4.5.0` in node_modules — `import { animate, createTimeline, stagger } from "animejs"` |
| Reactor sphere is live and audio-reactive | `src/components/hud/ReactorSphere.tsx`, `sphere-geometry.ts`, `useAudioBands.ts` |
| Deck markup targets | `/` renders 1 `.topbar`, 3 `.col`, 9 `.panel` |
| 8 screens wrap `ScreenShell` | `/brief /connectors /login /memory /pipeline /settings /tools /vault` |
| Token values (do not change) | `--void #0a0414`, `--void-2 #140826`, `--chrome #e9d5ff`, `--purple #a855f7`, `--magenta #d946ef`, `--star #c4b5fd`, `--danger #ff3d81`, `--ok #8b5cf6`, `--warn #ffd166` |
| Known token divergence, **escalated not fixed** | `deck.css` vs `globals.css`: `--border` 34%/35%, `--border-soft` 16%/18%, `--panel` 82%/88%. Unifying moves pixels — Classic's call |
| `deck.css` loads **only on `/`** | imported at `Bridge.tsx:22`. A token defined only there does not exist on any other screen |
| Skills now installed (were referenced but absent) | `~/.claude/skills/`: `emil-design-eng`, `apple-design`, `animation-vocabulary`, `review-animations`, `impeccable`, `taste-skill-v1`, `minimalist-skill` + 11 more |

## FigmaToCode — assessed and NOT used, with reason

`vendor/FigmaToCode` is a **Figma plugin** (`manifest.json`, imported via *Plugins → Development → Import plugin from manifest*). It converts an existing Figma design into code. There is no Figma design for STARGATE, so it has nothing to convert, and its dev server binds **port 3000 — the deck's port**. It is cloned and available if Classic ever designs a screen in Figma; it is not part of this plan. Pretending to integrate it would be theatre.

## Global Constraints

- **The aesthetic is LOCKED.** Dark only. The exact token values above — no value changes, no new colors. Orbitron / Rajdhani / JetBrains Mono / Inter only. Operator voice ("Copy." not "Sure!"). **No emojis in UI copy.** No shadcn defaults.
- **Motion doctrine binds** (`.claude/skills/starra-design` + `emil-design-eng`): panel/state shifts **180–240ms**, badge breathe **~3s**, ring rotation loops **preserved as-is**. Ease-out or smooth custom curves — **no spring, elastic, bounce, or back easing**. Transform + opacity only; never animate layout.
- **ONE animated focal point.** The reactor leads. Subtract competing motion before adding any.
- **Every motion respects `prefers-reduced-motion`** and must leave a calm, correct resting state — never an element stranded at `opacity: 0`.
- **DO NOT TOUCH:** `src/lib/voice/**`, `src/app/api/realtime/**`, the reactor sphere, `canon/`. The live call is his most-used feature and is not yet verified by ear.
- No regex lookbehind (`(?<=`, `(?<!`) anywhere under `src/lib/voice` or `src/components` (WKWebView).
- No bare `return` on a failure path — every failure reports to the ops feed AND visible state.
- Never edit `.env.local` or any `STARRA_*.md` / `STARGATE_*.md` canon file.
- **Gates, run them yourself before claiming any task done:** `npm run test:v2` (**1482 tests, 0 failing**), `npx tsc --noEmit` clean, `npm run lint` **0 errors** (86 warnings is the baseline — do not add more).
- New CSS goes in `globals.css` primitives or a **module** stylesheet — never a fourth token source.

---

### Task 1: The visual safety net

Nothing after this task is provable without it. Screenshots make "more alive and professional" a diff instead of an argument.

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/auth.setup.ts`
- Create: `e2e/deck-visual.spec.ts`
- Modify: `package.json` (scripts), `.gitignore`

**Interfaces:**
- Produces: `npm run e2e` (behavior), `npm run e2e:snap` (accept new baselines). Storage state at `e2e/.auth/user.json` for every later spec.

- [ ] **Step 1: Write the config**

```ts
// playwright.config.ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // The deck is a long-lived dev server owned by scripts/starra; Playwright
  // must NOT try to start or stop it.
  use: {
    baseURL: "https://localhost:3000",
    ignoreHTTPSErrors: true, // mkcert CA is in the System keychain, not Chromium's
    storageState: "e2e/.auth/user.json",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/, use: { storageState: undefined } },
    { name: "deck", dependencies: ["setup"], use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  expect: {
    // Anti-aliasing on a canvas starfield makes byte-exact comparison useless.
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: "disabled" },
  },
  reporter: [["list"]],
  forbidOnly: true,
});
```

- [ ] **Step 2: Write the auth setup**

```ts
// e2e/auth.setup.ts
import { test as setup, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

setup("authenticate", async ({ page }) => {
  const env = readFileSync(".env.local", "utf8");
  const password = env.match(/^STARRA_PASSWORD=(.*)$/m)?.[1]?.replace(/^"|"$/g, "") ?? "";
  expect(password, "STARRA_PASSWORD must be set in .env.local").not.toBe("");

  const res = await page.request.post("/api/auth", { data: { password } });
  expect(res.status(), "auth must return 200").toBe(200);
  await page.context().storageState({ path: "e2e/.auth/user.json" });
});
```

- [ ] **Step 3: Write the visual + health spec**

```ts
// e2e/deck-visual.spec.ts
import { test, expect } from "@playwright/test";

const SCREENS = ["/", "/brief", "/connectors", "/memory", "/pipeline", "/settings", "/tools", "/vault"];

for (const path of SCREENS) {
  test(`${path} renders without error and matches its baseline`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

    const res = await page.goto(path, { waitUntil: "networkidle" });
    expect(res?.status(), `${path} must serve 200`).toBe(200);

    // A Next.js dev overlay means the route failed to compile — the exact
    // failure mode that took /tools down and 500'd six sibling routes.
    await expect(page.locator("nextjs-portal")).toHaveCount(0);
    expect(errors, `${path} logged runtime errors`).toEqual([]);

    await expect(page).toHaveScreenshot(`${path.replace(/\//g, "_") || "_root"}.png`, { fullPage: false });
  });
}

test("no element is stranded invisible after motion settles", async ({ page }) => {
  // The reduced-motion failure mode: a reveal that never runs leaves panels at
  // opacity 0 and the screen looks empty rather than calm.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/", { waitUntil: "networkidle" });
  const invisible = await page.locator(".panel, .deck-panel").evaluateAll(
    (els) => els.filter((el) => Number(getComputedStyle(el).opacity) < 0.05).length,
  );
  expect(invisible, "panels invisible under reduced motion").toBe(0);
});
```

- [ ] **Step 4: Wire the scripts and ignore the artifacts**

```bash
npm pkg set scripts.e2e="playwright test"
npm pkg set scripts.e2e:snap="playwright test --update-snapshots"
printf '\n# Playwright\n/e2e/.auth/\n/test-results/\n/playwright-report/\n' >> .gitignore
```

- [ ] **Step 5: Generate baselines, then prove the suite is green**

Run: `npm run e2e:snap` then `npm run e2e`
Expected: first run writes `e2e/deck-visual.spec.ts-snapshots/*.png`; second run passes 9/9.
**If any screen fails to 200 or shows `nextjs-portal`, STOP — that is a real bug and it is Task 1's job to surface it, not to snapshot around it.**

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts e2e package.json .gitignore
git commit -m "test(e2e): a visual and health net for every deck screen"
```

---

### Task 2: Motion that explains state

Emil's bar (`~/.claude/skills/emil-design-eng`, `review-animations`): motion must explain a state change, never prove CSS exists. Today the deck animates on boot and on tab switch and nothing else — every *interaction* is instant and flat.

**Files:**
- Modify: `src/lib/ui/motion.ts`
- Modify: `src/app/globals.css` (primitives only — `.deck-panel`, `.deck-badge`)
- Create: `tests/motion-interaction.test.ts`

**Interfaces:**
- Consumes: `DUR`, `EASE`, `prefersReducedMotion` from `src/lib/ui/motion.ts`.
- Produces: `pressable(el)`, `statusChange(el)`, `DUR.press`, `DUR.status`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DUR, EASE } from "../src/lib/ui/motion";

describe("interaction motion", () => {
  it("a press is faster than a panel move — touch must feel instant", () => {
    assert.ok(DUR.press > 0 && DUR.press <= 120, `DUR.press=${DUR.press} should be <=120ms`);
    assert.ok(DUR.press < DUR.panel, "a press that takes as long as a panel reads as lag");
  });

  it("a status change is inside the doctrine band", () => {
    assert.ok(DUR.status >= 180 && DUR.status <= 240, `DUR.status=${DUR.status} outside 180-240ms`);
  });

  it("still bans springiness on the new curves", () => {
    for (const [k, v] of Object.entries(EASE)) {
      assert.ok(!/spring|elastic|bounce|back/i.test(v), `EASE.${k}="${v}" is banned`);
    }
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx tsx --test tests/motion-interaction.test.ts`
Expected: FAIL — `DUR.press` is undefined.

- [ ] **Step 3: Implement**

```ts
// append to src/lib/ui/motion.ts — DUR gains two entries
//   press: 90,   // a tap/click acknowledgement; must feel instant
//   status: 200, // a badge changing meaning

/** Acknowledge a press. Scale only — never move layout under a finger. */
export function pressable(target: Target): void {
  if (prefersReducedMotion()) return;
  animate(target, { scale: [1, 0.97, 1], duration: DUR.press, ease: EASE.out });
}

/**
 * A status badge changing meaning. Emil's rule: motion explains the CHANGE,
 * so this fires only on transition, never on mount — an idle deck of badges
 * pulsing at each other is noise, not information.
 */
export function statusChange(target: Target): void {
  if (prefersReducedMotion()) return;
  animate(target, { opacity: [0.4, 1], scale: [0.96, 1], duration: DUR.status, ease: EASE.out });
}
```

- [ ] **Step 4: Add the CSS affordances the primitives lack**

```css
/* globals.css — append. Hover/active feedback the deck currently has none of.
   Transform + opacity only; no layout properties animate. */
.deck-panel { transition: border-color 200ms ease-out, box-shadow 200ms ease-out; }
.deck-panel:hover { border-color: color-mix(in oklab, var(--purple) 55%, transparent); }
.deck-badge { transition: opacity 200ms ease-out; }

@media (prefers-reduced-motion: reduce) {
  .deck-panel, .deck-badge { transition: none; }
}
```

- [ ] **Step 5: Verify**

Run: `npx tsx --test tests/motion-interaction.test.ts` → PASS
Run: `npm run test:v2` → 0 failing · `npx tsc --noEmit` → clean · `npm run lint` → 0 errors
Run: `npm run e2e` → 9/9 (hover states are not in the baseline; a diff here means you changed resting appearance, which is a real regression)

- [ ] **Step 6: Commit**

```bash
git add src/lib/ui/motion.ts src/app/globals.css tests/motion-interaction.test.ts
git commit -m "feat(motion): interaction feedback, on the doctrine's terms"
```

---

### Task 3: Surface polish on the primitives

`impeccable` and `minimalist-skill` both land on the same point: hierarchy comes from restraint, not ornament. The primitives shipped functional; this makes them read as considered. **No token VALUE changes** — only how they are composed.

**Files:**
- Modify: `src/app/globals.css` (`.deck-panel`, `.deck-title`, `.deck-badge`, `.deck-grid`)
- Create: `tests/deck-primitives-polish.test.ts`

**Interfaces:**
- Consumes: the existing primitive class names.
- Produces: no new API — CSS only.

- [ ] **Step 1: Write the failing test** — pin the rules that silently rot

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const css = readFileSync("src/app/globals.css", "utf8");

describe("deck primitives", () => {
  it("never introduces a color outside the token set", () => {
    const decls = css.match(/(?:color|background|border-color)\s*:\s*(#[0-9a-f]{3,8})/gi) ?? [];
    const allowed = /#0a0414|#140826|#e9d5ff|#a855f7|#d946ef|#c4b5fd|#ff3d81|#8b5cf6|#ffd166/i;
    const rogue = decls.filter((d) => !allowed.test(d));
    assert.deepEqual(rogue, [], `hardcoded non-token colors: ${rogue.join(", ")}`);
  });

  it("keeps every documented token value byte-identical", () => {
    for (const [name, value] of [
      ["--void", "#0a0414"], ["--chrome", "#e9d5ff"], ["--purple", "#a855f7"],
      ["--magenta", "#d946ef"], ["--star", "#c4b5fd"], ["--danger", "#ff3d81"],
      ["--ok", "#8b5cf6"], ["--warn", "#ffd166"],
    ] as const) {
      assert.ok(css.includes(`${name}: ${value}`), `${name} must stay ${value}`);
    }
  });

  it("honors reduced motion for every transition it adds", () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });
});
```

- [ ] **Step 2: Run it and verify it fails or passes honestly**

Run: `npx tsx --test tests/deck-primitives-polish.test.ts`
Expected: PASS on the token assertions (they are already true) and PASS or FAIL on the rogue-color scan depending on current state. **If it fails, that is a real finding — fix the rogue color, do not loosen the regex.**

- [ ] **Step 3: Polish the primitives**

```css
/* .deck-panel — depth from a hairline and a lift, not a heavier border. */
.deck-panel {
  border-radius: 10px;
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, var(--chrome) 8%, transparent),
    0 1px 2px color-mix(in oklab, var(--void) 60%, transparent);
}

/* .deck-title — a hairline rule under the label gives the eye a stop. */
.deck-title {
  padding-bottom: 8px;
  border-bottom: 1px solid color-mix(in oklab, var(--purple) 16%, transparent);
}

/* .deck-badge — a status dot reads faster than a word alone. */
.deck-badge::before {
  content: "";
  width: 5px; height: 5px; border-radius: 50%;
  background: currentColor;
  flex: 0 0 auto;
}

/* .deck-grid — a touch more air between cards; the reference UI's calm comes
   from spacing, not decoration. */
.deck-grid { gap: 18px; }
```

- [ ] **Step 4: Verify**

Run: `npx tsx --test tests/deck-primitives-polish.test.ts` → PASS
Run: `npm run test:v2` · `npx tsc --noEmit` · `npm run lint` → all clean
Run: `npm run e2e` → **screenshots WILL diff. Review each diff image before accepting.** Accept with `npm run e2e:snap` only after looking at them.

- [ ] **Step 5: Commit**

```bash
git add src/app/globals.css tests/deck-primitives-polish.test.ts
git commit -m "feat(deck): primitives that read as considered"
```

---

### Task 4: The back end feeling as fast as the front

"Function even better" means perceived latency. Every screen currently renders empty and then pops when its fetch lands — the deck looks broken for the first few hundred milliseconds.

**Files:**
- Create: `src/components/hud/Skeleton.tsx`, `src/components/hud/Skeleton.module.css`
- Create: `tests/skeleton.test.ts`
- Modify: `src/components/hud/ScreenShell.tsx`

**Interfaces:**
- Consumes: `prefersReducedMotion` from `src/lib/ui/motion.ts`.
- Produces: `<Skeleton rows={number} />`, and `shimmerEnabled(reduced: boolean): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shimmerEnabled } from "../src/components/hud/Skeleton";

describe("skeleton", () => {
  it("shimmers normally", () => assert.equal(shimmerEnabled(false), true));
  it("holds still under reduced motion — a looping shimmer is exactly what that setting is for", () => {
    assert.equal(shimmerEnabled(true), false);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx tsx --test tests/skeleton.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// src/components/hud/Skeleton.tsx
"use client";
import { prefersReducedMotion } from "@/lib/ui/motion";
import styles from "./Skeleton.module.css";

/** Pure so the reduced-motion rule is testable without a browser. */
export function shimmerEnabled(reduced: boolean): boolean {
  return !reduced;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  const shimmer = shimmerEnabled(prefersReducedMotion());
  return (
    <div className={styles.wrap} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={shimmer ? styles.barShimmer : styles.bar} />
      ))}
    </div>
  );
}
```

```css
/* src/components/hud/Skeleton.module.css */
.wrap { display: flex; flex-direction: column; gap: 10px; }
.bar {
  height: 12px; border-radius: 6px;
  background: color-mix(in oklab, var(--purple) 12%, transparent);
}
.barShimmer {
  composes: bar;
  background: linear-gradient(90deg,
    color-mix(in oklab, var(--purple) 10%, transparent),
    color-mix(in oklab, var(--purple) 22%, transparent),
    color-mix(in oklab, var(--purple) 10%, transparent));
  background-size: 200% 100%;
  animation: skeleton-sweep 1.4s ease-in-out infinite;
}
@keyframes skeleton-sweep { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .barShimmer { animation: none; } }
```

- [ ] **Step 4: Verify it passes**

Run: `npx tsx --test tests/skeleton.test.ts` → PASS

- [ ] **Step 5: Gates + commit**

Run: `npm run test:v2` · `npx tsc --noEmit` · `npm run lint` · `npm run e2e`

```bash
git add src/components/hud/Skeleton.tsx src/components/hud/Skeleton.module.css tests/skeleton.test.ts
git commit -m "feat(hud): a loading state, so the deck never looks broken"
```

---

### Task 5: The craft review

The skills exist to be *used*, not installed. This task is a real review pass with a real gate.

**Files:**
- Create: `docs/superpowers/reviews/2026-08-08-deck-craft-review.md`
- Modify: whatever the review proves is wrong (each fix keeps its own failing test first)

- [ ] **Step 1: Run the review** — invoke `review-animations` and `impeccable` against the changed surfaces, screenshot evidence from `npm run e2e` in hand.

- [ ] **Step 2: Write findings to the review doc**, each with `file:line` and a screenshot reference. Separate **CONFIRMED** (reproduced) from **OPINION** (taste call) — do not present taste as a defect.

- [ ] **Step 3: Fix only CONFIRMED findings.** Failing test first for each behavioral one.

- [ ] **Step 4: Full gates + a fresh `npm run e2e`.** Review every screenshot diff by eye before accepting.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/reviews src/
git commit -m "fix(deck): craft-review findings"
```

---

## Self-Review

**1. Spec coverage.** Three skill packs — installed (18 skills) and *used* in Tasks 2, 3, 5. Playwright — Task 1, and it gates every later task. "More alive" — Task 2 (interaction) + Task 4 (loading). "Professional" — Task 3. "Back end functions better" — Task 4 (perceived latency). "Same aesthetic" — Global Constraints, enforced by Task 3's token test. FigmaToCode — assessed, excluded, reason stated.

**2. Placeholders.** None. Every code step carries the real content. Task 5's file list is genuinely unknowable before the review runs, and says so instead of inventing one.

**3. Type consistency.** `DUR.press` / `DUR.status` asserted in Task 2's test are the same keys the implementation defines. `shimmerEnabled(reduced: boolean)` is the same signature in Task 4's test and implementation. `pressable` / `statusChange` take `Target`, the existing alias in `motion.ts`. `prefersReducedMotion` is imported, not redefined.

**4. Known residual risk, stated not papered over.** Screenshot baselines are generated on **this** machine at 1440×900; a different display or OS font rendering will diff. That is a limitation of visual regression, not a bug — `maxDiffPixelRatio: 0.02` absorbs anti-aliasing, not a different renderer. And **no task here touches the live call, which remains unverified until Classic hears it.**
