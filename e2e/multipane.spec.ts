import { test, expect, type CartaTestHook } from "./fixtures/chart.js";

/**
 * Phase 14 Cycle A — multi-pane regression spec. The demo defaults to the
 * dedicated-volume-pane recipe; this spec validates that two panes render,
 * the volume placement toggle round-trips, and the crosshair payload
 * carries `paneId`.
 */
test.describe("phase 14 cycle A — multi-pane", () => {
  test("default cold load renders 2 panes (candle + volume)", async ({ page, chart }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => { errors.push(err.message); });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(`[console.error] ${msg.text()}`);
      }
    });
    await page.goto("/");
    await chart.waitForReady();

    const paneCount = await page.evaluate(() => {
      const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
      const c = hook?.getChart() as { panes: () => readonly unknown[] } | null;
      return c?.panes().length ?? 0;
    });
    expect(paneCount).toBe(2);

    // The dedicated volume pane has stretchFactor 0.25, so the candle pane
    // should be roughly 3× the volume pane's height.
    const heights = await page.evaluate(() => {
      const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
      const c = hook?.getChart() as { panes: () => readonly { getRect: () => { h: number } }[] } | null;
      return c?.panes().map((p) => p.getRect().h);
    });
    expect(heights).toBeDefined();
    expect(heights).toHaveLength(2);
    expect(heights![0]).toBeGreaterThan(heights![1]! * 2.5);
    expect(heights![1]).toBeGreaterThan(50);

    expect(errors).toEqual([]);
  });

  test("volume-placement toggle round-trips between recipes", async ({ page, chart }) => {
    await page.goto("/");
    await chart.waitForReady();

    // Switch to overlay → 1 pane only.
    await page.locator("#volume-placement").selectOption("overlay");
    await chart.waitForReady();
    const paneCountOverlay = await page.evaluate(() => {
      const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
      const c = hook?.getChart() as { panes: () => readonly unknown[] } | null;
      return c?.panes().length ?? 0;
    });
    expect(paneCountOverlay).toBe(1);

    // Back to pane → 2 panes again.
    await page.locator("#volume-placement").selectOption("pane");
    await chart.waitForReady();
    const paneCountPane = await page.evaluate(() => {
      const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
      const c = hook?.getChart() as { panes: () => readonly unknown[] } | null;
      return c?.panes().length ?? 0;
    });
    expect(paneCountPane).toBe(2);
  });

  test("crosshair:move payload carries paneId for both panes", async ({ page, chart }) => {
    await page.goto("/");
    await chart.waitForReady();

    // Wire a payload capture on the chart event bus.
    await page.evaluate(() => {
      const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
      const c = hook?.getChart() as
        | { on: (event: string, h: (p: unknown) => void) => void }
        | null;
      const sink: unknown[] = [];
      (globalThis as { __crosshairPayloads?: unknown[] }).__crosshairPayloads = sink;
      c?.on("crosshair:move", (p) => sink.push(p));
    });

    // Move the mouse over the candle pane (top), then over the volume pane (bottom).
    const canvas = page.locator("canvas").first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const candleY = box!.y + box!.height * 0.3;
    const volumeY = box!.y + box!.height * 0.85;
    const x = box!.x + box!.width * 0.5;

    await page.mouse.move(x, candleY);
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => { r(); }))));
    await page.mouse.move(x, volumeY);
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => { r(); }))));

    const payloads = await page.evaluate(() => {
      const sink = (globalThis as { __crosshairPayloads?: { paneId?: string | null }[] }).__crosshairPayloads;
      return sink?.map((p) => ({ paneId: p.paneId ?? null })) ?? [];
    });
    // Expect at least one payload with paneId="main" and one with paneId="volume".
    const ids = new Set(payloads.map((p) => p.paneId));
    expect(ids.has("main")).toBe(true);
    expect(ids.has("volume")).toBe(true);
  });
});
