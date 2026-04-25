import { test, expect } from "./fixtures/chart.js";

test.describe("theme toggle", () => {
  test("clicking #toggle-theme flips body[data-theme] and round-trips", async ({ page, chart }) => {
    await page.goto("/");
    await chart.waitForReady();

    await expect(page.locator("body")).toHaveAttribute("data-theme", "dark");
    const button = page.locator("#toggle-theme");
    await expect(button).toHaveText(/Dark/);
    await expect(button).toHaveAttribute("aria-pressed", "false");

    // Dark → Light.
    await button.click();
    await expect(page.locator("body")).toHaveAttribute("data-theme", "light");
    await expect(button).toHaveText(/Light/);
    await expect(button).toHaveAttribute("aria-pressed", "true");

    // Chart still alive after theme swap (no canvas re-mount).
    expect(await chart.getInterval()).toBeGreaterThan(0);
    await expect(page.locator("canvas")).toBeVisible();

    // Light → Dark round-trip.
    await button.click();
    await expect(page.locator("body")).toHaveAttribute("data-theme", "dark");
    await expect(button).toHaveAttribute("aria-pressed", "false");
  });
});
