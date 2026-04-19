import * as CartaExports from "../src/index.js";
import {
  asPrice,
  asTime,
  TimeSeriesChart,
  type CacheStats,
  type CartaEventMap,
  type Channel,
  type ChartWindow,
  type DataRequest,
  type IntervalChange,
  type SizeInfo,
  type Logger,
  type OhlcRecord,
  type PointRecord,
  type PriceFormatter,
  type PriceRange,
  type PriceRangeProvider,
  type PriceTickInfo,
  type Time,
  type TimeSeriesChartConstructionOptions,
} from "../src/index.js";
import { __internals__ as timeFormatInternals } from "../src/core/timeFormat.js";

(globalThis as unknown as { Carta?: typeof CartaExports }).Carta = CartaExports;

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
  readonly priceMin: number;
  readonly priceMax: number;
}

const DEFAULT_PRICE_MIN = 98;
const DEFAULT_PRICE_MAX = 105;

function parseSearch(): DemoWindow {
  const params = new URLSearchParams(globalThis.location.search);
  const start = Number(params.get("start"));
  const end = Number(params.get("end"));
  const interval = Number(params.get("interval"));
  const tz = params.get("tz") ?? "UTC";
  const locale = params.get("locale") ?? "en-US";
  const pMinRaw = params.get("priceMin");
  const pMaxRaw = params.get("priceMax");
  const priceMin = pMinRaw !== null && Number.isFinite(Number(pMinRaw)) ? Number(pMinRaw) : DEFAULT_PRICE_MIN;
  const priceMax = pMaxRaw !== null && Number.isFinite(Number(pMaxRaw)) ? Number(pMaxRaw) : DEFAULT_PRICE_MAX;
  // Anchor the demo window to a fixed moment so Playwright screenshots stay
  // deterministic across runs. Hosts pick their own windows in real usage.
  const anchor = Date.UTC(2026, 3, 19, 12, 0, 0);
  return {
    startTime: Number.isFinite(start) && start !== 0 ? start : anchor - DAY,
    endTime: Number.isFinite(end) && end !== 0 ? end : anchor,
    intervalDuration: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL,
    timeZone: tz,
    locale,
    priceMin,
    priceMax,
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
    debug: (): void => undefined,
    info: (): void => undefined,
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

/**
 * Deterministic synthetic provider used to drive auto-scale from the demo
 * until phase 07's real series arrive. Emits a seeded sine + noise range
 * derived from the visible window boundaries so pans visibly shift the
 * domain without any real data.
 */
function createSyntheticProvider(priceMid: number, priceAmp: number): PriceRangeProvider {
  const hashWindow = (start: Time, end: Time): number => {
    const s = Math.floor(Number(start) / 60_000);
    const e = Math.floor(Number(end) / 60_000);
    let h = (s ^ (e << 1)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
  };
  return {
    priceRangeInWindow: (startTime: Time, endTime: Time): PriceRange | null => {
      const s = Number(startTime);
      const e = Number(endTime);
      if (!Number.isFinite(s) || !Number.isFinite(e) || s >= e) {
        return null;
      }
      const phase = (s / HOUR) % (Math.PI * 2);
      const wiggle = Math.sin(phase) * priceAmp * 0.35;
      const jitter = (hashWindow(startTime, endTime) - 0.5) * priceAmp * 0.25;
      const center = priceMid + wiggle + jitter;
      const half = priceAmp * (0.8 + hashWindow(endTime, startTime) * 0.4);
      return { min: asPrice(center - half), max: asPrice(center + half) };
    },
  };
}

let activeSyntheticProvider: PriceRangeProvider | null = null;

const DEMO_OHLC_CHANNEL = "demo-ohlc";
const DEMO_VOLUME_CHANNEL = "demo-volume";

interface SyntheticBar extends OhlcRecord {
  readonly volume: number;
}

/**
 * Deterministic seeded synthetic OHLC + volume generator. Used by the demo's
 * "Load synthetic data" button to exercise the cache wiring before Phase 07
 * series exist to render it. Inputs are bar-aligned; output is sorted asc.
 */
function generateSyntheticOhlc(
  startTime: number,
  endTime: number,
  intervalDuration: number,
  basePrice: number,
): SyntheticBar[] {
  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    !Number.isFinite(intervalDuration) ||
    intervalDuration <= 0 ||
    !Number.isInteger(intervalDuration) ||
    startTime > endTime
  ) {
    return [];
  }
  const start = Math.floor(startTime / intervalDuration) * intervalDuration;
  const end = Math.floor(endTime / intervalDuration) * intervalDuration;
  const out: SyntheticBar[] = [];
  let prev = basePrice;
  let seed = 0x9e3779b1 ^ start;
  const next = (): number => {
    seed = Math.imul(seed ^ (seed >>> 15), 0x85ebca6b) >>> 0;
    seed = Math.imul(seed ^ (seed >>> 13), 0xc2b2ae35) >>> 0;
    return ((seed ^ (seed >>> 16)) >>> 0) / 0xffffffff;
  };
  for (let t = start; t <= end; t += intervalDuration) {
    const drift = (next() - 0.5) * basePrice * 0.01;
    const open = prev;
    const close = Math.max(0.01, open + drift);
    const high = Math.max(open, close) + next() * basePrice * 0.005;
    const low = Math.min(open, close) - next() * basePrice * 0.005;
    const volume = Math.floor(next() * 5000) + 100;
    out.push({
      time: asTime(t),
      open: asPrice(open),
      high: asPrice(high),
      low: asPrice(Math.max(0.0001, low)),
      close: asPrice(close),
      volume,
    });
    prev = close;
  }
  return out;
}

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
  const chart = await TimeSeriesChart.create(opts);
  chart.priceScale().setDomain(win.priceMin, win.priceMax);
  const mid = (win.priceMin + win.priceMax) / 2;
  const amp = Math.max(0.5, (win.priceMax - win.priceMin) / 2);
  activeSyntheticProvider = createSyntheticProvider(mid, amp);
  chart.addPriceRangeProvider(activeSyntheticProvider);
  return chart;
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "—";
  }
  const abs = Math.abs(ms);
  if (abs < 1_000) {
    return `${String(Math.round(ms))} ms`;
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

interface EventCounts {
  window: number;
  interval: number;
  data: number;
  resize: number;
}

async function main(): Promise<void> {
  let chart: TimeSeriesChart | null = null;
  let generation = 0;
  const initialWindow = parseSearch();
  const initialWindowInput: { startTime: Time; endTime: Time } = Object.freeze({
    startTime: asTime(initialWindow.startTime),
    endTime: asTime(initialWindow.endTime),
  });

  const eventCounts: EventCounts = { window: 0, interval: 0, data: 0, resize: 0 };
  const lastEvents: {
    window?: ChartWindow;
    interval?: IntervalChange;
    data?: DataRequest;
    resize?: SizeInfo;
  } = {};
  let autoSupply = false;

  const onWindowChange = (win: ChartWindow): void => {
    eventCounts.window++;
    lastEvents.window = win;
  };
  const onIntervalChange = (change: IntervalChange): void => {
    eventCounts.interval++;
    lastEvents.interval = change;
  };
  const onResize = (size: SizeInfo): void => {
    eventCounts.resize++;
    lastEvents.resize = size;
  };
  const onDataRequest = (req: DataRequest): void => {
    eventCounts.data++;
    lastEvents.data = req;
    if (!autoSupply || chart === null) {
      return;
    }
    if (req.kind !== "ohlc" && req.kind !== "point") {
      return;
    }
    const iv = Number(req.intervalDuration);
    const start = Number(req.startTime);
    const end = Number(req.endTime);
    if (!Number.isFinite(iv) || iv <= 0 || !Number.isFinite(start) || !Number.isFinite(end)) {
      return;
    }
    const bars = generateSyntheticOhlc(start, end, iv, 100);
    if (req.kind === "ohlc") {
      chart.supplyData(req.channelId, iv, bars);
    } else {
      const points: PointRecord[] = bars.map((b) => ({ time: b.time, value: asPrice(b.volume) }));
      chart.supplyData(req.channelId, iv, points);
    }
  };

  const wireEvents = (c: TimeSeriesChart): void => {
    c.on("window:change", onWindowChange);
    c.on("interval:change", onIntervalChange);
    c.on("resize", onResize);
    c.on("data:request", onDataRequest);
  };

  const resetEventCounts = (): void => {
    eventCounts.window = 0;
    eventCounts.interval = 0;
    eventCounts.data = 0;
    eventCounts.resize = 0;
  };

  chart = await mount();
  wireEvents(chart);

  const remount = async (): Promise<void> => {
    const gen = ++generation;
    chart?.destroy();
    chart = null;
    resetEventCounts();
    const next = await mount();
    if (gen !== generation) {
      next.destroy();
      return;
    }
    chart = next;
    wireEvents(chart);
  };

  const readoutStart = document.getElementById("readout-start");
  const readoutEnd = document.getElementById("readout-end");
  const readoutWidth = document.getElementById("readout-width");
  const readoutDomain = document.getElementById("readout-domain");
  const readoutCache = document.getElementById("readout-cache");
  const readoutEvents = document.getElementById("readout-events");
  const formatCacheStats = (stats: readonly CacheStats[]): string => {
    if (stats.length === 0) {
      return "—";
    }
    return stats
      .map((s) => `${s.channelId}(${s.kind}):${String(s.totalRecords)}`)
      .join(" · ");
  };
  const updateReadout = (): void => {
    requestAnimationFrame(updateReadout);
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
    if (readoutDomain !== null) {
      const d = chart.priceScale().getDomain();
      readoutDomain.textContent = `${Number(d.min).toFixed(2)} – ${Number(d.max).toFixed(2)}`;
    }
    if (readoutCache !== null) {
      readoutCache.textContent = formatCacheStats(chart.cacheStats());
    }
    if (readoutEvents !== null) {
      readoutEvents.textContent = `w:${String(eventCounts.window)} i:${String(eventCounts.interval)} d:${String(eventCounts.data)} r:${String(eventCounts.resize)}`;
    }
  };
  requestAnimationFrame(updateReadout);

  document.getElementById("remount")?.addEventListener("click", () => {
    void remount();
  });
  document.getElementById("reset-view")?.addEventListener("click", () => {
    chart?.setWindow(initialWindowInput);
  });
  const loadSyntheticData = (): void => {
    if (chart === null) {
      return;
    }
    const win = chart.getWindow();
    const iv = chart.getInterval();
    const ivNum = Number(iv);
    const s = Number(win.startTime);
    const e = Number(win.endTime);
    if (!Number.isFinite(ivNum) || ivNum <= 0 || !Number.isFinite(s) || !Number.isFinite(e)) {
      return;
    }
    const domain = chart.priceScale().getDomain();
    const mid = (Number(domain.min) + Number(domain.max)) / 2 || 100;
    const ohlc: Channel = { id: DEMO_OHLC_CHANNEL, kind: "ohlc" };
    const volume: Channel = { id: DEMO_VOLUME_CHANNEL, kind: "point" };
    chart.defineChannel(ohlc);
    chart.defineChannel(volume);
    const bars = generateSyntheticOhlc(s, e, ivNum, mid);
    chart.supplyData(DEMO_OHLC_CHANNEL, ivNum, bars);
    const points: PointRecord[] = bars.map((b) => ({
      time: b.time,
      value: asPrice(b.volume),
    }));
    chart.supplyData(DEMO_VOLUME_CHANNEL, ivNum, points);
  };
  document.getElementById("load-data")?.addEventListener("click", loadSyntheticData);
  document.getElementById("clear-cache")?.addEventListener("click", () => {
    chart?.clearCache();
  });
  const autoSupplyBtn = document.getElementById("auto-supply");
  const updateAutoSupplyBtn = (): void => {
    if (autoSupplyBtn === null) {
      return;
    }
    autoSupplyBtn.textContent = `Auto-supply: ${autoSupply ? "ON" : "OFF"}`;
    autoSupplyBtn.setAttribute("aria-pressed", String(autoSupply));
  };
  autoSupplyBtn?.addEventListener("click", () => {
    autoSupply = !autoSupply;
    updateAutoSupplyBtn();
  });
  updateAutoSupplyBtn();
  const autoScaleBtn = document.getElementById("auto-scale");
  const updateAutoBtn = (): void => {
    if (autoScaleBtn === null) {
      return;
    }
    const on = chart?.priceScale().isAutoScale() ?? false;
    autoScaleBtn.textContent = `Auto-scale: ${on ? "ON" : "OFF"}`;
    autoScaleBtn.setAttribute("aria-pressed", String(on));
  };
  autoScaleBtn?.addEventListener("click", () => {
    if (chart === null) {
      return;
    }
    const current = chart.priceScale().isAutoScale();
    chart.priceScale().setAutoScale(!current);
    updateAutoBtn();
  });
  const priceReadoutRaf = (): void => {
    updateAutoBtn();
    requestAnimationFrame(priceReadoutRaf);
  };
  requestAnimationFrame(priceReadoutRaf);

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
    priceTicks: (): readonly { value: number; y: number; label: string }[] => {
      const ticks: readonly PriceTickInfo[] = chart?.visiblePriceTicks() ?? [];
      return ticks.map((t) => ({ value: t.value, y: t.y, label: t.label }));
    },
    priceTickCount: (): number => chart?.visiblePriceTicks().length ?? 0,
    priceAxisPoolSize: (): number => chart?.priceAxisPoolSize() ?? 0,
    getPriceDomain: (): { min: number; max: number } => {
      const d = chart?.priceScale().getDomain();
      return {
        min: d !== undefined ? Number(d.min) : Number.NaN,
        max: d !== undefined ? Number(d.max) : Number.NaN,
      };
    },
    setPriceDomain: (min: number, max: number): void => {
      chart?.priceScale().setDomain(min, max);
    },
    isPriceAutoScale: (): boolean => chart?.priceScale().isAutoScale() ?? false,
    setPriceAutoScale: (on: boolean): void => {
      chart?.priceScale().setAutoScale(on);
      updateAutoBtn();
    },
    addSyntheticProvider: (mid: number, amp: number): void => {
      if (chart === null) {
        return;
      }
      if (activeSyntheticProvider !== null) {
        chart.removePriceRangeProvider(activeSyntheticProvider);
      }
      activeSyntheticProvider = createSyntheticProvider(mid, amp);
      chart.addPriceRangeProvider(activeSyntheticProvider);
    },
    removeSyntheticProvider: (): void => {
      if (chart === null || activeSyntheticProvider === null) {
        return;
      }
      chart.removePriceRangeProvider(activeSyntheticProvider);
      activeSyntheticProvider = null;
    },
    addThrowingProvider: (): PriceRangeProvider => {
      const p: PriceRangeProvider = {
        priceRangeInWindow: (): PriceRange | null => {
          throw new Error("provider failure (test hook)");
        },
      };
      chart?.addPriceRangeProvider(p);
      return p;
    },
    addFixedRangeProvider: (min: number, max: number): PriceRangeProvider => {
      const p: PriceRangeProvider = {
        priceRangeInWindow: (): PriceRange | null => ({
          min: asPrice(min),
          max: asPrice(max),
        }),
      };
      chart?.addPriceRangeProvider(p);
      return p;
    },
    addNullProvider: (): PriceRangeProvider => {
      const p: PriceRangeProvider = {
        priceRangeInWindow: (): PriceRange | null => null,
      };
      chart?.addPriceRangeProvider(p);
      return p;
    },
    removeProvider: (p: PriceRangeProvider): void => {
      chart?.removePriceRangeProvider(p);
    },
    setPriceFormatter: (formatter: PriceFormatter): void => {
      chart?.applyOptions({ priceFormatter: formatter });
    },
    resetPriceFormatter: (): void => {
      chart?.applyOptions({ priceFormatter: (v) => v.toFixed(2) });
    },
    labelCacheSize: (): number => timeFormatInternals.labelCacheSize(),
    lastWarnings: (): readonly string[] => [...activeLogger.warnings],
    lastErrors: (): readonly string[] => [...activeLogger.errors],
    resetCaches: (): void => { timeFormatInternals.resetCaches(); },
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
    // ── Phase 05 cycle 2 wiring hooks ────────────────────────────────────
    defineChannel: (channel: Channel): void => {
      chart?.defineChannel(channel);
    },
    supplyData: (
      channelId: string,
      intervalDuration: number,
      records: readonly (OhlcRecord | PointRecord)[],
    ): void => {
      chart?.supplyData(channelId, intervalDuration, records);
    },
    supplyTick: (
      channelId: string,
      record: OhlcRecord | PointRecord,
      intervalDuration?: number,
    ): void => {
      chart?.supplyTick(channelId, record, intervalDuration);
    },
    chartSetInterval: (intervalDuration: number): void => {
      chart?.setInterval(intervalDuration);
    },
    chartGetInterval: (): number =>
      chart === null ? Number.NaN : Number(chart.getInterval()),
    chartClearCache: (opts?: { channelId?: string; intervalDuration?: number }): void => {
      chart?.clearCache(opts);
    },
    cacheStats: (): readonly CacheStats[] => chart?.cacheStats() ?? [],
    recordsInRange: (
      channelId: string,
      intervalDuration: number,
      startTime: number,
      endTime: number,
    ): readonly (OhlcRecord | PointRecord)[] =>
      (chart?.recordsInRange(
        channelId,
        intervalDuration,
        startTime,
        endTime,
      ) as readonly (OhlcRecord | PointRecord)[] | undefined) ?? [],
    missingRanges: (
      channelId: string,
      query?: { startTime?: number; endTime?: number; intervalDuration?: number },
    ): readonly { start: number; end: number }[] =>
      chart?.missingRanges(channelId, query) ?? [],
    loadDemoData: loadSyntheticData,
    generateOhlc: (
      startTime: number,
      endTime: number,
      intervalDuration: number,
      basePrice: number,
    ): readonly OhlcRecord[] =>
      generateSyntheticOhlc(startTime, endTime, intervalDuration, basePrice),
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
    synthVerticalDrag: async (opts: {
      x: number;
      startY: number;
      endY: number;
      durationMs?: number;
      pointerType?: "mouse" | "pen" | "touch";
      steps?: number;
    }): Promise<void> => {
      const canvas = document.querySelector("canvas");
      if (canvas === null) {
        return;
      }
      const duration = opts.durationMs ?? 200;
      const steps = opts.steps ?? 12;
      const pointerType = opts.pointerType ?? "mouse";
      const send = (type: string, y: number, extra: Record<string, unknown> = {}): void => {
        const pe = new PointerEvent(type, {
          clientX: opts.x,
          clientY: y,
          pointerId: 1,
          pointerType,
          bubbles: true,
          cancelable: true,
          ...extra,
        });
        canvas.dispatchEvent(pe);
      };
      send("pointerdown", opts.startY);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const y = opts.startY + (opts.endY - opts.startY) * t;
        send("pointermove", y);
        await new Promise((r) => setTimeout(r, duration / steps));
      }
      send("pointerup", opts.endY);
    },
    synthPointer: (
      type: "pointerdown" | "pointermove" | "pointerup",
      x: number,
      y: number,
      pointerId = 1,
    ): void => {
      const canvas = document.querySelector("canvas");
      if (canvas === null) {
        return;
      }
      canvas.dispatchEvent(
        new PointerEvent(type, {
          clientX: x,
          clientY: y,
          pointerId,
          pointerType: "mouse",
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    stripX: (): number => {
      const canvas = document.querySelector("canvas");
      if (canvas === null) {
        return 0;
      }
      return canvas.clientWidth - 32;
    },
    // ── Phase 06 event hooks ─────────────────────────────────────────────
    eventCounts: (): Readonly<EventCounts> => ({ ...eventCounts }),
    resetEventCounts,
    getLastEvents: (): Readonly<{
      window?: ChartWindow;
      interval?: IntervalChange;
      data?: DataRequest;
      resize?: SizeInfo;
    }> => ({ ...lastEvents }),
    setAutoSupply: (on: boolean): void => {
      autoSupply = on;
      updateAutoSupplyBtn();
    },
    isAutoSupplyOn: (): boolean => autoSupply,
    hasPendingDataRequest: (): boolean => chart?.hasPendingDataRequest() ?? false,
    chartOn: <K extends keyof CartaEventMap>(
      event: K,
      handler: (payload: CartaEventMap[K]) => void,
    ): void => {
      chart?.on(event, handler);
    },
    chartOff: <K extends keyof CartaEventMap>(
      event: K,
      handler: (payload: CartaEventMap[K]) => void,
    ): void => {
      chart?.off(event, handler);
    },
    chartRemoveAllListeners: (): void => {
      chart?.removeAllListeners();
    },
  };
  (globalThis as unknown as { __cartaTest?: typeof testHook }).__cartaTest = testHook;
}

void main();
