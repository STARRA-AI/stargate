import { test, expect, type Page } from "@playwright/test";
import { KEY_SLOTS } from "@/lib/keys";

const SCREENS = ["/", "/brief", "/connectors", "/memory", "/pipeline", "/settings", "/tools", "/vault"];

// Two screens read whatever the house happens to hold at the instant of the
// run: /memory renders live working memory (Book 1 §Tier 3 — "last ~10 raw
// exchanges"), and /brief fires a REAL brain call on every load. A pixel
// baseline over either one compares DATA, not design — it drifted 30102 /
// 29145 / 33018 px across three consecutive runs of an unchanged deck, and
// /brief bills a live model call every time the suite runs. Freeze those feeds
// so the baseline guards the thing it exists to guard: the panels, the grid,
// the type scale, the tokens. /tools is frozen for a different reason — see
// TOOLS_STUB below. /, /connectors, /pipeline and /vault still hit the real API.
const MEMORY_FIXTURE = {
  working: [
    { role: "user", content: "Status on the funding pipeline.", at: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", content: "Copy. Four banks open, none past prequal.", at: "2026-01-01T00:00:01.000Z" },
  ],
  summaries: ["Rolling summary: the operator is pre-revenue and gating every spend."],
  archival: [{ id: "fixed-1", text: "STARRA LLC is the entity. Classic Williams is the music.", at: "2026-01-01T00:00:02.000Z" }],
};

const BRIEF_SSE =
  `data: ${JSON.stringify({ text: "Top 3. One: DUNS. Two: Net-30s. Three: caption QA.\n\nBlockers. Zero tradelines.\n\nWhat changed. Nothing material." })}\n\n` +
  "data: [DONE]\n\n";

// /tools reads SEVEN vendor probes in one Promise.all (src/app/tools/page.tsx
// :171-177), and those probes are not pure reads — they spawn subprocesses and
// hit sockets under a deadline: `execFile("multica", ["version"], { timeout:
// 4000 })` (src/lib/tools/multica.ts:47-48) and `AbortSignal.timeout(8000)`
// (src/lib/tools/openalice.ts:223). When this Mac is busy the deadline lapses
// and the probe reports the vendor MISSING even though it is on disk — proven
// here: one run screenshotted NO PACK / NO VENDOR / NO CLONE while `ls vendor`
// showed multica, openalice and OpenMontage all present, and the next run
// passed untouched. A missing-vendor pill is a different HEIGHT, so every
// control below it shifts and the diff lands ~33k px on a 25920 px budget.
// The layout of this deck must not be a function of how loaded the machine is,
// so the probes are stubbed: the panels, grid, type scale and tokens are still
// under test, only the vendor verdict is pinned.
// One body serves all seven probes. Every field the panels read off these
// payloads is optional-chained with a fallback — verified line by line at
// src/app/tools/page.tsx:808-854 and :971-989 — so the shapes below are for
// legibility, not crash-avoidance: a bare `{}` renders the same pixels. What
// this body must be is TRUTHY, because that is what flips the tell below
// (`funding ? … : "○ Reading registry"`, :970-972).
const TOOLS_STUB = JSON.stringify({
  layers: { longTermMemory: "—", assistant: "—", backupSync: "—" },
  summary: { counts: { total: 0, acceptedNow: 0, futureHooks: 0, rejected: 0 } },
});

// /settings also renders a Tier-1 business-context panel (MRR label, task
// titles, project/goal counts — src/app/settings/page.tsx:391-431) off live
// /api/context (src/app/api/context/route.ts, src/lib/context/tier1.ts). It
// is below the fold at the pinned 1440x900 fullPage:false capture today, so
// it costs zero pixels now — but that is a viewport/layout accident, not a
// guarantee, and the same class of leak as unstubbed /api/keys: Classic's
// real MRR/tasks/decisions would land in a committed PNG the moment the
// viewport grows, a panel is added above it, or fullPage flips true. Fixed,
// fake, schema-shaped values only — matches Tier1Schema (tier1.ts:33-39) and
// the route's { tier1, snap } envelope (context/route.ts:11-21).
const CONTEXT_STUB = JSON.stringify({
  tier1: {
    mrrLabel: "$0 (stub)",
    goals: [{ id: "g1", horizon: "monthly", text: "Stub goal" }],
    projects: [{ id: "p1", name: "Stub project", status: "active" }],
    tasks: [{ id: "t1", title: "Stub task", owner: "Stub", priority: "med", done: false }],
    decisions: [{ id: "d1", text: "Stub decision", why: "Stub reason", at: "2026-01-01" }],
  },
  snap: { mrrLabel: "$0 (stub)", tasksDue: 1, pipelineOpen: 1, working: 0, summaries: 0, archival: 0 },
});

// The screens above paint a placeholder until a client-side fetch commits, and
// `networkidle` proves only that the response arrived — not that React
// committed it. The placeholder is a STABLE DOM, so Playwright settles and
// screenshots the empty state. /settings is the same failure with the biggest
// blast radius: at 1440x900 the viewport holds ONLY the LINK APIS panel, so an
// uncommitted `/api/keys` (src/app/settings/page.tsx:181, whose .catch falls
// back to `setSlots([])`) empties the entire captured area.
// Each tell is text that exists only once the real payload is rendered.
const READY_TELL: Record<string, string> = {
  "/memory": "Working (2)",
  "/brief": "Blockers. Zero tradelines.",
  // Rendered from the server's KEY_SLOTS list (src/lib/keys.ts:40 →
  // src/app/settings/page.tsx:267) — a slot definition, not a runtime value,
  // so it does not drift the way a "2/18 LINKED" count would.
  "/settings": "Anthropic (Claude)",
  // The stub makes `funding` truthy, which flips this badge from
  // "○ Reading registry" to the committed text (src/app/tools/page.tsx:970-972).
  // All seven probes land in ONE batched setState (:170-187), so this single
  // tell proves the whole vendor panel set committed, not just funding.
  "/tools": "● 0 usable now",
};

async function freezeLiveData(page: Page, path: string) {
  if (path === "/memory") {
    await page.route("**/api/memory*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MEMORY_FIXTURE) }),
    );
  }
  if (path === "/brief") {
    await page.route("**/api/chat", (route) =>
      route.fulfill({ status: 200, contentType: "text/event-stream", body: BRIEF_SSE }),
    );
  }
  if (path === "/tools") {
    await page.route("**/api/tools/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: TOOLS_STUB }),
    );
  }
  if (path === "/settings") {
    // settings/page.tsx:272 renders `● linked ${s.masked}` — the masked tail
    // of every REAL key — so an unstubbed snapshot against live /api/keys
    // would commit fragments of the operator's real credentials to git.
    // Every slot reports linked:false / masked:null here, derived from
    // KEY_SLOTS (not hand-typed) so no key-shaped string can ever reach a
    // committed baseline even after a slot is added or the vault changes.
    await page.route("**/api/keys*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          slots: KEY_SLOTS.map((s) => ({
            id: s.id,
            label: s.label,
            hint: s.hint,
            powers: s.powers,
            linked: false,
            masked: null,
            source: null,
            shadowedByEngine: false,
          })),
        }),
      }),
    );
    await page.route("**/api/context*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: CONTEXT_STUB }),
    );
  }
}

