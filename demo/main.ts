import {
  asTime,
  TimeSeriesChart,
  type ChartWindow,
  type Logger,
  type TimeSeriesChartConstructionOptions,
} from "../src/index.js";
import { __internals__ as timeFormatInternals } from "../src/core/timeFormat.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DEFAULT_INTERVAL = MIN;

interface DemoWindow {
  readonly startTime: number;
  readonly endTime: number;
  readonly intervalDuration: number;
  readonly timeZone: string;
  readonly locale: string;
}

function parseSearch(): DemoWindow {
  const params = new URLSearchParams(globalThis.location.search);
  const start = Number(params.get("start"));
  const end = Number(params.get("end"));
  const interval = Number(params.get("interval"));
  const tz = params.get("tz") ?? "UTC";
  const locale = params.get("locale") ?? "en-US";
  // Anchor the demo window to a fixed moment so Playwright screenshots stay
  // deterministic across runs. Hosts pick their own windows in real usage.
  const anchor = Date.UTC(2026, 3, 19, 12, 0, 0);
  return {
    startTime: Number.isFinite(start) && start !== 0 ? start : anchor - DAY,
    endTime: Number.isFinite(end) && end !== 0 ? end : anchor,
    intervalDuration: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL,
    timeZone: tz,
    locale,
  };
}

interface CapturingLogger extends Logger {
  readonly warnings: string[];
  readonly errors: string[];
}

function createCapturingLogger(): CapturingLogger {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger: CapturingLogger = {
    warnings,
    errors,
    debug: (): void => {},
    info: (): void => {},
    warn: (msg, ...rest): void => {
      warnings.push([msg, ...rest.map((r) => String(r))].join(" "));
    },
    error: (msg, ...rest): void => {
      errors.push([msg, ...rest.map((r) => String(r))].join(" "));
    },
  };
  return logger;
}

let activeLogger: CapturingLogger = createCapturingLogger();

async function mount(): Promise<TimeSeriesChart> {
  const container = document.getElementById("chart");
  if (container === null) {
    throw new Error("Missing #chart element");
  }
  const win = parseSearch();
  activeLogger = createCapturingLogger();
  const opts: TimeSeriesChartConstructionOptions = {
    container,
    startTime: win.startTime,
    endTime: win.endTime,
    intervalDuration: win.intervalDuration,
    logger: activeLogger,
    timeAxis: { formatContext: { locale: win.locale, timeZone: win.timeZone } },
  };
  return TimeSeriesChart.create(opts);
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "—";
  }
  const abs = Math.abs(ms);
  if (abs < 1_000) {
    return `${Math.round(ms)} ms`;
  }
  if (abs < 60_000) {
    return `${(ms / 1_000).toFixed(2)} s`;
  }
  if (abs < HOUR) {
    return `${(ms / 60_000).toFixed(2)} m`;
  }
  if (abs < DAY) {
    return `${(ms / HOUR).toFixed(2)} h`;
  }
  return `${(ms / DAY).toFixed(2)} d`;
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "—";
  }
  try {
    return new Date(ms).toISOString().replace("T", " ").replace(".000Z", "Z");
  } catch {
    return "—";
  }
}

