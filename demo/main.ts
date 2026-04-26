import * as CartaExports from "../src/index.js";
import {
  asPrice,
  asTime,
  AreaSeries,
  BaselineSeries,
  CandlestickSeries,
  DarkTheme,
  defaultPriceFormatter,
  formatAxisLabel,
  HeikinAshiSeries,
  HistogramSeries,
  installHotkeys,
  LightTheme,
  LineSeries,
  MarkerOverlay,
  OhlcBarSeries,
  TimeSeriesChart,
  type KeyboardHotkeyPayload,
  type MagnetMode,
  type BaselineMode,
  type CacheStats,
  type CartaEventMap,
  type Channel,
  type ChartWindow,
  type CrosshairSeriesKey,
  type DataRequest,
  type IntervalChange,
  type LineStyle,
  type LineType,
  type MarkerRecord,
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
import { __internals__ as timeFormatInternals } from "../src/core/time/timeFormat.js";
import { computePivotMarkers, MockSource } from "./mock-source.js";
import { LiveTickDriver } from "./live-tick-driver.js";
import { RequestLog, type RequestLogEntry } from "./request-log.js";

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
const DEMO_SMA_CHANNEL = "demo-sma";
const DEMO_MARKER_CHANNEL = "demo-markers";
const SMA_PERIOD = 20;

const sharedMockSource = new MockSource({ basePrice: 100 });

type PrimarySeriesType = "candle" | "ohlc-bar" | "heikin-ashi";

type PrimarySeries = CandlestickSeries | OhlcBarSeries | HeikinAshiSeries;

function createPrimarySeries(type: PrimarySeriesType, channel: string): PrimarySeries {
  switch (type) {
    case "candle":
      return new CandlestickSeries({ channel });
    case "ohlc-bar":
      return new OhlcBarSeries({ channel });
    case "heikin-ashi":
      return new HeikinAshiSeries({ channel });
  }
}

interface MountResult {
  readonly chart: TimeSeriesChart;
  readonly primary: PrimarySeries;
  readonly sma: LineSeries;
  readonly volume: HistogramSeries;
}

interface MountOptions {
  readonly primaryType: PrimarySeriesType;
  readonly lineStyle: LineStyle;
  readonly lineType: LineType;
}

interface DprStub {
  readonly hooks: { matchMedia: (q: string) => MediaQueryList; devicePixelRatio: () => number };
  readonly setDpr: (next: number) => void;
  readonly fire: () => void;
  readonly stats: () => { addCount: number; removeCount: number; activeListeners: number };
}

let activeDprStub: DprStub | null = null;

function createDprStub(initial: number): DprStub {
  let dpr = initial;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const counters = { addCount: 0, removeCount: 0 };
  return {
    hooks: {
      matchMedia: (q: string): MediaQueryList => {
        const mql = {
          matches: false,
          media: q,
          onchange: null,
          addEventListener: (_t: string, l: (e: MediaQueryListEvent) => void): void => {
            counters.addCount += 1;
            listeners.add(l);
          },
          removeEventListener: (_t: string, l: (e: MediaQueryListEvent) => void): void => {
            counters.removeCount += 1;
            listeners.delete(l);
          },
          dispatchEvent: (): boolean => true,
        } as unknown as MediaQueryList;
        return mql;
      },
      devicePixelRatio: (): number => dpr,
    },
    setDpr: (next: number): void => { dpr = next; },
    fire: (): void => {
      const event = { matches: true } as MediaQueryListEvent;
      for (const l of [...listeners]) {
        l(event);
      }
    },
    stats: (): { addCount: number; removeCount: number; activeListeners: number } => ({
      addCount: counters.addCount,
      removeCount: counters.removeCount,
      activeListeners: listeners.size,
    }),
  };
}

async function mount(mountOpts: MountOptions): Promise<MountResult> {
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
  const search = new URLSearchParams(globalThis.location.search);
  if (search.get("dprStub") === "1") {
    const initialDpr = Number(search.get("dprInitial") ?? "1") || 1;
    activeDprStub = createDprStub(initialDpr);
    (opts as TimeSeriesChartConstructionOptions & { dprListenerHooks: DprStub["hooks"] }).dprListenerHooks =
      activeDprStub.hooks;
  } else {
    activeDprStub = null;
  }
  const chart = await TimeSeriesChart.create(opts);
  chart.priceScale().setDomain(win.priceMin, win.priceMax);
  chart.priceScale().setAutoScale(true);
  chart.defineChannel({ id: DEMO_VOLUME_CHANNEL, kind: "point" });
  chart.defineChannel({ id: DEMO_MARKER_CHANNEL, kind: "marker" });
  const primary = chart.addSeries(createPrimarySeries(mountOpts.primaryType, DEMO_OHLC_CHANNEL));
  const sma = chart.addSeries(
    new LineSeries({
      channel: DEMO_SMA_CHANNEL,
      lineStyle: mountOpts.lineStyle,
      lineType: mountOpts.lineType,
    }),
  );
  const volume = chart.addSeries(
    new HistogramSeries({
      channel: DEMO_VOLUME_CHANNEL,
      // Volume is pre-scaled host-side into the bottom 15% of the candle
      // range; opt out of auto-scale so the series doesn't drag the domain
      // down to `base` and crush the candle band.
      participatesInAutoScale: false,
    }),
  );
  return { chart, primary, sma, volume };
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
  tracking: number;
}

async function main(): Promise<void> {
  let chart: TimeSeriesChart | null = null;
  let generation = 0;
  const initialWindow = parseSearch();
  const initialWindowInput: { startTime: Time; endTime: Time } = Object.freeze({
    startTime: asTime(initialWindow.startTime),
    endTime: asTime(initialWindow.endTime),
  });

  const eventCounts: EventCounts = { window: 0, interval: 0, data: 0, resize: 0, tracking: 0 };
  const trackingChangeLog: { active: boolean; at: number }[] = [];
  let lastTrackingChange: { active: boolean } | null = null;
  const lastEvents: {
    window?: ChartWindow;
    interval?: IntervalChange;
    data?: DataRequest;
    resize?: SizeInfo;
  } = {};
  let autoSupply = true;
  let lastCrosshairPayload: CartaEventMap["crosshair:move"] | null = null;
  let crosshairPayloadCount = 0;

  // Demo mirrors the formatter it passes to `applyOptions`. The library has
  // no public getter, so we keep a local ref and update it in lockstep with
  // any `applyOptions({priceFormatter})` call.
  let currentPriceFormatter: PriceFormatter = defaultPriceFormatter;

  interface SeriesMeta {
    readonly name: string;
    readonly kind: "ohlc" | "point" | "marker";
  }
  const seriesMeta = new Map<CrosshairSeriesKey, SeriesMeta>();
  const keyOf = (s: object): CrosshairSeriesKey => s as unknown as CrosshairSeriesKey;

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
    if (req.channelId === DEMO_OHLC_CHANNEL) {
      const bars = sharedMockSource.fetchOhlc(iv, start, end);
      chart.supplyData(req.channelId, iv, bars);
      // Pre-supply marker channel alongside OHLC — markers never fire their
      // own data:request (marker-kind channels short-circuit in
      // `DataStore.missingRanges`), so the host must push them proactively.
      const markers = sharedMockSource.fetchEvents(iv, start, end);
      if (markers.length > 0) {
        chart.supplyData(DEMO_MARKER_CHANNEL, iv, markers);
      }
      return;
    }
    if (req.channelId === DEMO_SMA_CHANNEL) {
      const sma = sharedMockSource.fetchSma(iv, start, end, SMA_PERIOD);
      if (sma.length > 0) {
        chart.supplyData(req.channelId, iv, sma);
      }
      return;
    }
    if (req.channelId === DEMO_VOLUME_CHANNEL) {
      const points = sharedMockSource.fetchVolume(iv, start, end);
      if (points.length > 0) {
        chart.supplyData(req.channelId, iv, points);
      }
    }
  };

  const onCrosshairMove = (info: CartaEventMap["crosshair:move"]): void => {
    lastCrosshairPayload = info;
    crosshairPayloadCount += 1;
    // Cycle B fix F-2 — write the panel inline with the emit so the next
    // paint reflects this frame's payload (≤ 1 RAF). DOM writes are still
    // ≤ 1/RAF because the controller caps emits at RAF rate; cxCache
    // suppresses no-op writes.
    updateCrosshairPanel();
  };

  const onTrackingChange = (payload: CartaEventMap["tracking:change"]): void => {
    eventCounts.tracking += 1;
    lastTrackingChange = { active: payload.active };
    trackingChangeLog.push({ active: payload.active, at: performance.now() });
  };

  const wireEvents = (c: TimeSeriesChart): void => {
    c.on("window:change", onWindowChange);
    c.on("interval:change", onIntervalChange);
    c.on("resize", onResize);
    c.on("data:request", onDataRequest);
    c.on("crosshair:move", onCrosshairMove);
    c.on("tracking:change", onTrackingChange);
  };

  const resetEventCounts = (): void => {
    eventCounts.window = 0;
    eventCounts.interval = 0;
    eventCounts.data = 0;
    eventCounts.resize = 0;
    eventCounts.tracking = 0;
    trackingChangeLog.length = 0;
    lastTrackingChange = null;
  };

  let primary: PrimarySeries | null = null;
  let primaryType: PrimarySeriesType = "candle";
  let sma: LineSeries | null = null;
  let volume: HistogramSeries | null = null;
  let areaExtra: AreaSeries | null = null;
  let baselineExtra: BaselineSeries | null = null;
  let markerOverlay: MarkerOverlay | null = null;
  let currentLineStyle: LineStyle = "solid";
  let currentLineType: LineType = "simple";

  const buildMountOpts = (): MountOptions => ({
    primaryType,
    lineStyle: currentLineStyle,
    lineType: currentLineType,
  });

  const primaryLabelFor = (type: PrimarySeriesType): string => {
    switch (type) {
      case "candle":
        return "Candles";
      case "ohlc-bar":
        return "OHLC bars";
      case "heikin-ashi":
        return "Heikin-Ashi";
    }
  };

  const refreshSeriesMeta = (): void => {
    seriesMeta.clear();
    if (primary !== null) {
      seriesMeta.set(keyOf(primary), { name: primaryLabelFor(primaryType), kind: "ohlc" });
    }
    if (sma !== null) {
      seriesMeta.set(keyOf(sma), { name: "SMA", kind: "point" });
    }
    if (volume !== null) {
      seriesMeta.set(keyOf(volume), { name: "Volume", kind: "point" });
    }
    if (areaExtra !== null) {
      seriesMeta.set(keyOf(areaExtra), { name: "Area", kind: "point" });
    }
    if (baselineExtra !== null) {
      seriesMeta.set(keyOf(baselineExtra), { name: "Baseline", kind: "point" });
    }
    if (markerOverlay !== null) {
      seriesMeta.set(keyOf(markerOverlay), { name: "Markers", kind: "marker" });
    }
  };

  {
    const first = await mount(buildMountOpts());
    chart = first.chart;
    primary = first.primary;
    sma = first.sma;
    volume = first.volume;
    wireEvents(chart);
    refreshSeriesMeta();
  }

  // Phase 13 Cycle B1 — install document-scope Alt+letter hotkeys for the
  // recommended drawing-tool bindings. Hotkey payloads are recorded on the
  // test hooks for adversarial Playwright validation.
  let hotkeyDispose: (() => void) | null = null;
  let lastHotkeyPayload: KeyboardHotkeyPayload | null = null;
  let hotkeyPayloadCount = 0;
  const armHotkeys = (c: TimeSeriesChart): void => {
    hotkeyDispose?.();
    hotkeyDispose = installHotkeys(c);
    c.on("keyboard:hotkey", (p) => {
      lastHotkeyPayload = p;
      hotkeyPayloadCount += 1;
      updateDrawingToolButtons();
    });
  };
  armHotkeys(chart);

  const remount = async (): Promise<void> => {
    const gen = ++generation;
    // Phase 11 cycle A — drop the live-tick driver before destroying the chart
    // so we don't hold a dangling reference. Re-arm after mount if the user
    // had toggled it ON.
    const liveWanted = liveTickWanted;
    liveTickDriver?.stop();
    liveTickDriver = null;
    chart?.destroy();
    chart = null;
    primary = null;
    sma = null;
    volume = null;
    areaExtra = null;
    baselineExtra = null;
    markerOverlay = null;
    overlayAlt = null;
    resetEventCounts();
    // Cycle B — drop stale crosshair state so the side panel doesn't render
    // a payload whose series keys point at destroyed instances.
    lastCrosshairPayload = null;
    crosshairPayloadCount = 0;
    seriesMeta.clear();
    // Cycle B fix F-2 — sync the panel to em-dashes immediately, before the
    // next mount potentially re-emits, so the AC "panel reverts to em-dashes
    // within 1 RAF without cursor move" holds even on slow remounts.
    updateCrosshairPanel();
    const next = await mount(buildMountOpts());
    if (gen !== generation) {
      next.chart.destroy();
      return;
    }
    chart = next.chart;
    primary = next.primary;
    sma = next.sma;
    volume = next.volume;
    wireEvents(chart);
    chart.on("data:request", logRequest);
    armHotkeys(chart);
    refreshSeriesMeta();
    // Phase 10 — re-apply the active theme so a remount doesn't snap back to
    // dark when the user had flipped to light.
    if (currentThemeName === "light") {
      chart.applyOptions({ theme: LightTheme });
    }
    // Re-apply overlay shape if user had swapped to area/baseline pre-remount.
    if (overlayShape !== "line") {
      const targetShape = overlayShape;
      overlayShape = "line";
      setOverlayShape(targetShape);
    }
    if (liveWanted) {
      liveTickDriver = buildLiveTickDriver();
      liveTickDriver?.start();
      updateLiveTickBtn();
    }
  };

  const setPrimaryType = (next: PrimarySeriesType): void => {
    if (chart === null || next === primaryType) {
      return;
    }
    if (primary !== null) {
      chart.removeSeries(primary);
    }
    primaryType = next;
    primary = chart.addSeries(createPrimarySeries(next, DEMO_OHLC_CHANNEL));
    refreshSeriesMeta();
    const sel = document.getElementById("primary-series-type") as HTMLSelectElement | null;
    if (sel !== null && sel.value !== next) {
      sel.value = next;
    }
  };

  const addMarkerOverlay = (): boolean => {
    if (chart === null || markerOverlay !== null) {
      return false;
    }
    markerOverlay = chart.addSeries(
      new MarkerOverlay({
        channel: DEMO_MARKER_CHANNEL,
        priceReference: { channel: DEMO_OHLC_CHANNEL },
      }),
    );
    refreshSeriesMeta();
    return true;
  };

  const removeMarkerOverlay = (): boolean => {
    if (chart === null || markerOverlay === null) {
      return false;
    }
    const removed = chart.removeSeries(markerOverlay);
    if (removed) {
      markerOverlay = null;
      refreshSeriesMeta();
    }
    return removed;
  };

  const replaceSmaLine = (): void => {
    if (chart === null || sma === null) {
      return;
    }
    chart.removeSeries(sma);
    sma = chart.addSeries(
      new LineSeries({
        channel: DEMO_SMA_CHANNEL,
        lineStyle: currentLineStyle,
        lineType: currentLineType,
      }),
    );
    refreshSeriesMeta();
  };

  const setLineStyle = (style: LineStyle, type: LineType): void => {
    currentLineStyle = style;
    currentLineType = type;
    replaceSmaLine();
  };

  const readoutStart = document.getElementById("readout-start");
  const readoutEnd = document.getElementById("readout-end");
  const readoutWidth = document.getElementById("readout-width");
  const readoutDomain = document.getElementById("readout-domain");
  const readoutCache = document.getElementById("readout-cache");
  const readoutEvents = document.getElementById("readout-events");
  const cxPanel = document.getElementById("crosshair-panel");
  const cxStatus = document.getElementById("cx-status");
  const cxTime = document.getElementById("cx-time");
  const cxPrice = document.getElementById("cx-price");
  const cxPoint = document.getElementById("cx-point");
  const cxEmits = document.getElementById("cx-emits");
  const cxSeries = document.getElementById("series-readouts");

  const EM_DASH = "—";
  // Field-level cache so we only mutate textContent when the rendered string
  // actually changes — keeps DOM writes at 0 cost during settled hover.
  const cxCache = {
    status: "",
    time: "",
    price: "",
    point: "",
    emits: "",
    active: false,
    seriesHtml: "",
  };

  const formatOhlcValue = (v: number, formatter: PriceFormatter): string => {
    if (!Number.isFinite(v)) { return EM_DASH; }
    try { return formatter(v); } catch { return EM_DASH; }
  };

  const appendKV = (parent: HTMLElement, label: string, value: string): void => {
    const lbl = document.createElement("span");
    lbl.className = "label";
    lbl.textContent = label;
    const val = document.createElement("span");
    val.className = "value";
    val.textContent = value;
    parent.append(lbl, val);
  };

  // Builds a fingerprint for `cxCache` diffing. Includes only the dynamic
  // fields (per-series values + meta size); the structure is stable for a
  // given seriesMeta state, so a fingerprint match guarantees zero DOM work.
  const seriesReadoutFingerprint = (
    payload: CartaEventMap["crosshair:move"] | null,
  ): string => {
    if (seriesMeta.size === 0) { return ""; }
    const parts: string[] = [];
    for (const [key, meta] of seriesMeta) {
      const rec = payload?.seriesData.get(key) ?? null;
      parts.push(meta.name, meta.kind);
      if (meta.kind === "ohlc") {
        const o = rec !== null && "open" in rec ? formatOhlcValue(Number(rec.open), currentPriceFormatter) : EM_DASH;
        const h = rec !== null && "high" in rec ? formatOhlcValue(Number(rec.high), currentPriceFormatter) : EM_DASH;
        const l = rec !== null && "low" in rec ? formatOhlcValue(Number(rec.low), currentPriceFormatter) : EM_DASH;
        const c = rec !== null && "close" in rec ? formatOhlcValue(Number(rec.close), currentPriceFormatter) : EM_DASH;
        const volRaw = rec !== null && "volume" in rec ? rec.volume : undefined;
        const vol = volRaw !== undefined ? formatOhlcValue(volRaw, currentPriceFormatter) : "";
        parts.push(o, h, l, c, vol);
      } else if (meta.kind === "point") {
        const v = rec !== null && "value" in rec ? formatOhlcValue(Number(rec.value), currentPriceFormatter) : EM_DASH;
        parts.push(v);
      } else {
        parts.push(rec !== null ? "present" : EM_DASH);
      }
    }
    return parts.join("");
  };

  const buildSeriesReadoutNodes = (
    payload: CartaEventMap["crosshair:move"] | null,
  ): readonly HTMLElement[] => {
    if (seriesMeta.size === 0) { return []; }
    const out: HTMLElement[] = [];
    for (const [key, meta] of seriesMeta) {
      const rec = payload?.seriesData.get(key) ?? null;
      const article = document.createElement("article");
      article.className = "series-row";
      article.dataset.kind = meta.kind;
      article.dataset.name = meta.name;

      const header = document.createElement("header");
      const nameEl = document.createElement("span");
      nameEl.className = "series-name";
      nameEl.textContent = meta.name;
      const kindEl = document.createElement("span");
      kindEl.className = "series-kind";
      kindEl.textContent = meta.kind;
      header.append(nameEl, kindEl);

      const values = document.createElement("div");
      values.className = "series-values";

      if (meta.kind === "marker") {
        appendKV(values, "marker", rec !== null ? "present" : EM_DASH);
      } else if (meta.kind === "ohlc") {
        const o = rec !== null && "open" in rec ? formatOhlcValue(Number(rec.open), currentPriceFormatter) : EM_DASH;
        const h = rec !== null && "high" in rec ? formatOhlcValue(Number(rec.high), currentPriceFormatter) : EM_DASH;
        const l = rec !== null && "low" in rec ? formatOhlcValue(Number(rec.low), currentPriceFormatter) : EM_DASH;
        const c = rec !== null && "close" in rec ? formatOhlcValue(Number(rec.close), currentPriceFormatter) : EM_DASH;
        appendKV(values, "O", o);
        appendKV(values, "H", h);
        appendKV(values, "L", l);
        appendKV(values, "C", c);
        const volRaw = rec !== null && "volume" in rec ? rec.volume : undefined;
        if (volRaw !== undefined) {
          appendKV(values, "V", formatOhlcValue(volRaw, currentPriceFormatter));
        }
      } else {
        const v = rec !== null && "value" in rec
          ? formatOhlcValue(Number(rec.value), currentPriceFormatter)
          : EM_DASH;
        appendKV(values, "value", v);
      }

      article.append(header, values);
      out.push(article);
    }
    return out;
  };

  const updateCrosshairPanel = (): void => {
    if (cxPanel === null) {
      return;
    }
    const payload = lastCrosshairPayload;
    const active = payload !== null && payload.time !== null;
    const iv = chart === null ? NaN : Number(chart.getInterval());
    const timeStr = active && Number.isFinite(iv) && iv > 0
      ? formatAxisLabel(payload.time, iv, false)
      : EM_DASH;
    const priceStr = active && payload.price !== null
      ? (((): string => { try { return currentPriceFormatter(Number(payload.price)); } catch { return EM_DASH; } })())
      : EM_DASH;
    const pointStr = payload !== null
      ? `${Number(payload.point.x).toFixed(0)}, ${Number(payload.point.y).toFixed(0)}`
      : EM_DASH;
    const statusStr = payload === null ? "idle" : active ? "active" : "outside plot";
    const emitsStr = String(crosshairPayloadCount);

    if (cxCache.active !== active) {
      cxPanel.dataset.active = String(active);
      cxCache.active = active;
    }
    if (cxCache.status !== statusStr && cxStatus !== null) {
      cxStatus.textContent = statusStr;
      cxCache.status = statusStr;
    }
    if (cxCache.time !== timeStr && cxTime !== null) {
      cxTime.textContent = timeStr;
      cxCache.time = timeStr;
    }
    if (cxCache.price !== priceStr && cxPrice !== null) {
      cxPrice.textContent = priceStr;
      cxCache.price = priceStr;
    }
    if (cxCache.point !== pointStr && cxPoint !== null) {
      cxPoint.textContent = pointStr;
      cxCache.point = pointStr;
    }
    if (cxCache.emits !== emitsStr && cxEmits !== null) {
      cxEmits.textContent = emitsStr;
      cxCache.emits = emitsStr;
    }
    if (cxSeries !== null) {
      const fingerprint = seriesReadoutFingerprint(payload);
      if (fingerprint !== cxCache.seriesHtml) {
        const nodes = buildSeriesReadoutNodes(payload);
        cxSeries.replaceChildren(...nodes);
        cxCache.seriesHtml = fingerprint;
      }
    }
  };
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
    updateCrosshairPanel();
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
    const volume: Channel = { id: DEMO_VOLUME_CHANNEL, kind: "point" };
    chart.defineChannel(volume);
    const bars = sharedMockSource.fetchOhlc(ivNum, s, e);
    if (bars.length > 0) {
      chart.supplyData(DEMO_OHLC_CHANNEL, ivNum, bars);
    }
    const volumePoints = sharedMockSource.fetchVolume(ivNum, s, e);
    if (volumePoints.length > 0) {
      chart.supplyData(DEMO_VOLUME_CHANNEL, ivNum, volumePoints);
    }
    const sma = sharedMockSource.fetchSma(ivNum, s, e, SMA_PERIOD);
    if (sma.length > 0) {
      chart.supplyData(DEMO_SMA_CHANNEL, ivNum, sma);
    }
    const markers = sharedMockSource.fetchEvents(ivNum, s, e);
    if (markers.length > 0) {
      chart.supplyData(DEMO_MARKER_CHANNEL, ivNum, markers);
    }
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

  const primaryTypeSelect = document.getElementById(
    "primary-series-type",
  ) as HTMLSelectElement | null;
  if (primaryTypeSelect !== null) {
    primaryTypeSelect.value = primaryType;
    primaryTypeSelect.addEventListener("change", () => {
      const raw = primaryTypeSelect.value;
      if (raw === "candle" || raw === "ohlc-bar" || raw === "heikin-ashi") {
        setPrimaryType(raw);
      }
    });
  }

  const markerBtn = document.getElementById("toggle-markers");
  const updateMarkerBtn = (): void => {
    if (markerBtn === null) {
      return;
    }
    const on = markerOverlay !== null;
    markerBtn.textContent = `Markers: ${on ? "ON" : "OFF"}`;
    markerBtn.setAttribute("aria-pressed", String(on));
  };
  markerBtn?.addEventListener("click", () => {
    if (markerOverlay === null) {
      addMarkerOverlay();
    } else {
      removeMarkerOverlay();
    }
    updateMarkerBtn();
  });
  updateMarkerBtn();

  // Phase 10 — theme toggle. Persists across remounts so a user who flipped
  // to Light gets a Light chart back after `Remount chart`.
  let currentThemeName: "dark" | "light" = "dark";
  const themeBtn = document.getElementById("toggle-theme");
  const applyThemeToHost = (name: "dark" | "light"): void => {
    document.body.setAttribute("data-theme", name);
    if (themeBtn !== null) {
      themeBtn.textContent = `Theme: ${name === "dark" ? "Dark" : "Light"}`;
      themeBtn.setAttribute("aria-pressed", String(name === "light"));
    }
  };
  const applyTheme = (name: "dark" | "light"): void => {
    currentThemeName = name;
    chart?.applyOptions({ theme: name === "light" ? LightTheme : DarkTheme });
    applyThemeToHost(name);
  };
  themeBtn?.addEventListener("click", () => {
    applyTheme(currentThemeName === "dark" ? "light" : "dark");
  });
  applyThemeToHost(currentThemeName);

  const lineStyleSelect = document.getElementById("line-style") as HTMLSelectElement | null;
  const parseLineStyleValue = (raw: string): { style: LineStyle; type: LineType } | null => {
    const [s, t] = raw.split("-");
    if (s !== "solid" && s !== "dashed" && s !== "dotted") {
      return null;
    }
    if (t !== "simple" && t !== "stepped") {
      return null;
    }
    return { style: s, type: t };
  };
  lineStyleSelect?.addEventListener("change", () => {
    const parsed = parseLineStyleValue(lineStyleSelect.value);
    if (parsed !== null) {
      setLineStyle(parsed.style, parsed.type);
    }
  });

  // ── Phase 11 cycle A — request log, interval selector, overlay shape, live tick ──
  const requestLogTbody = document.getElementById("request-log-tbody");
  const requestLogFooter = document.getElementById("request-log-footer");
  const requestLog = new RequestLog({
    capacity: 50,
    tbody: requestLogTbody,
    footer: requestLogFooter,
  });
  requestLog.render();

  const logRequest = (req: DataRequest): void => {
    const iv = Number(req.intervalDuration);
    const start = Number(req.startTime);
    const end = Number(req.endTime);
    if (!Number.isFinite(iv) || iv <= 0) {
      return;
    }
    requestLog.push({
      channelId: req.channelId,
      kind: req.kind,
      interval: iv,
      start,
      end,
      source: "data:request",
    });
  };
  chart.on("data:request", logRequest);

  type OverlayShape = "line" | "area" | "baseline";
  let overlayShape: OverlayShape = "line";
  let overlayAlt: AreaSeries | BaselineSeries | null = null;

  const recordsCachedFor = (channelId: string, iv: number, start: number, end: number): boolean => {
    if (chart === null) {
      return false;
    }
    return chart.recordsInRange(channelId, iv, start, end).length > 0;
  };

  const setOverlayShape = (next: OverlayShape): void => {
    if (chart === null || next === overlayShape) {
      return;
    }
    const prev = overlayShape;
    overlayShape = next;
    const win = chart.getWindow();
    const iv = Number(chart.getInterval());
    const s = Number(win.startTime);
    const e = Number(win.endTime);
    const cacheHit = recordsCachedFor(DEMO_SMA_CHANNEL, iv, s, e);

    if (prev === "line" && sma !== null) {
      chart.removeSeries(sma);
      sma = null;
    } else if (overlayAlt !== null) {
      chart.removeSeries(overlayAlt);
      overlayAlt = null;
    }
    if (next === "line") {
      sma = chart.addSeries(
        new LineSeries({
          channel: DEMO_SMA_CHANNEL,
          lineStyle: currentLineStyle,
          lineType: currentLineType,
        }),
      );
    } else if (next === "area") {
      overlayAlt = chart.addSeries(new AreaSeries({ channel: DEMO_SMA_CHANNEL }));
    } else {
      overlayAlt = chart.addSeries(
        new BaselineSeries({ channel: DEMO_SMA_CHANNEL, baseline: 100 }),
      );
    }
    refreshSeriesMeta();
    if (cacheHit && Number.isFinite(iv) && iv > 0) {
      requestLog.push({
        channelId: DEMO_SMA_CHANNEL,
        kind: "point",
        interval: iv,
        start: s,
        end: e,
        source: "cache-hit-synthetic",
      });
    }
    const sel = document.getElementById("overlay-shape") as HTMLSelectElement | null;
    if (sel !== null && sel.value !== next) {
      sel.value = next;
    }
  };

  const overlayShapeSelect = document.getElementById("overlay-shape") as HTMLSelectElement | null;
  if (overlayShapeSelect !== null) {
    overlayShapeSelect.value = overlayShape;
    overlayShapeSelect.addEventListener("change", () => {
      const raw = overlayShapeSelect.value;
      if (raw === "line" || raw === "area" || raw === "baseline") {
        setOverlayShape(raw);
      }
    });
  }

  // ── Live-tick driver ─────────────────────────────────────────────────
  let liveTickDriver: LiveTickDriver | null = null;
  let liveTickWanted = false;

  const buildLiveTickDriver = (): LiveTickDriver | null => {
    if (chart === null) {
      return null;
    }
    return new LiveTickDriver({
      chart,
      source: sharedMockSource,
      ohlcChannel: DEMO_OHLC_CHANNEL,
      volumeChannel: DEMO_VOLUME_CHANNEL,
      intervalMs: 1000,
      // Phase 13 Cycle B.2 fix-up F-3 — refresh the P&L panel on every tick
      // so `lastClose` / `uPnL` track the freshest synthesized price.
      onTick: () => {
        document.dispatchEvent(new CustomEvent("carta:demo-tick"));
      },
    });
  };

  const liveTickBtn = document.getElementById("toggle-live-tick");
  const updateLiveTickBtn = (): void => {
    if (liveTickBtn === null) {
      return;
    }
    const on = liveTickWanted && liveTickDriver?.isRunning() === true;
    liveTickBtn.textContent = `Live tick: ${on ? "ON" : "OFF"}`;
    liveTickBtn.setAttribute("aria-pressed", String(on));
  };
  const startLiveTick = (): void => {
    liveTickWanted = true;
    liveTickDriver ??= buildLiveTickDriver();
    liveTickDriver?.start();
    updateLiveTickBtn();
  };
  const stopLiveTick = (): void => {
    liveTickWanted = false;
    liveTickDriver?.stop();
    updateLiveTickBtn();
  };
  liveTickBtn?.addEventListener("click", () => {
    if (liveTickWanted) {
      stopLiveTick();
    } else {
      startLiveTick();
    }
  });
  updateLiveTickBtn();

  // ── Interval selector ────────────────────────────────────────────────
  const intervalSelect = document.getElementById("interval-select") as HTMLSelectElement | null;
  if (intervalSelect !== null) {
    intervalSelect.value = String(initialWindow.intervalDuration);
    intervalSelect.addEventListener("change", () => {
      const next = Number(intervalSelect.value);
      if (!Number.isFinite(next) || next <= 0 || chart === null) {
        return;
      }
      const wasRunning = liveTickDriver?.isRunning() === true;
      if (wasRunning) {
        liveTickDriver?.stop();
      }
      chart.setInterval(next);
      if (wasRunning) {
        liveTickDriver?.start();
        updateLiveTickBtn();
      }
    });
  }

  // ── Phase 13 — drawings toolbar (16 tools + magnet + clear / save / load) ────
  const DRAWING_KINDS = [
    "trendline",
    "horizontalLine",
    "verticalLine",
    "rectangle",
    "fibRetracement",
    "ray",
    "extendedLine",
    "horizontalRay",
    "parallelChannel",
    // Phase 13 Cycle B.2
    "longPosition",
    "shortPosition",
    "text",
    "callout",
    "arrow",
    "dateRange",
    "priceRange",
    "priceDateRange",
  ] as const;
  type DrawingKindName = typeof DRAWING_KINDS[number];

  const updateDrawingToolButtons = (): void => {
    const isCreating = chart?.drawings.isCreating() ?? false;
    for (const k of DRAWING_KINDS) {
      const btn = document.getElementById(`draw-${k}`);
      if (btn !== null) {
        const pressed = isCreating;
        btn.setAttribute("aria-pressed", String(pressed));
      }
    }
  };

  for (const k of DRAWING_KINDS) {
    const btn = document.getElementById(`draw-${k}`);
    btn?.addEventListener("click", () => {
      if (chart === null) {
        return;
      }
      if (chart.drawings.isCreating()) {
        chart.drawings.cancelCreate();
      } else {
        chart.drawings.beginCreate(k);
      }
      updateDrawingToolButtons();
    });
  }
  document.getElementById("drawings-clear")?.addEventListener("click", () => {
    chart?.drawings.clear();
    updateDrawingToolButtons();
    // Phase 13 Cycle B.2 fix-up — P&L panel reset hooks are wired below
    // (after `trackedPositionId` is in scope); we dispatch a custom event
    // here that the panel listens for once it's wired.
    document.dispatchEvent(new CustomEvent("carta:demo-clear"));
  });

  // ── Phase 13 Cycle B1 — magnet toggle (Off → Weak → Strong → Off) ──
  const magnetButton = document.getElementById("drawings-magnet");
  const magnetCycle = ["off", "weak", "strong"] as const;
  type MagnetModeLocal = typeof magnetCycle[number];
  const updateMagnetButton = (mode: MagnetModeLocal): void => {
    if (magnetButton === null) {
      return;
    }
    const label = mode === "off" ? "Off" : mode === "weak" ? "Weak" : "Strong";
    magnetButton.textContent = `Magnet: ${label}`;
    magnetButton.setAttribute("aria-pressed", String(mode !== "off"));
  };
  updateMagnetButton("off");
  magnetButton?.addEventListener("click", () => {
    if (chart === null) {
      return;
    }
    const current = chart.getMagnet();
    const idx = magnetCycle.indexOf(current);
    const next = magnetCycle[(idx + 1) % magnetCycle.length] ?? "off";
    chart.setMagnet(next);
    updateMagnetButton(next);
  });

  const drawingsLocalStorageKey = "carta-demo-drawings";
  document.getElementById("drawings-save")?.addEventListener("click", () => {
    if (chart === null) {
      return;
    }
    const snap = chart.drawings.getSnapshot();
    try {
      globalThis.localStorage.setItem(drawingsLocalStorageKey, JSON.stringify(snap));
    } catch {
      // localStorage may be disabled (e.g. in private mode); silent.
    }
  });
  document.getElementById("drawings-load")?.addEventListener("click", () => {
    if (chart === null) {
      return;
    }
    let raw: string | null;
    try {
      raw = globalThis.localStorage.getItem(drawingsLocalStorageKey);
    } catch {
      return;
    }
    if (raw === null) {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      chart.drawings.loadSnapshot(parsed);
    } catch {
      // Ignore broken JSON; loadSnapshot itself never throws on bad shape.
    }
    updateDrawingToolButtons();
  });

  // ── Phase 13 Cycle B.2 — position-tool P&L sidebar ─────────────────
  const pnlEmpty = document.getElementById("position-pnl-empty");
  const pnlDetail = document.getElementById("position-pnl-detail");
  const pnlSide = document.getElementById("pnl-side");
  const pnlEntry = document.getElementById("pnl-entry");
  const pnlSl = document.getElementById("pnl-sl");
  const pnlTp = document.getElementById("pnl-tp");
  const pnlRr = document.getElementById("pnl-rr");
  const pnlQty = document.getElementById("pnl-qty");
  const pnlLast = document.getElementById("pnl-last");
  const pnlUpnl = document.getElementById("pnl-upnl");
  let trackedPositionId: string | null = null;

  const updatePnlPanel = (): void => {
    if (chart === null) {
      return;
    }
    const drawings = chart.drawings.list();
    let target: unknown = null;
    if (trackedPositionId !== null) {
      target = chart.drawings.getById(trackedPositionId);
    }
    if (target === null) {
      // Pick the most recently selected position; fallback = last in list.
      const selectedId = chart.drawings.getSelectedId();
      if (selectedId !== null) {
        const sel = chart.drawings.getById(selectedId);
        if (sel !== null && (sel.kind === "longPosition" || sel.kind === "shortPosition")) {
          target = sel;
          trackedPositionId = String(selectedId);
        }
      }
      if (target === null) {
        for (let i = drawings.length - 1; i >= 0; i--) {
          const d = drawings[i];
          if (d !== undefined && (d.kind === "longPosition" || d.kind === "shortPosition")) {
            target = d;
            trackedPositionId = String(d.id);
            break;
          }
        }
      }
    }
    if (
      target === null ||
      typeof target !== "object" ||
      !("kind" in target) ||
      ((target as { kind: string }).kind !== "longPosition" &&
        (target as { kind: string }).kind !== "shortPosition")
    ) {
      pnlEmpty?.removeAttribute("hidden");
      pnlDetail?.setAttribute("hidden", "");
      return;
    }
    const pos = target as {
      kind: "longPosition" | "shortPosition";
      anchors: readonly { time: number; price: number }[];
      qty: number;
    };
    const entry = Number(pos.anchors[0]?.price);
    const sl = Number(pos.anchors[1]?.price);
    const tp = Number(pos.anchors[2]?.price);
    const isLong = pos.kind === "longPosition";
    const reward = isLong ? tp - entry : entry - tp;
    const risk = isLong ? entry - sl : sl - entry;
    const rr = risk === 0 ? "∞" : (reward / risk).toFixed(2);
    // Last close from the chart's data store — covers both the synthesized
    // bars *and* live ticks that `LiveTickDriver.supplyTick(...)` has merged
    // in (those ticks land at `Date.now()`, well past `winEnd`). The query
    // range spans the entire cached span by reading a generous window.
    const ivlNum = Number(chart.getInterval());
    const winInfo = chart.getWindow();
    const winEnd = Number(winInfo.endTime);
    const lookEnd = Math.max(winEnd, Date.now()) + ivlNum;
    const lookStart = winEnd - ivlNum * 50;
    const cachedBars = chart.recordsInRange(DEMO_OHLC_CHANNEL, ivlNum, lookStart, lookEnd);
    const lastCachedBar =
      cachedBars.length > 0 ? cachedBars[cachedBars.length - 1] : undefined;
    const lastClose =
      lastCachedBar !== undefined && "close" in lastCachedBar
        ? Number(lastCachedBar.close)
        : entry;
    const upnl = isLong ? (lastClose - entry) * pos.qty : (entry - lastClose) * pos.qty;
    pnlEmpty?.setAttribute("hidden", "");
    pnlDetail?.removeAttribute("hidden");
    if (pnlSide !== null) {
      pnlSide.textContent = isLong ? "long" : "short";
    }
    if (pnlEntry !== null) {
      pnlEntry.textContent = entry.toFixed(2);
    }
    if (pnlSl !== null) {
      pnlSl.textContent = sl.toFixed(2);
    }
    if (pnlTp !== null) {
      pnlTp.textContent = tp.toFixed(2);
    }
    if (pnlRr !== null) {
      pnlRr.textContent = rr;
    }
    if (pnlQty !== null) {
      pnlQty.textContent = pos.qty.toFixed(2);
    }
    if (pnlLast !== null) {
      pnlLast.textContent = lastClose.toFixed(2);
    }
    if (pnlUpnl !== null) {
      pnlUpnl.textContent = `${upnl >= 0 ? "+" : "-"}${Math.abs(upnl).toFixed(2)}`;
    }
  };

  // Initial paint + on every drawings event.
  updatePnlPanel();
  chart.on("drawings:created", () => {
    updatePnlPanel();
  });
  chart.on("drawings:updated", () => {
    updatePnlPanel();
  });
  // Cycle B.2 fix-up F-1 — bulk-clear suppresses `drawings:removed`, so the
  // demo's clear button dispatches a CustomEvent that we listen for here to
  // blank the panel.
  document.addEventListener("carta:demo-clear", () => {
    trackedPositionId = null;
    updatePnlPanel();
  });
  // Cycle B.2 fix-up F-3 — repaint the panel on every live tick so
  // `lastClose` / `uPnL` track the freshest synthesized price.
  document.addEventListener("carta:demo-tick", () => {
    updatePnlPanel();
  });
  chart.on("drawings:removed", (payload) => {
    if (trackedPositionId !== null && String(payload.id) === trackedPositionId) {
      trackedPositionId = null;
    }
    updatePnlPanel();
  });
  chart.on("drawings:selected", (payload) => {
    if (
      payload.drawing !== null &&
      (payload.drawing.kind === "longPosition" || payload.drawing.kind === "shortPosition")
    ) {
      trackedPositionId = String(payload.drawing.id);
    }
    updatePnlPanel();
  });

  // Test hooks (dev only) — used by Playwright for adversarial scenarios.
  const testHook = {
    TimeSeriesChart,
    MockSource,
    canvasCount: (): number => document.querySelectorAll("canvas").length,
    getChart: (): TimeSeriesChart | null => chart,
    // ── Phase 13 — drawings test hooks ──
    drawingsList: (): readonly unknown[] => chart?.drawings.list() ?? [],
    drawingsBeginCreate: (kind: string): void => {
      const valid = DRAWING_KINDS.includes(kind as DrawingKindName);
      if (chart !== null && valid) {
        chart.drawings.beginCreate(kind as DrawingKindName);
      }
    },
    drawingsCancelCreate: (): void => { chart?.drawings.cancelCreate(); },
    drawingsClear: (): void => { chart?.drawings.clear(); },
    drawingsCount: (): number => chart?.drawings.list().length ?? 0,
    drawingsSelectedId: (): string | null => {
      const id = chart?.drawings.getSelectedId() ?? null;
      return id === null ? null : String(id);
    },
    drawingsGetSnapshot: (): unknown => chart?.drawings.getSnapshot() ?? null,
    drawingsLoadSnapshot: (snap: unknown): { droppedCount: number; droppedKinds: readonly string[] } | null =>
      chart?.drawings.loadSnapshot(snap) ?? null,
    // ── Phase 13 Cycle B1 — magnet + hotkeys hooks ──
    setMagnet: (mode: string): void => {
      const allowed = mode === "off" || mode === "weak" || mode === "strong";
      if (chart !== null && allowed) {
        chart.setMagnet(mode);
        updateMagnetButton(mode);
      }
    },
    getMagnet: (): MagnetMode | null => chart?.getMagnet() ?? null,
    lastHotkeyPayload: (): unknown => lastHotkeyPayload,
    hotkeyPayloadCount: (): number => hotkeyPayloadCount,
    canvasTabIndex: (): number => document.querySelector("canvas")?.tabIndex ?? -2,
    canvasOutline: (): string => {
      const c = document.querySelector("canvas");
      if (c instanceof HTMLCanvasElement) {
        return c.style.outline;
      }
      return "";
    },
    // ── Phase 11 cycle A — request log / overlay / live tick / interval ──
    requestLogEntries: (): readonly RequestLogEntry[] => requestLog.snapshot(),
    requestLogTotal: (): number => requestLog.totalPushed(),
    clearRequestLog: (): void => { requestLog.clear(); },
    setOverlayShape: (shape: "line" | "area" | "baseline"): void => { setOverlayShape(shape); },
    getOverlayShape: (): OverlayShape => overlayShape,
    startLiveTick: (): void => { startLiveTick(); },
    stopLiveTick: (): void => { stopLiveTick(); },
    isLiveTickRunning: (): boolean => liveTickDriver?.isRunning() === true,
    liveTickCount: (): number => liveTickDriver?.tickCounter() ?? 0,
    fireLiveTickOnce: (): void => { liveTickDriver?.fireOnceForTest(); },
    selectInterval: (intervalDuration: number): void => {
      if (chart === null) {
        return;
      }
      const wasRunning = liveTickDriver?.isRunning() === true;
      if (wasRunning) {
        liveTickDriver?.stop();
      }
      chart.setInterval(intervalDuration);
      const sel = document.getElementById("interval-select") as HTMLSelectElement | null;
      if (sel !== null) {
        sel.value = String(intervalDuration);
      }
      if (wasRunning) {
        liveTickDriver?.start();
        updateLiveTickBtn();
      }
    },
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
    candlePoolActive: (): number => primary?.activePoolSize() ?? 0,
    candlePoolTotal: (): number => primary?.totalPoolSize() ?? 0,
    primaryPoolActive: (): number => primary?.activePoolSize() ?? 0,
    primaryPoolTotal: (): number => primary?.totalPoolSize() ?? 0,
    getPrimary: (): PrimarySeries | null => primary,
    getPrimaryType: (): PrimarySeriesType => primaryType,
    setPrimaryType: (next: PrimarySeriesType): void => { setPrimaryType(next); },
    getCandles: (): CandlestickSeries | null =>
      primary instanceof CandlestickSeries ? primary : null,
    getOhlcBars: (): OhlcBarSeries | null =>
      primary instanceof OhlcBarSeries ? primary : null,
    getHeikinAshi: (): HeikinAshiSeries | null =>
      primary instanceof HeikinAshiSeries ? primary : null,
    heikinAshiCacheSize: (): number =>
      primary instanceof HeikinAshiSeries ? primary.cacheSize() : 0,
    setOhlcBarThinBars: (thin: boolean, tickWidth = 1): boolean => {
      if (chart === null) {
        return false;
      }
      if (primary !== null) {
        chart.removeSeries(primary);
      }
      primaryType = "ohlc-bar";
      primary = chart.addSeries(
        new OhlcBarSeries({
          channel: DEMO_OHLC_CHANNEL,
          thinBars: thin,
          tickWidth,
        }),
      );
      const sel = document.getElementById("primary-series-type") as HTMLSelectElement | null;
      if (sel !== null) {
        sel.value = "ohlc-bar";
      }
      return true;
    },
    getSma: (): LineSeries | null => sma,
    setSmaStyle: (style: LineStyle, type: LineType = "simple"): void => {
      setLineStyle(style, type);
      if (lineStyleSelect !== null) {
        lineStyleSelect.value = `${style}-${type}`;
      }
    },
    addMarkerOverlay: (): boolean => {
      const ok = addMarkerOverlay();
      updateMarkerBtn();
      return ok;
    },
    removeMarkerOverlay: (): boolean => {
      const ok = removeMarkerOverlay();
      updateMarkerBtn();
      return ok;
    },
    getMarkerOverlay: (): MarkerOverlay | null => markerOverlay,
    markerPoolActive: (): number => markerOverlay?.activePoolSize() ?? 0,
    markerPoolTotal: (): number => markerOverlay?.totalPoolSize() ?? 0,
    markerSkipCount: (): number => markerOverlay?.lastSkippedCount() ?? 0,
    markerCount: (): number => {
      const iv = chart === null ? Number.NaN : Number(chart.getInterval());
      if (!Number.isFinite(iv) || iv <= 0 || chart === null) {
        return 0;
      }
      return chart.recordsInRange(
        DEMO_MARKER_CHANNEL,
        iv,
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      ).length;
    },
    setMarkers: (records: readonly MarkerRecord[]): void => {
      if (chart === null) {
        return;
      }
      const iv = Number(chart.getInterval());
      if (!Number.isFinite(iv) || iv <= 0) {
        return;
      }
      chart.clearCache({ channelId: DEMO_MARKER_CHANNEL });
      chart.supplyData(DEMO_MARKER_CHANNEL, iv, records);
    },
    computePivotMarkers,
    getVolume: (): HistogramSeries | null => volume,
    volumePoolActive: (): number => volume?.activePoolSize() ?? 0,
    volumePoolTotal: (): number => volume?.totalPoolSize() ?? 0,
    addAreaSeries: (channel = DEMO_SMA_CHANNEL): boolean => {
      if (chart === null || areaExtra !== null) {
        return false;
      }
      areaExtra = chart.addSeries(new AreaSeries({ channel }));
      refreshSeriesMeta();
      return true;
    },
    removeAreaSeries: (): boolean => {
      if (chart === null || areaExtra === null) {
        return false;
      }
      const removed = chart.removeSeries(areaExtra);
      if (removed) {
        areaExtra = null;
        refreshSeriesMeta();
      }
      return removed;
    },
    addBaselineSeries: (baseline: BaselineMode = 100, channel = DEMO_SMA_CHANNEL): boolean => {
      if (chart === null || baselineExtra !== null) {
        return false;
      }
      baselineExtra = chart.addSeries(new BaselineSeries({ channel, baseline }));
      refreshSeriesMeta();
      return true;
    },
    removeBaselineSeries: (): boolean => {
      if (chart === null || baselineExtra === null) {
        return false;
      }
      const removed = chart.removeSeries(baselineExtra);
      if (removed) {
        baselineExtra = null;
        refreshSeriesMeta();
      }
      return removed;
    },
    removeCandles: (): boolean => {
      if (chart === null || primary === null) {
        return false;
      }
      const removed = chart.removeSeries(primary);
      if (removed) {
        primary = null;
        refreshSeriesMeta();
      }
      return removed;
    },
    addCandlesWithKind: (kind: "ohlc" | "point"): string => {
      if (chart === null) {
        return "no-chart";
      }
      try {
        if (kind === "ohlc") {
          chart.addSeries(new CandlestickSeries({ channel: "kind-clash" }));
        } else {
          chart.addSeries(new LineSeries({ channel: "kind-clash" }));
        }
        return "ok";
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
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
      currentPriceFormatter = formatter;
      chart?.applyOptions({ priceFormatter: formatter });
    },
    resetPriceFormatter: (): void => {
      currentPriceFormatter = defaultPriceFormatter;
      chart?.applyOptions({ priceFormatter: defaultPriceFormatter });
    },
    // Phase 10 — theme controls for Playwright harness.
    setTheme: (name: "dark" | "light"): void => { applyTheme(name); },
    setThemeFontFamily: (fontFamily: string): void => {
      const base = currentThemeName === "light" ? LightTheme : DarkTheme;
      chart?.applyOptions({ theme: { ...base, fontFamily } });
    },
    getCurrentThemeName: (): "dark" | "light" => currentThemeName,
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
    ): readonly OhlcRecord[] => {
      void basePrice;
      return sharedMockSource.fetchOhlc(intervalDuration, startTime, endTime);
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
    // ── Phase 08 crosshair hooks ─────────────────────────────────────────
    crosshairStats: (): {
      seriesRenderCount: number;
      emitCount: number;
      bgRedrawCount: number;
      isVisible: boolean;
    } | null => {
      if (chart === null) {
        return null;
      }
      const s = chart.__debugStats();
      return {
        seriesRenderCount: s.seriesRenderCount,
        emitCount: s.crosshair.emitCount,
        bgRedrawCount: s.crosshair.bgRedrawCount,
        isVisible: s.crosshair.isVisible,
      };
    },
    lastCrosshairPayload: (): Readonly<CartaEventMap["crosshair:move"]> | null =>
      lastCrosshairPayload,
    crosshairPayloadCount: (): number => crosshairPayloadCount,
    synthMouseMove: (x: number, y: number): void => {
      const canvas = document.querySelector("canvas");
      if (canvas === null) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: rect.left + x,
          clientY: rect.top + y,
          pointerId: 1,
          pointerType: "mouse",
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    synthMouseLeave: (): void => {
      const canvas = document.querySelector("canvas");
      if (canvas === null) {
        return;
      }
      canvas.dispatchEvent(
        new PointerEvent("pointerleave", {
          pointerId: 1,
          pointerType: "mouse",
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    // ── Phase 09 mobile / touch hooks ────────────────────────────────────
    /**
     * Dispatch a multi-pointer event sequence on the canvas. Each phase emits
     * one PointerEvent per supplied pointer, in the listed order. Use to
     * synthesize pinch / two-finger pan / long-press in Playwright. Pointer
     * IDs are assumed unique per frame.
     */
    synthMultiPointer: (opts: {
      readonly phase: "down" | "move" | "up" | "cancel";
      readonly pointers: readonly { id: number; x: number; y: number; type?: "mouse" | "pen" | "touch" }[];
    }): void => {
      const canvas = document.querySelector("canvas");
      if (canvas === null) {
        return;
      }
      const eventName =
        opts.phase === "down"
          ? "pointerdown"
          : opts.phase === "move"
          ? "pointermove"
          : opts.phase === "up"
          ? "pointerup"
          : "pointercancel";
      const rect = canvas.getBoundingClientRect();
      for (const p of opts.pointers) {
        canvas.dispatchEvent(
          new PointerEvent(eventName, {
            pointerId: p.id,
            pointerType: p.type ?? "touch",
            clientX: rect.left + p.x,
            clientY: rect.top + p.y,
            bubbles: true,
            cancelable: true,
            isPrimary: p.id === opts.pointers[0]?.id,
          }),
        );
      }
    },
    /**
     * Dispatch a pointerdown for outside-tap-exit testing. By default fires on
     * `document`. Pass `target: "canvas"` to dispatch on the chart canvas (so
     * the document-level listener sees `e.target === canvas` and stays in
     * tracking mode). Pass `target: "body"` to dispatch on the body element.
     */
    synthDocumentPointerDown: (
      clientX = 0,
      clientY = 0,
      target: "document" | "canvas" | "body" = "document",
    ): void => {
      const evt = new PointerEvent("pointerdown", {
        clientX,
        clientY,
        pointerId: 999,
        pointerType: "touch",
        bubbles: true,
        cancelable: true,
      });
      const dispatcher: EventTarget =
        target === "canvas"
          ? (document.querySelector("canvas") ?? document)
          : target === "body"
          ? document.body
          : document;
      dispatcher.dispatchEvent(evt);
    },
    /** Whether the chart is currently in tracking mode (long-press crosshair). */
    isTrackingActive: (): boolean => chart?.__debugStats().tracking.active ?? false,
    /** Whether the viewport is in tracking-mode routing (no pan on touch). */
    isViewportTracking: (): boolean =>
      chart?.__debugStats().tracking.viewportTracking ?? false,
    // ── Phase 09 cycle B public-API hooks ───────────────────────────────
    /** Public API: enter tracking programmatically. Returns true if accepted. */
    enterTrackingMode: (opts?: { time?: number; price?: number }): boolean => {
      if (chart === null) {
        return false;
      }
      const before = chart.isTrackingMode();
      const apiOpts: { time?: Time; price?: ReturnType<typeof asPrice> } = {};
      if (opts?.time !== undefined) {
        apiOpts.time = asTime(opts.time);
      }
      if (opts?.price !== undefined) {
        apiOpts.price = asPrice(opts.price);
      }
      chart.enterTrackingMode(apiOpts);
      return chart.isTrackingMode() && !before;
    },
    /** Public API: exit tracking programmatically. Returns true if a transition happened. */
    exitTrackingMode: (): boolean => {
      if (chart === null) {
        return false;
      }
      const before = chart.isTrackingMode();
      chart.exitTrackingMode();
      return before && !chart.isTrackingMode();
    },
    /** Public API: read current tracking state (no side-effects). */
    isTrackingMode: (): boolean => chart?.isTrackingMode() ?? false,
    /** Number of `tracking:change` events observed since last reset. */
    trackingChangeCount: (): number => eventCounts.tracking,
    /** Last `tracking:change` payload, or null if no event has fired. */
    lastTrackingChange: (): { active: boolean } | null =>
      lastTrackingChange === null ? null : { active: lastTrackingChange.active },
    /** Full transition log since last reset, in emission order. */
    trackingChangeLog: (): readonly { active: boolean; at: number }[] =>
      trackingChangeLog.map((e) => ({ active: e.active, at: e.at })),
    /** Current renderer DPR + whether the matchMedia listener is armed. */
    dprStats: (): { resolution: number; listenerArmed: boolean } | null => {
      if (chart === null) {
        return null;
      }
      const stats = chart.__debugStats();
      return { resolution: stats.dpr.resolution, listenerArmed: stats.dpr.listenerArmed };
    },
    /**
     * Drive a deterministic DPR change. Only available when the demo was
     * loaded with `?dprStub=1` (the stub is wired through `dprListenerHooks`
     * at mount time). Returns the new resolution after the listener settles.
     */
    simulateDprChange: (nextDpr: number): { resolution: number; listenerArmed: boolean } | null => {
      if (activeDprStub === null) {
        return null;
      }
      activeDprStub.setDpr(nextDpr);
      activeDprStub.fire();
      if (chart === null) {
        return null;
      }
      const stats = chart.__debugStats();
      return { resolution: stats.dpr.resolution, listenerArmed: stats.dpr.listenerArmed };
    },
    /** Listener-balance stats from the DPR stub (only meaningful with `?dprStub=1`). */
    dprStubStats: (): { addCount: number; removeCount: number; activeListeners: number } | null =>
      activeDprStub === null ? null : activeDprStub.stats(),
    /** Read CSS that 9.5 should apply on the canvas + container. */
    cssBundle: (): {
      canvas: { touchAction: string; userSelect: string; webkitUserSelect: string; webkitTapHighlightColor: string };
      container: { overscrollBehavior: string };
    } | null => {
      const canvas = document.querySelector("canvas");
      const container = document.getElementById("chart");
      if (canvas === null || container === null) {
        return null;
      }
      return {
        canvas: {
          touchAction: canvas.style.touchAction,
          userSelect: canvas.style.userSelect,
          webkitUserSelect: canvas.style.getPropertyValue("-webkit-user-select"),
          webkitTapHighlightColor: canvas.style.getPropertyValue("-webkit-tap-highlight-color"),
        },
        container: {
          overscrollBehavior: container.style.overscrollBehavior,
        },
      };
    },
  };
  (globalThis as unknown as { __cartaTest?: typeof testHook }).__cartaTest = testHook;
}

void main();
