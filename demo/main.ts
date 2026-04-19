import { TimeSeriesChart } from "../src/index.js";

const HOUR = 60 * 60 * 1000;
const DEFAULT_INTERVAL = 60_000;

interface DemoWindow {
  readonly startTime: number;
  readonly endTime: number;
  readonly intervalDuration: number;
}

function parseSearch(): DemoWindow {
  const params = new URLSearchParams(globalThis.location.search);
  const start = Number(params.get("start"));
  const end = Number(params.get("end"));
  const interval = Number(params.get("interval"));
  const now = Date.now();
  return {
    startTime: Number.isFinite(start) && start !== 0 ? start : now - 24 * HOUR,
    endTime: Number.isFinite(end) && end !== 0 ? end : now,
    intervalDuration: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL,
  };
}

async function mount(): Promise<TimeSeriesChart> {
  const container = document.getElementById("chart");
  if (container === null) {
    throw new Error("Missing #chart element");
  }
  const win = parseSearch();
  return TimeSeriesChart.create({
    container,
    startTime: win.startTime,
    endTime: win.endTime,
    intervalDuration: win.intervalDuration,
  });
}

async function main(): Promise<void> {
  let chart: TimeSeriesChart | null = await mount();
  let generation = 0;

  const remount = async (): Promise<void> => {
    const gen = ++generation;
    chart?.destroy();
    chart = null;
    const next = await mount();
    if (gen !== generation) {
      next.destroy();
      return;
    }
    chart = next;
  };

  document.getElementById("remount")?.addEventListener("click", () => {
    void remount();
  });

  // Test hook (dev only) — lets Playwright drive direct-API scenarios.
  const testHook = {
    TimeSeriesChart,
    canvasCount: (): number => document.querySelectorAll("canvas").length,
    getChart: (): TimeSeriesChart | null => chart,
  };
  (globalThis as unknown as { __cartaTest?: typeof testHook }).__cartaTest = testHook;
}

void main();
