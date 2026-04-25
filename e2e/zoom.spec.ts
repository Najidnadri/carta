import { test, expect, type CartaTestHook } from "./fixtures/chart.js";

test.describe("zoom", () => {
  test("wheel zoom narrows the visible window", async ({ page, chart }) => {
    await page.goto("/");
    await chart.waitForReady();

    const before = await chart.getWindow();
    const widthBefore = before.endTime - before.startTime;

    // Wheel up (negative deltaY) zooms in → window narrows.
    await page.evaluate(() => {
      const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
      if (hook === undefined) {
        throw new Error("__cartaTest not attached");
      }
      hook.synthWheel({ x: 400, y: 200, deltaY: -300 });
    });

    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => { r(); }))),
    );

    const after = await chart.getWindow();
    const widthAfter = after.endTime - after.startTime;

    expect(widthAfter).toBeLessThan(widthBefore);
    expect(widthAfter).toBeGreaterThan(0);
    expect(after.intervalDuration).toBe(before.intervalDuration);
  });

  test("synthWheel with deltaY=0 leaves window unchanged (adversarial 1.9)", async ({ page, chart }) => {
    await page.goto("/");
    await chart.waitForReady();

    const before = await chart.getWindow();

    await page.evaluate(() => {
      const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
      if (hook === undefined) {
        throw new Error("__cartaTest not attached");
      }
      hook.synthWheel({ x: 400, y: 200, deltaY: 0 });
    });

    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => { r(); }))),
    );

    const after = await chart.getWindow();
    expect(after.startTime).toBe(before.startTime);
    expect(after.endTime).toBe(before.endTime);
    expect(after.intervalDuration).toBe(before.intervalDuration);
  });
});
