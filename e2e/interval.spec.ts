import { test, expect, type CartaTestHook } from "./fixtures/chart.js";

test.describe("interval switch", () => {
  test("setInterval triggers a single data:request for the new bucket", async ({ page, chart }) => {
    await page.goto("/");
    await chart.waitForReady();

    // Wait for the initial 1m interval requests to settle, then clear the log.
    await page.evaluate(
      () => new Promise<void>((r) => setTimeout(r, 100)),
    );
    await page.evaluate(() => {
      const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
      if (hook === undefined) {
        throw new Error("__cartaTest not attached");
      }
      hook.clearRequestLog();
    });

    // Switch to 5m.
    await page.evaluate(() => {
      const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
      if (hook === undefined) {
        throw new Error("__cartaTest not attached");
      }
      hook.selectInterval(300_000);
    });

    // Allow the data-request flush + auto-supply round-trip to complete.
    await page.evaluate(
      () => new Promise<void>((r) => setTimeout(r, 200)),
    );

    expect(await chart.getInterval()).toBe(300_000);

    const log = await chart.getRequestLog();
    const dataRequestEntries = log.filter((e) => e.source === "data:request");
    // Demo's auto-supply may issue multiple ranges; assert at least one and
    // that *all* of them are for the new interval.
    expect(dataRequestEntries.length).toBeGreaterThanOrEqual(1);
    for (const entry of dataRequestEntries) {
      expect(entry.interval).toBe(300_000);
    }
  });

  test("selectInterval(current) is a no-op (adversarial 1.6)", async ({ page, chart }) => {
    await page.goto("/");
    await chart.waitForReady();
    await page.evaluate(
      () => new Promise<void>((r) => setTimeout(r, 100)),
    );

    const startingInterval = await chart.getInterval();

    await page.evaluate(() => {
      const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
      if (hook === undefined) {
        throw new Error("__cartaTest not attached");
      }
      hook.clearRequestLog();
      hook.selectInterval(60_000);
    });

    await page.evaluate(
      () => new Promise<void>((r) => setTimeout(r, 200)),
    );

    expect(await chart.getInterval()).toBe(startingInterval);
    const log = await chart.getRequestLog();
    const dataRequests = log.filter((e) => e.source === "data:request");
    expect(dataRequests).toHaveLength(0);
  });
});
