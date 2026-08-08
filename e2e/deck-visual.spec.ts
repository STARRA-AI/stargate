import { test, expect } from "@playwright/test";

const SCREENS = ["/", "/brief", "/connectors", "/memory", "/pipeline", "/settings", "/tools", "/vault"];

for (const path of SCREENS) {
  test(`${path} renders without error and matches its baseline`, async ({ page }) => {
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