for (const path of SCREENS) {
  test(`${path} renders without error and matches its baseline`, async ({ page }) => {
    await freezeLiveData(page, path);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

    const res = await page.goto(path, { waitUntil: "networkidle" });
    expect(res?.status(), `${path} must serve 200`).toBe(200);

    // A Next.js dev error dialog means the route failed to compile — the exact
    // failure mode that took /tools down and 500'd six sibling routes.
    // Note: <nextjs-portal> itself is NOT a reliable signal on Next.js 15 — it's
    // the persistent Dev Tools indicator ("Open Next.js Dev Tools" button) and is
    // present on every page in dev mode whether or not there's an error. The
    // actual error UI renders inside its shadow root as [data-nextjs-dialog],
    // which Playwright's locator pierces (the shadow root is open).
    await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0);
    expect(errors, `${path} logged runtime errors`).toEqual([]);

    // `/` boots behind a full-screen overlay driven by setTimeout, not CSS
    // (DeckBoot.tsx:11-20 — an 1800ms budget), so `animations: "disabled"`
    // cannot pause it and `networkidle` outruns it. A bare count-0 assertion
    // races in BOTH directions, measured on this deck: `networkidle` resolved
    // at 1606ms with the overlay not yet mounted (lines=0), it mounted at
    // ~1747ms and did not clear until ~4s. So count-0 passes trivially before
    // boot starts — and the screenshot then lands mid-boot — or, if the check
    // begins after mount, 5s of default timeout is not always enough.
    // Wait for the overlay to appear, tolerating a boot that already finished,
    // then wait it out. Bridge.tsx:1200 is the only mount, so `/` only.
    if (path === "/") {
      await page
        .locator("#boot-overlay")
        .waitFor({ state: "attached", timeout: 5000 })
        .catch(() => {});
      await page.locator("#boot-overlay").waitFor({ state: "detached", timeout: 20000 });
    }

    // The frozen screens fetch client-side after mount — `networkidle` only
    // proves the request/response round-tripped, not that React committed the
    // resulting state. The placeholder is a STABLE DOM, so Playwright's
    // settle-then-compare happily screenshots "PROCESSING" and blows the diff.
    // Wait for text that exists only once the fixture itself is rendered.
    const tell = READY_TELL[path];
    if (tell) await expect(page.getByText(tell).first()).toBeVisible();

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
