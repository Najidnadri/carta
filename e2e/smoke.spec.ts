import { test, expect } from "./fixtures/chart.js";

test.describe("smoke", () => {
  test("demo loads, canvas renders, harness is reachable", async ({ page, chart }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => { errors.push(err.message); });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(`[console.error] ${msg.text()}`);
      }
    });

    await page.goto("/");
    await chart.waitForReady();

    // Single canvas in the chart container, with non-zero size.
    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);

    // Readouts show real values, not the "—" placeholder.
    await expect(page.locator("#readout-start")).not.toHaveText("—");
    await expect(page.locator("#readout-end")).not.toHaveText("—");
    await expect(page.locator("#readout-width")).not.toHaveText("—");

    // Window state reflects the configured interval.
    const window = await chart.getWindow();
    expect(window.endTime).toBeGreaterThan(window.startTime);
    expect(window.intervalDuration).toBeGreaterThan(0);

    expect(errors).toEqual([]);
  });

  test("clearRequestLog after pan only drops pre-clear entries (adversarial 1.4)", async ({ page, chart }) => {
    await page.goto("/");
    await chart.waitForReady();

    // Pan to push entries into the log, then settle and clear.
    await page.evaluate(async () => {
      const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
      if (hook === undefined) {
        throw new Error("__cartaTest not attached");
      }
      await hook.synthDrag({ startX: 600, endX: 300, y: 200, steps: 6, durationMs: 100 });
    });
    await page.evaluate(
      () => new Promise<void>((r) => setTimeout(r, 200)),
    );

    await page.evaluate(() => {
      const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
      if (hook === undefined) {
        throw new Error("__cartaTest not attached");
      }
      hook.clearRequestLog();
    });

    // Immediately after clear, the log should be empty.
    const logImmediately = await chart.getRequestLog();
    expect(logImmediately).toHaveLength(0);

    // After RAF, any settled-but-late entries are post-clear and tagged accordingly.
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => { r(); }))),
    );
    const logSettled = await chart.getRequestLog();
    for (const entry of logSettled) {
      expect(entry.seq).toBeGreaterThan(0);
    }
  });
});