async function main(): Promise<void> {
  let chart: TimeSeriesChart | null = await mount();
  let generation = 0;
  const initialWindow = parseSearch();
  const initialChartWindow: ChartWindow = Object.freeze({
    startTime: asTime(initialWindow.startTime),
    endTime: asTime(initialWindow.endTime),
  });

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

  const readoutStart = document.getElementById("readout-start");
  const readoutEnd = document.getElementById("readout-end");
  const readoutWidth = document.getElementById("readout-width");
  const updateReadout = (): void => {
    if (chart === null) {
      return;
    }
    const win = chart.getWindow();
    const s = Number(win.startTime);
    const e = Number(win.endTime);
    if (readoutStart !== null) {
      readoutStart.textContent = formatTime(s);
    }
    if (readoutEnd !== null) {
      readoutEnd.textContent = formatTime(e);
    }
    if (readoutWidth !== null) {
      readoutWidth.textContent = formatDurationMs(e - s);
    }
    requestAnimationFrame(updateReadout);
  };
  requestAnimationFrame(updateReadout);

  document.getElementById("remount")?.addEventListener("click", () => {
    void remount();
  });
  document.getElementById("reset-view")?.addEventListener("click", () => {
    chart?.setWindow(initialChartWindow);
  });

  // Test hooks (dev only) — used by Playwright for adversarial scenarios.
  const testHook = {
    TimeSeriesChart,
    canvasCount: (): number => document.querySelectorAll("canvas").length,
    getChart: (): TimeSeriesChart | null => chart,
    resize: (w: number, h: number): void => {
      chart?.resize(w, h);
    },
    barsInWindow: (): readonly number[] => {
      const bars = chart?.barsInWindow() ?? [];
      return bars.map((t) => Number(t));
    },
    visibleTickCount: (): number => chart?.visibleTicks().length ?? 0,
    visibleTicks: (): readonly { time: number; x: number; label: string; isDayBoundary: boolean }[] => {
      const ticks = chart?.visibleTicks() ?? [];
      return ticks.map((t) => ({
        time: Number(t.time),
        x: t.x,
        label: t.label,
        isDayBoundary: t.isDayBoundary,
      }));
    },
    axisPoolSize: (): number => chart?.axisPoolSize() ?? 0,
    labelCacheSize: (): number => timeFormatInternals.labelCacheSize(),
    lastWarnings: (): readonly string[] => [...activeLogger.warnings],
    lastErrors: (): readonly string[] => [...activeLogger.errors],
    resetCaches: (): void => timeFormatInternals.resetCaches(),
    remount: (): Promise<void> => remount(),
    getWindow: (): { startTime: number; endTime: number } => {
      const w = chart?.getWindow();
      return {
        startTime: w !== undefined ? Number(w.startTime) : Number.NaN,
        endTime: w !== undefined ? Number(w.endTime) : Number.NaN,
      };
    },
    setWindow: (startTime: number, endTime: number): void => {
      chart?.setWindow({
        startTime: asTime(startTime),
        endTime: asTime(endTime),
      });
    },
    isKineticActive: (): boolean => chart?.isKineticActive() ?? false,
    stopKinetic: (): void => {
      chart?.stopKinetic();
    },
    synthWheel: (opts: {
      x: number;
      y: number;
      deltaY: number;
      shiftKey?: boolean;
      deltaMode?: number;
    }): void => {
      const canvas = document.querySelector("canvas");
      if (canvas === null) {
        return;
      }
      const e = new WheelEvent("wheel", {
        clientX: opts.x,
        clientY: opts.y,
        deltaY: opts.deltaY,
        deltaMode: opts.deltaMode ?? 0,
        shiftKey: opts.shiftKey ?? false,
        bubbles: true,
        cancelable: true,
      });
      canvas.dispatchEvent(e);
    },
    synthDrag: async (opts: {
      startX: number;
      endX: number;
      y?: number;
      durationMs?: number;
      pointerType?: "mouse" | "pen" | "touch";
      steps?: number;
    }): Promise<void> => {
      const canvas = document.querySelector("canvas");
      if (canvas === null) {
        return;
      }
      const y = opts.y ?? 100;
      const duration = opts.durationMs ?? 200;
      const steps = opts.steps ?? 12;
      const pointerType = opts.pointerType ?? "mouse";
      const send = (type: string, x: number, extra: Record<string, unknown> = {}): void => {
        const pe = new PointerEvent(type, {
          clientX: x,
          clientY: y,
          pointerId: 1,
          pointerType,
          bubbles: true,
          cancelable: true,
          ...extra,
        });
        canvas.dispatchEvent(pe);
      };
      send("pointerdown", opts.startX);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = opts.startX + (opts.endX - opts.startX) * t;
        send("pointermove", x);
        await new Promise((r) => setTimeout(r, duration / steps));
      }
      send("pointerup", opts.endX);
    },
  };
  (globalThis as unknown as { __cartaTest?: typeof testHook }).__cartaTest = testHook;
}

void main();
