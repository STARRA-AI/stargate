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
