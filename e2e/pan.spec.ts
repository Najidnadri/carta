import { test, expect, type CartaTestHook } from "./fixtures/chart.js";

test.describe("pan", () => {
  test("drag-pan shifts the visible window", async ({ page, chart }) => {
    await page.goto("/");
    await chart.waitForReady();

    const before = await chart.getWindow();
    const startReadout = (await page.locator("#readout-start").textContent()) ?? "";

    // Drag right→left by ~300px on the canvas; that pans the window forward in time.
    await page.evaluate(async () => {
      const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
      if (hook === undefined) {
        throw new Error("__cartaTest not attached");
      }
      await hook.synthDrag({ startX: 600, endX: 300, y: 200, steps: 12, durationMs: 200 });
    });

    // RAF settle.
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => { r(); }))),
    );

    const after = await chart.getWindow();
    const startReadoutAfter = (await page.locator("#readout-start").textContent()) ?? "";

    // Window shifted forward: startTime advanced by at least one interval.
    expect(after.startTime).toBeGreaterThan(before.startTime);
    expect(after.endTime).toBeGreaterThan(before.endTime);
    expect(after.startTime - before.startTime).toBeGreaterThanOrEqual(before.intervalDuration);
    // Width preserved (pan, not zoom).
    expect(after.endTime - after.startTime).toBe(before.endTime - before.startTime);
    // Sidebar readout reflects the shift.
    expect(startReadoutAfter).not.toBe(startReadout);
  });
});
