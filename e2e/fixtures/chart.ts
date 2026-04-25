import { test as base, expect, type Page } from "@playwright/test";

/**
 * Minimal projection of the demo's `globalThis.__cartaTest` harness used
 * by e2e specs. The real harness is far richer; we only declare the
 * accessors and synth helpers actually called from `e2e/*.spec.ts`.
 */
export interface CartaTestHook {
  canvasCount: () => number;
  getChart: () => unknown;
  selectInterval: (intervalDuration: number) => void;
  clearRequestLog: () => void;
  requestLogEntries: () => readonly RequestLogEntrySnapshot[];
  synthDrag: (opts: {
    startX: number;
    endX: number;
    y?: number;
    durationMs?: number;
    steps?: number;
    pointerType?: "mouse" | "pen" | "touch";
  }) => Promise<void>;
  synthWheel: (opts: {
    x: number;
    y: number;
    deltaY: number;
    shiftKey?: boolean;
    deltaMode?: number;
  }) => void;
  resetEventCounts: () => void;
  eventCounts: () => Readonly<Record<string, number>>;
}

export interface RequestLogEntrySnapshot {
  readonly seq: number;
  readonly at: number;
  readonly channelId: string;
  readonly kind: "ohlc" | "point" | "marker";
  readonly interval: number;
  readonly start: number;
  readonly end: number;
  readonly source: "data:request" | "cache-hit-synthetic";
}

export interface ChartWindowSnapshot {
  readonly startTime: number;
  readonly endTime: number;
  readonly intervalDuration: number;
}

export interface ChartFixture {
  page: Page;
  /** Wait for the demo to finish booting: harness exposed + canvas painted. */
  waitForReady: () => Promise<void>;
  /** Read the current chart window from the demo. */
  getWindow: () => Promise<ChartWindowSnapshot>;
  /** Read the current bar interval (ms). */
  getInterval: () => Promise<number>;
  /** Read the current request-log snapshot. */
  getRequestLog: () => Promise<readonly RequestLogEntrySnapshot[]>;
}

export const test = base.extend<{ chart: ChartFixture }>({
  chart: async ({ page }, use) => {
    const fixture: ChartFixture = {
      page,
      waitForReady: async (): Promise<void> => {
        await page.waitForFunction(
          () => {
            const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
            return hook?.canvasCount() === 1 && hook.getChart() !== null;
          },
          undefined,
          { timeout: 15_000 },
        );
        // One extra animation frame so the first paint settles.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => { resolve(); }));
            }),
        );
      },
      getWindow: async (): Promise<ChartWindowSnapshot> =>
        page.evaluate(() => {
          const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
          if (hook === undefined) {
            throw new Error("__cartaTest harness not attached");
          }
          const chart = hook.getChart() as
            | { getWindow: () => ChartWindowSnapshot }
            | null;
          if (chart === null) {
            throw new Error("chart not yet constructed");
          }
          const w = chart.getWindow();
          return {
            startTime: w.startTime,
            endTime: w.endTime,
            intervalDuration: w.intervalDuration,
          };
        }),
      getInterval: async (): Promise<number> =>
        page.evaluate(() => {
          const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
          if (hook === undefined) {
            throw new Error("__cartaTest harness not attached");
          }
          const chart = hook.getChart() as { getInterval: () => number } | null;
          if (chart === null) {
            throw new Error("chart not yet constructed");
          }
          return chart.getInterval();
        }),
      getRequestLog: async (): Promise<readonly RequestLogEntrySnapshot[]> =>
        page.evaluate(() => {
          const hook = (globalThis as { __cartaTest?: CartaTestHook }).__cartaTest;
          if (hook === undefined) {
            throw new Error("__cartaTest harness not attached");
          }
          return hook.requestLogEntries().map((e) => ({ ...e }));
        }),
    };
    await use(fixture);
  },
});

export { expect };
