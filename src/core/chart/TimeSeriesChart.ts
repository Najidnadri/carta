import type { GraphicsContext } from "pixi.js";
import { ConfigState } from "./ConfigState.js";
import { CrosshairController } from "../interaction/CrosshairController.js";
import { DataStore } from "../data/DataStore.js";
import { DrawingsController, type DrawingsFacade } from "../drawings/DrawingsController.js";
import { DarkTheme } from "../infra/themes.js";
import { DebouncedEmitter } from "../infra/DebouncedEmitter.js";
import { EventBus } from "../infra/EventBus.js";
import { InvalidationQueue, type DirtyReason } from "../infra/InvalidationQueue.js";
import { noopLogger } from "../infra/Logger.js";
import {
  defaultPriceFormatter,
  PRICE_AXIS_STRIP_WIDTH,
  PriceAxis,
} from "../price/PriceAxis.js";
import type { PriceTickInfo } from "../price/PriceAxis.js";
import {
  PriceAxisController,
  type PriceAxisDragOptions,
} from "../price/PriceAxisController.js";
import {
  reducePriceRanges,
  type PriceRange,
  type PriceRangeProvider,
} from "../price/PriceRangeProvider.js";
import { PriceScale } from "../price/PriceScale.js";
import { Renderer, type PlotRect } from "../render/Renderer.js";
import type { Series, SeriesRenderContext } from "../series/Series.js";
import { TimeAxis, type TimeAxisOptions } from "../time/TimeAxis.js";
import type { TickInfo } from "../time/TimeAxis.js";
import { TimeScale } from "../time/TimeScale.js";
import { ViewportController } from "../viewport/ViewportController.js";
import {
  asInterval,
  asPixel,
  asPrice,
  asTime,
  type ApplyOptions,
  type CacheStats,
  type CartaEventHandler,
  type CartaEventMap,
  type Channel,
  type ChartWindow,
  type ClearCacheOptions,
  type DataOptions,
  type DataRecord,
  type DataRequest,
  type EventKey,
  type Interval,
  type IntervalChange,
  type Logger,
  type MagnetMode,
  type MissingRangesQuery,
  type OhlcRecord,
  type Price,
  type PriceAxisOptions,
  type PriceDomain,
  type PriceFormatter,
  type PriceScaleFacade,
  type PriceScaleMargins,
  type PriceScaleOptions,
  type Range,
  type SizeInfo,
  type Theme,
  type Time,
  type TimeSeriesChartOptions,
  type TrackingChange,
  type TrackingModeOptions,
  type ViewportOptions,
  type WindowInput,
} from "../../types.js";

const BOTTOM_MARGIN = 28;
const DATA_REQUEST_DEBOUNCE_MS = 150;

interface ResolvedOptions {
  readonly container: HTMLElement;
  readonly width: number;
  readonly height: number;
  readonly autoResize: boolean;
  readonly devicePixelRatio: number;
  readonly theme: Theme;
  readonly logger: Logger;
  readonly timeAxis: TimeAxisOptions | undefined;
  readonly viewport: ViewportOptions | undefined;
  readonly priceScale: PriceScaleOptions | undefined;
  readonly priceAxis: PriceAxisOptions | undefined;
  readonly priceAxisDrag: PriceAxisDragOptions | undefined;
  readonly priceFormatter: PriceFormatter;
  readonly data: DataOptions | undefined;
  readonly dprListenerHooks: DprListenerHooks | undefined;
}

/**
 * Phase 09 cycle B — injectable hooks for the DPR change listener so unit
 * tests can drive `matchMedia` deterministically without touching jsdom's
 * shimmed environment.
 */
export interface DprListenerHooks {
  readonly matchMedia: (query: string) => MediaQueryList;
  readonly devicePixelRatio: () => number;
}

export interface TimeSeriesChartConstructionOptions extends TimeSeriesChartOptions {
  readonly timeAxis?: TimeAxisOptions;
  readonly priceAxisDrag?: PriceAxisDragOptions;
  /**
   * Phase 09 cycle B test hook. When provided, the chart uses these
   * factories instead of `globalThis.window.matchMedia` /
   * `globalThis.window.devicePixelRatio`. Production code never sets this.
   */
  readonly dprListenerHooks?: DprListenerHooks;
}

const DEFAULT_DOMAIN_MIN = 0;
const DEFAULT_DOMAIN_MAX = 1;
const DPR_CAP = 2;

/**
 * Phase 09 cycle B — clamp + snap DPR to defend against the v8 fractional-
 * resolution artifacts ([PixiJS issue #6510](https://github.com/pixijs/pixijs/issues/6510)).
 * Output is one of `{1, 1.5, 2}`. Non-finite or non-positive inputs collapse
 * to `1`.
 */
export function resolveDpr(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) {
    return 1;
  }
  const clamped = Math.min(DPR_CAP, Math.max(1, raw));
  return Math.round(clamped * 2) / 2;
}

/**
 * Top-level chart class. Phase 02 surface: create / resize / destroy /
 * barsInWindow. Invalid `startTime` / `endTime` / `intervalDuration` are
 * accepted (the chart degrades gracefully) but `logger.warn` is emitted so
 * hosts can notice bad input during development.
 */
export class TimeSeriesChart {
  private readonly opts: ResolvedOptions;
  private readonly renderer: Renderer;
  private readonly invalidator: InvalidationQueue;
  private readonly sharedContexts: GraphicsContext[] = [];
  private readonly timeAxis: TimeAxis;
  private readonly priceAxis: PriceAxis;
  private readonly viewport: ViewportController;
  private readonly priceAxisController: PriceAxisController;
  private readonly crosshair: CrosshairController;
  private readonly drawingsController: DrawingsController;
  private readonly drawingsFacade: DrawingsFacade;
  private readonly dataStore: DataStore;
  private readonly emitter: EventBus<CartaEventMap>;
  private readonly dataRequestDebouncer: DebouncedEmitter<void>;
  private lastEmittedWindow: ChartWindow | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private config: ConfigState;
  private disposed = false;

  private priceDomain: PriceDomain;
  private autoScaleEnabled = false;
  private lastRenderedDomain: PriceDomain;
  private readonly priceRangeProviders = new Set<PriceRangeProvider>();
  private readonly series: Series[] = [];
  private priceFormatter: PriceFormatter;
  private readonly priceScaleFacade: PriceScaleFacade;
  private seriesRenderCounter = 0;
  private trackingActive = false;
  private trackingAnchor: { time: Time; price: Price } | null = null;
  private documentPointerDownHandler: ((e: PointerEvent) => void) | null = null;
  private currentResolution: number;
  private dprMediaQuery: MediaQueryList | null = null;
  private dprMediaListener: ((e: MediaQueryListEvent) => void) | null = null;
  private readonly mediaMatcher: ((query: string) => MediaQueryList) | null;
  private readonly dprProbe: () => number;

  private constructor(opts: ResolvedOptions, renderer: Renderer, config: ConfigState) {
    this.opts = opts;
    this.renderer = renderer;
    this.config = config;
    this.currentResolution = opts.devicePixelRatio;
    if (opts.dprListenerHooks !== undefined) {
      this.mediaMatcher = opts.dprListenerHooks.matchMedia;
      this.dprProbe = opts.dprListenerHooks.devicePixelRatio;
    } else if (typeof globalThis.window !== "undefined" && typeof globalThis.window.matchMedia === "function") {
      const win = globalThis.window;
      this.mediaMatcher = (q: string): MediaQueryList => win.matchMedia(q);
      this.dprProbe = (): number => win.devicePixelRatio || 1;
    } else {
      this.mediaMatcher = null;
      this.dprProbe = (): number => 1;
    }
    this.dataStore =
      opts.data === undefined
        ? new DataStore({ logger: opts.logger })
        : new DataStore({ logger: opts.logger, options: opts.data });
    this.emitter = new EventBus<CartaEventMap>({ logger: opts.logger });
    this.dataRequestDebouncer = new DebouncedEmitter<void>(
      DATA_REQUEST_DEBOUNCE_MS,
      () => { this.emitDataRequests(); },
    );
    this.invalidator = new InvalidationQueue((reasons) => { this.flush(reasons); });
    this.timeAxis = new TimeAxis(renderer.gridLayer, renderer.axesLayer, opts.timeAxis);
    this.priceAxis = new PriceAxis(renderer.gridLayer, renderer.axesLayer, opts.priceAxis);
    const initialDomain: PriceDomain = Object.freeze({
      min: asPrice(DEFAULT_DOMAIN_MIN),
      max: asPrice(DEFAULT_DOMAIN_MAX),
    });
    this.priceDomain = initialDomain;
    this.lastRenderedDomain = initialDomain;
    this.priceFormatter = opts.priceFormatter;
    this.priceScaleFacade = {
      setDomain: (min, max): void => { this.setPriceDomain(min, max); },
      getDomain: (): PriceDomain => this.lastRenderedDomain,
      isAutoScale: (): boolean => this.autoScaleEnabled,
      setAutoScale: (on: boolean): void => { this.setAutoScaleInternal(on); },
    };
    this.drawingsController = new DrawingsController({
      stage: renderer.app.stage,
      canvas: renderer.app.canvas,
      renderer,
      eventBus: this.emitter,
      logger: opts.logger,
      invalidate: (): void => { this.invalidator.invalidate("drawings"); },
      plotRect: (): PlotRect => this.computePlotRect(),
      currentTimeScale: () => this.currentTimeScaleForRect(this.computePlotRect()),
      currentPriceScale: () => this.currentPriceScaleForRect(this.computePlotRect()),
      currentTheme: () => this.config.snapshot.theme,
      currentDpr: () => this.currentResolution,
      currentMagnetMode: (): MagnetMode => this.config.snapshot.magnet,
      getOhlcAtTime: (time: number): OhlcRecord | null => this.lookupPrimaryOhlcBar(time),
      priceFormatter: (): PriceFormatter => this.priceFormatter,
    });
    this.drawingsFacade = this.drawingsController.asFacade();
    this.viewport = new ViewportController({
      stage: renderer.app.stage,
      canvas: renderer.app.canvas,
      snapshot: (): {
        startTime: Time;
        endTime: Time;
        intervalDuration: Interval;
      } => {
        const s = this.config.snapshot;
        return {
          startTime: s.startTime,
          endTime: s.endTime,
          intervalDuration: s.intervalDuration,
        };
      },
      applyWindow: (win: WindowInput): void => { this.applyWindowInternal(win); },
      plotRect: (): PlotRect => this.computePlotRect(),
      options: opts.viewport,
      onLongPress: (localX, localY): void => {
        const anchor = this.dataAnchorAtLocalPixel(localX, localY);
        if (anchor === null) {
          return;
        }
        this.enterTrackingInternal(anchor);
      },
      onTrackingMove: (localX, localY): void => {
        if (!this.trackingActive) {
          return;
        }
        const anchor = this.dataAnchorAtLocalPixel(localX, localY);
        if (anchor === null) {
          return;
        }
        this.trackingAnchor = anchor;
        const plot = this.computePlotRect();
        this.crosshair.setTrackingMove(plot.x + localX, plot.y + localY);
      },
      onPointerDownIntercept: this.drawingsController.onPointerDownIntercept,
    });
    this.priceAxisController = new PriceAxisController({
      axesLayer: renderer.axesLayer,
      plotRect: (): PlotRect => this.computePlotRect(),
      getRenderedDomain: (): PriceDomain => this.lastRenderedDomain,
      setManualDomain: (min, max): void => { this.applyManualDomain(min, max); },
      setAutoScale: (on): void => { this.setAutoScaleInternal(on); },
      onGestureStart: (): void => { this.viewport.stopKinetic(); },
      options: opts.priceAxisDrag,
    });
    this.crosshair = new CrosshairController({
      stage: renderer.app.stage,
      canvas: renderer.app.canvas,
      linesLayer: renderer.crosshairLinesLayer,
      tagsLayer: renderer.crosshairTagsLayer,
      eventBus: this.emitter,
      logger: opts.logger,
      invalidate: (): void => { this.invalidator.invalidate("crosshair"); },
    });
  }

  static async create(options: TimeSeriesChartConstructionOptions): Promise<TimeSeriesChart> {
    const logger = options.logger ?? noopLogger;
    const theme: Theme = {
      ...DarkTheme,
      ...(options.theme ?? {}),
    };

    const containerWidth = options.container.clientWidth;
    const containerHeight = options.container.clientHeight;
    const rawDpr =
      options.devicePixelRatio ??
      (typeof globalThis.window === "undefined" ? 1 : globalThis.window.devicePixelRatio || 1);
    const resolved: ResolvedOptions = {
      container: options.container,
      width: options.width ?? (containerWidth > 0 ? containerWidth : 800),
      height: options.height ?? (containerHeight > 0 ? containerHeight : 400),
      autoResize: options.autoResize ?? true,
      devicePixelRatio: resolveDpr(rawDpr),
      theme,
      logger,
      timeAxis: options.timeAxis,
      viewport: options.viewport,
      priceScale: options.priceScale,
      priceAxis: options.priceAxis,
      priceAxisDrag: options.priceAxisDrag,
      priceFormatter: options.priceFormatter ?? defaultPriceFormatter,
      data: options.data,
      dprListenerHooks: options.dprListenerHooks,
    };

    const renderer = await Renderer.create({
      container: resolved.container,
      width: resolved.width,
      height: resolved.height,
      background: theme.background,
      devicePixelRatio: resolved.devicePixelRatio,
    });

    const window = resolveWindow(options, logger);
    const config = new ConfigState({
      startTime: window.startTime,
      endTime: window.endTime,
      intervalDuration: window.intervalDuration,
      width: resolved.width,
      height: resolved.height,
      theme,
      magnet: "off",
    });

    const chart = new TimeSeriesChart(resolved, renderer, config);

    if (resolved.autoResize && typeof ResizeObserver !== "undefined") {
      chart.resizeObserver = new ResizeObserver(() => { chart.onAutoResize(); });
      chart.resizeObserver.observe(resolved.container);
    }

    chart.armDprListener();

    chart.invalidator.invalidate("layout");
    chart.invalidator.invalidate("theme");

    return chart;
  }

  resize(width: number, height: number): void {
    if (this.disposed) {
      return;
    }
    const safeW = Math.max(1, Math.floor(width));
    const safeH = Math.max(1, Math.floor(height));
    const next = this.config.withSize(safeW, safeH);
    if (next === this.config) {
      return;
    }
    this.config = next;
    this.renderer.resize(safeW, safeH);
    this.viewport.syncHitArea();
    this.priceAxisController.syncHitArea();
    this.invalidator.invalidate("size");
    const payload: SizeInfo = Object.freeze({ width: safeW, height: safeH });
    this.emitter.emit("resize", payload);
  }

  setWindow(win: WindowInput): void {
    if (this.disposed) {
      return;
    }
    const start = Number(win.startTime);
    const end = Number(win.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      this.opts.logger.warn(
        "[carta] setWindow received non-finite startTime/endTime — ignored",
      );
      return;
    }
    if (start > end) {
      this.opts.logger.warn(
        "[carta] setWindow startTime > endTime — accepting but chart will hide until corrected",
      );
    }
    this.applyWindowInternal(win);
  }

  getWindow(): ChartWindow {
    const { startTime, endTime, intervalDuration } = this.config.snapshot;
    return Object.freeze({ startTime, endTime, intervalDuration });
  }

  getInterval(): Interval {
    return this.config.snapshot.intervalDuration;
  }

  /**
   * Switch the chart's bar resolution. Wipes the previous-interval bucket
   * across every channel; other intervals are retained. Invalidates
   * `viewport` (axis recomputes) + `data` (series, future). Non-finite,
   * non-positive, or non-integer values are warned and ignored.
   */
  setInterval(intervalDuration: Interval | number): void {
    if (this.disposed) {
      return;
    }
    const raw = Number(intervalDuration);
    if (!Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) {
      this.opts.logger.warn(
        `[carta] setInterval received invalid intervalDuration (${String(intervalDuration)}) — must be a positive integer; ignored`,
      );
      return;
    }
    const next = asInterval(raw);
    const prevSnap = this.config.snapshot.intervalDuration;
    const nextConfig = this.config.withInterval(next);
    if (nextConfig === this.config) {
      return;
    }
    this.config = nextConfig;
    const prevIv = Number.isFinite(Number(prevSnap)) ? Number(prevSnap) : null;
    this.dataStore.setInterval(raw, prevIv);
    const intervalPayload: IntervalChange = Object.freeze({
      previous: prevIv !== null ? asInterval(prevIv) : null,
      current: next,
    });
    this.emitter.emit("interval:change", intervalPayload);
    // Cancel any in-flight drawing drag — anchor times stored in the old bar
    // grid would drift if we let the drag ride on the new interval.
    this.drawingsController.cancelActiveDrag();
    this.invalidator.invalidate("viewport");
    this.invalidator.invalidate("data");
  }

  // ─── Phase 13 Cycle B1 — magnet ────────────────────────────────────────

  /** Phase 13 Cycle B1 — get the current drawing-tools magnet mode. */
  getMagnet(): MagnetMode {
    return this.config.snapshot.magnet;
  }

  /**
   * Phase 13 Cycle B1 — set the drawing-tools magnet mode (`'off'` /
   * `'weak'` / `'strong'`). Affects new anchors during create + edit drag;
   * existing drawings are unchanged. Default is `'off'`.
   */
  setMagnet(mode: MagnetMode): void {
    if (this.disposed) {
      return;
    }
    const next = this.config.withMagnet(mode);
    if (next === this.config) {
      return;
    }
    this.config = next;
  }

  /**
   * Phase 13 Cycle B1 — primary-OHLC bar lookup for the magnet snap. Returns
   * the bar at `time` from the first registered `ohlc` channel at the chart's
   * active interval, or `null` when none exists / nothing is cached at that
   * time.
   */
  private lookupPrimaryOhlcBar(time: number): OhlcRecord | null {
    const interval = Number(this.config.snapshot.intervalDuration);
    if (!Number.isFinite(interval) || interval <= 0) {
      return null;
    }
    let primaryId: string | null = null;
    for (const ch of this.dataStore.channelsInOrder()) {
      if (ch.kind === "ohlc") {
        primaryId = ch.id;
        break;
      }
    }
    if (primaryId === null) {
      return null;
    }
    const bar = this.dataStore.getBar(primaryId, interval, time);
    if (bar === undefined) {
      return null;
    }
    if ("open" in bar && "high" in bar && "low" in bar && "close" in bar) {
      return bar;
    }
    return null;
  }

  /** Register a channel. Idempotent on same-kind redefines; throws on kind collision. */
  defineChannel(channel: Channel): void {
    if (this.disposed) {
      return;
    }
    this.dataStore.defineChannel(channel);
  }

  /**
   * Bulk-load records into a channel. Records must match the channel's
   * declared kind — mismatched records are dropped with `logger.warn`.
   * Throws synchronously if the channel was never `defineChannel`'d.
   */
  supplyData(
    channelId: string,
    intervalDuration: Interval | number,
    records: readonly DataRecord[],
  ): void {
    if (this.disposed) {
      return;
    }
    const raw = intervalDuration;
    if (!Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) {
      this.opts.logger.warn(
        `[carta] supplyData received invalid intervalDuration (${String(intervalDuration)}) — must be a positive integer; ignored`,
      );
      return;
    }
    this.dataStore.insertMany(channelId, raw, records);
    this.invalidator.invalidate("data");
  }

  /**
   * Single-record live update. Defaults `intervalDuration` to the chart's
   * current interval. Validation + kind enforcement match `supplyData`.
   */
  supplyTick(
    channelId: string,
    record: DataRecord,
    intervalDuration?: Interval | number,
  ): void {
    if (this.disposed) {
      return;
    }
    const raw = intervalDuration ?? this.config.snapshot.intervalDuration;
    if (!Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) {
      this.opts.logger.warn(
        `[carta] supplyTick received invalid intervalDuration (${String(raw)}) — must be a positive integer; ignored`,
      );
      return;
    }
    this.dataStore.insert(channelId, raw, record);
    this.invalidator.invalidate("data");
  }

  clearCache(opts?: ClearCacheOptions): void {
    if (this.disposed) {
      return;
    }
    this.dataStore.clearCache(opts);
    this.invalidator.invalidate("data");
  }

  /** Per-channel snapshot of intervals loaded and total record counts. */
  cacheStats(): readonly CacheStats[] {
    return this.dataStore.snapshot();
  }

  /** Inclusive slice of cached records on a channel. */
  recordsInRange(
    channelId: string,
    intervalDuration: Interval | number,
    startTime: Time | number,
    endTime: Time | number,
  ): readonly DataRecord[] {
    return this.dataStore.recordsInRange(
      channelId,
      intervalDuration,
      startTime,
      endTime,
    );
  }

  /**
   * Sub-windows of `[startTime, endTime]` that have no cached records on
   * this channel. Defaults to the chart's current window + interval. Marker
   * channels always return `[]`.
   */
  missingRanges(channelId: string, query?: MissingRangesQuery): readonly Range[] {
    const snap = this.config.snapshot;
    const startRaw = query?.startTime ?? snap.startTime;
    const endRaw = query?.endTime ?? snap.endTime;
    const ivRaw = query?.intervalDuration ?? snap.intervalDuration;
    if (
      !Number.isFinite(startRaw) ||
      !Number.isFinite(endRaw) ||
      !Number.isFinite(ivRaw) ||
      ivRaw <= 0 ||
      !Number.isInteger(ivRaw)
    ) {
      return [];
    }
    return this.dataStore.missingRanges(channelId, ivRaw, startRaw, endRaw);
  }

  /**
   * Phase 09 cycle B — convert plot-local pixels into a `(time, price)`
   * data anchor by reading the current `TimeScale` / `PriceScale`. Returns
   * `null` if the chart has no drawable plot (degenerate window or 0×0
   * rect). Used by the long-press path and `onTrackingMove`.
   */
  private dataAnchorAtLocalPixel(localX: number, localY: number): { time: Time; price: Price } | null {
    const plot = this.computePlotRect();
    if (plot.w <= 0 || plot.h <= 0) {
      return null;
    }
    const timeScale = this.currentTimeScaleForRect(plot);
    const priceScale = this.currentPriceScaleForRect(plot);
    const time = timeScale.pixelToTime(asPixel(localX));
    const price = priceScale.pixelToValue(asPixel(localY));
    return { time, price };
  }

  /**
   * Phase 09 cycle B — re-project the stored tracking anchor to plot
   * coordinates using the current scales, and push the result into the
   * crosshair. Called at the start of every flush while tracking is active
   * so the persistent crosshair stays glued to the data point through pan,
   * zoom, pinch, resize, theme change, and DPR transitions. Out-of-window
   * anchors are clamped by `CrosshairController.drawActive` to plot bounds.
   */
  private reprojectTrackingAnchor(): void {
    if (!this.trackingActive || this.trackingAnchor === null) {
      return;
    }
    const plot = this.computePlotRect();
    if (plot.w <= 0 || plot.h <= 0) {
      return;
    }
    const timeScale = this.currentTimeScaleForRect(plot);
    const priceScale = this.currentPriceScaleForRect(plot);
    const localX = Number(timeScale.timeToPixel(this.trackingAnchor.time));
    const localY = Number(priceScale.valueToPixel(this.trackingAnchor.price));
    const safeX = Number.isFinite(localX) ? localX : plot.w / 2;
    const safeY = Number.isFinite(localY) ? localY : plot.h / 2;
    this.crosshair.setTrackingMove(plot.x + safeX, plot.y + safeY);
  }

  /**
   * Phase 09 internal — entered automatically when the viewport's long-press
   * timer fires (anchor derived from the touch position) OR by the public
   * `enterTrackingMode` API (anchor from `{time, price}` or plot centroid).
   * Idempotent: re-entering already-tracking state re-anchors the crosshair
   * but does NOT emit a second `tracking:change` event.
   */
  private enterTrackingInternal(anchor: { time: Time; price: Price }): void {
    if (this.disposed) {
      return;
    }
    if (this.trackingActive) {
      // Re-anchor only — no event on idempotent calls.
      this.trackingAnchor = anchor;
      this.reprojectTrackingAnchor();
      this.invalidator.invalidate("crosshair");
      return;
    }
    this.trackingActive = true;
    this.trackingAnchor = anchor;
    this.viewport.setTrackingMode(true);
    this.reprojectTrackingAnchor();
    if (typeof globalThis.document !== "undefined") {
      this.documentPointerDownHandler = (e: PointerEvent): void => {
        const canvas = this.renderer.app.canvas;
        const target = e.target;
        if (target === canvas) {
          return;
        }
        if (target instanceof Node && canvas.contains(target)) {
          return;
        }
        this.exitTrackingInternal();
      };
      globalThis.document.addEventListener(
        "pointerdown",
        this.documentPointerDownHandler,
        { capture: true },
      );
    }
    // Emit synchronously *before* the invalidation: by the time the next
    // flush emits `crosshair:move`, hosts already know we're in tracking.
    const enterPayload: TrackingChange = Object.freeze({ active: true });
    this.emitter.emit("tracking:change", enterPayload);
    this.invalidator.invalidate("crosshair");
  }

  /**
   * Phase 09 internal exit. Hides the crosshair, drops the document-level
   * pointerdown listener, and tells the viewport to resume normal pan
   * routing. Idempotent — calls when not tracking are silent no-ops.
   */
  private exitTrackingInternal(): void {
    if (this.disposed || !this.trackingActive) {
      return;
    }
    this.trackingActive = false;
    this.trackingAnchor = null;
    this.viewport.setTrackingMode(false);
    this.crosshair.hide();
    if (
      this.documentPointerDownHandler !== null &&
      typeof globalThis.document !== "undefined"
    ) {
      globalThis.document.removeEventListener(
        "pointerdown",
        this.documentPointerDownHandler,
        { capture: true },
      );
    }
    this.documentPointerDownHandler = null;
    const exitPayload: TrackingChange = Object.freeze({ active: false });
    this.emitter.emit("tracking:change", exitPayload);
    this.invalidator.invalidate("crosshair");
  }

  /**
   * Phase 09 cycle B — programmatic entry into tracking mode. `time` /
   * `price` default to the plot rectangle's centroid (mid-window time, mid-
   * domain price). Non-finite or out-of-window values fall back to the
   * centroid default with a `logger.warn`. Rejects with a warn if a
   * multi-pointer gesture (pinch / two-finger pan) is currently in flight.
   * Re-entering already-tracking state re-positions the crosshair without
   * emitting a second `tracking:change` event.
   */
  enterTrackingMode(opts?: TrackingModeOptions): void {
    if (this.disposed) {
      return;
    }
    if (this.viewport.activePointerCount() >= 2) {
      this.opts.logger.warn(
        "[carta] enterTrackingMode rejected — a multi-pointer gesture is in flight",
      );
      return;
    }
    const plot = this.computePlotRect();
    if (plot.w <= 0 || plot.h <= 0) {
      // No drawable plot — nothing to point at. Stay idle.
      return;
    }
    const timeScale = this.currentTimeScaleForRect(plot);
    const priceScale = this.currentPriceScaleForRect(plot);
    const centroidTime = timeScale.pixelToTime(asPixel(plot.w / 2));
    const centroidPrice = priceScale.pixelToValue(asPixel(plot.h / 2));

    let time: Time = centroidTime;
    if (opts?.time !== undefined) {
      const rawTime = Number(opts.time);
      if (!Number.isFinite(rawTime)) {
        this.opts.logger.warn(
          `[carta] enterTrackingMode received non-finite time (${String(opts.time)}) — falling back to plot centroid`,
        );
      } else {
        time = asTime(rawTime);
      }
    }

    let price: Price = centroidPrice;
    if (opts?.price !== undefined) {
      const rawPrice = Number(opts.price);
      if (!Number.isFinite(rawPrice)) {
        this.opts.logger.warn(
          `[carta] enterTrackingMode received non-finite price (${String(opts.price)}) — falling back to plot vertical centroid`,
        );
      } else {
        price = asPrice(rawPrice);
      }
    }

    this.enterTrackingInternal({ time, price });
  }

  /**
   * Phase 09 cycle B — programmatic exit from tracking mode. Idempotent
   * (no-op + no event when not currently tracking). Equivalent to a tap
   * outside the canvas.
   */
  exitTrackingMode(): void {
    if (this.disposed) {
      return;
    }
    this.exitTrackingInternal();
  }

  /** Phase 09 cycle B — whether tracking mode is currently active. */
  isTrackingMode(): boolean {
    return this.trackingActive;
  }

  /**
   * Phase 09 cycle B — arm a `matchMedia('(resolution: ${dpr}dppx)')`
   * one-shot listener. When the system DPR changes (browser zoom, monitor
   * drag) the listener fires `onDprChange` and immediately re-arms with the
   * new resolution. Idempotent: `armDprListener` while a listener is already
   * active is a no-op.
   */
  private armDprListener(): void {
    if (this.disposed || this.mediaMatcher === null) {
      return;
    }
    if (this.dprMediaQuery !== null) {
      return;
    }
    const dprForQuery = this.currentResolution;
    const mq = this.mediaMatcher(`(resolution: ${String(dprForQuery)}dppx)`);
    const listener = (_e: MediaQueryListEvent): void => {
      this.onDprChange();
    };
    mq.addEventListener("change", listener, { once: true });
    this.dprMediaQuery = mq;
    this.dprMediaListener = listener;
  }

  private disarmDprListener(): void {
    if (this.dprMediaQuery !== null && this.dprMediaListener !== null) {
      this.dprMediaQuery.removeEventListener("change", this.dprMediaListener);
    }
    this.dprMediaQuery = null;
    this.dprMediaListener = null;
  }

  private onDprChange(): void {
    if (this.disposed) {
      return;
    }
    this.disarmDprListener();
    const nextDpr = resolveDpr(this.dprProbe());
    if (nextDpr !== this.currentResolution) {
      this.currentResolution = nextDpr;
      this.renderer.setResolution(nextDpr);
      this.invalidator.invalidate("size");
    }
    this.armDprListener();
  }

  /** Dev/test hook: whether the kinetic-scroll RAF is currently running. */
  isKineticActive(): boolean {
    return this.viewport.isKineticActive();
  }

  /** Dev/test hook: cancel any in-flight kinetic-scroll fling. */
  stopKinetic(): void {
    this.viewport.stopKinetic();
  }

  /** Facade for price-scale control. 04a: manual domain only; 04b adds autoScale. */
  priceScale(): PriceScaleFacade {
    return this.priceScaleFacade;
  }

  /**
   * Phase 13 — drawing-tools facade. Imperative API for begin-create / add /
   * select / get-snapshot / load-snapshot / attach-storage. Read-only;
   * internal controller stays private.
   */
  get drawings(): DrawingsFacade {
    return this.drawingsFacade;
  }

  /** Apply a subset of chart options at runtime. */
  applyOptions(options: ApplyOptions): void {
    if (this.disposed) {
      return;
    }
    let changed = false;
    if (options.priceFormatter !== undefined) {
      this.priceFormatter = options.priceFormatter;
      changed = true;
    }
    if (options.theme !== undefined) {
      const nextTheme: Theme = { ...this.config.snapshot.theme, ...options.theme };
      const nextConfig = this.config.withTheme(nextTheme);
      if (nextConfig !== this.config) {
        this.config = nextConfig;
        changed = true;
      }
    }
    if (changed) {
      this.invalidator.invalidate("theme");
    }
  }

  /** Visible price ticks from the most-recent render. Dev/test introspection. */
  visiblePriceTicks(): readonly PriceTickInfo[] {
    return this.priceAxis.ticks();
  }

  /** Price-label pool capacity (constant after first render). Dev/test introspection. */
  priceAxisPoolSize(): number {
    return this.priceAxis.poolSize();
  }

  /**
   * Attach a series to the chart. Auto-registers the series' channel on
   * the data store if not yet registered; throws on kind collision. The
   * series becomes a `PriceRangeProvider` so it participates in auto-scale.
   * Returns the series for TradingView-style chaining.
   */
  addSeries<S extends Series>(series: S): S {
    if (this.disposed) {
      return series;
    }
    const existing = this.dataStore.getChannel(series.channel);
    if (existing !== undefined && existing.kind !== series.kind) {
      throw new Error(
        `[carta] addSeries: channel '${series.channel}' is registered with kind '${existing.kind}' but series requires kind '${series.kind}'`,
      );
    }
    if (existing === undefined) {
      this.dataStore.defineChannel({ id: series.channel, kind: series.kind });
    }
    series.setQueryContext({
      dataStore: this.dataStore,
      getInterval: () => Number(this.config.snapshot.intervalDuration),
      invalidate: () => { this.invalidator.invalidate("data"); },
    });
    series.attach(this.renderer.seriesLayer);
    this.series.push(series);
    this.priceRangeProviders.add(series);
    this.invalidator.invalidate("data");
    return series;
  }

  /**
   * Detach and destroy a previously added series. The series' channel
   * remains registered on the store — other series (or future indicator
   * queries) may still consume it.
   */
  removeSeries(series: Series): boolean {
    if (this.disposed) {
      return false;
    }
    const idx = this.series.indexOf(series);
    if (idx === -1) {
      return false;
    }
    this.series.splice(idx, 1);
    this.priceRangeProviders.delete(series);
    series.destroy();
    this.invalidator.invalidate("data");
    return true;
  }

  /** Register a provider for auto-scale reconciliation. Providers are polled
   *  once per flush while `autoScale` is on. No-op if already registered. */
  addPriceRangeProvider(provider: PriceRangeProvider): void {
    if (this.disposed) {
      return;
    }
    if (this.priceRangeProviders.has(provider)) {
      return;
    }
    this.priceRangeProviders.add(provider);
    if (this.autoScaleEnabled) {
      this.invalidator.invalidate("viewport");
    }
  }

  removePriceRangeProvider(provider: PriceRangeProvider): void {
    if (this.disposed) {
      return;
    }
    if (!this.priceRangeProviders.delete(provider)) {
      return;
    }
    if (this.autoScaleEnabled) {
      this.invalidator.invalidate("viewport");
    }
  }

  private setPriceDomain(min: Price | number, max: Price | number): void {
    const rawMin = Number(min);
    const rawMax = Number(max);
    if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) {
      this.opts.logger.warn(
        "[carta] priceScale.setDomain received non-finite min/max — price axis will hide until valid values are supplied",
      );
    } else if (rawMin > rawMax) {
      this.opts.logger.warn(
        "[carta] priceScale.setDomain min > max — price axis will hide until corrected",
      );
    }
    const next: PriceDomain = Object.freeze({ min: asPrice(rawMin), max: asPrice(rawMax) });
    const prevMin = Number(this.priceDomain.min);
    const prevMax = Number(this.priceDomain.max);
    const unchanged =
      ((Number.isNaN(prevMin) && Number.isNaN(rawMin)) || prevMin === rawMin) &&
      ((Number.isNaN(prevMax) && Number.isNaN(rawMax)) || prevMax === rawMax);
    const autoWasOn = this.autoScaleEnabled;
    this.autoScaleEnabled = false;
    if (unchanged && !autoWasOn) {
      return;
    }
    this.priceDomain = next;
    this.invalidator.invalidate("viewport");
  }

  private applyManualDomain(min: Price, max: Price): void {
    const next: PriceDomain = Object.freeze({ min, max });
    this.priceDomain = next;
    this.invalidator.invalidate("viewport");
  }

  private setAutoScaleInternal(on: boolean): void {
    if (this.disposed) {
      return;
    }
    if (this.autoScaleEnabled === on) {
      return;
    }
    this.autoScaleEnabled = on;
    this.invalidator.invalidate("viewport");
  }

  private resolvePriceMargins(): PriceScaleMargins | undefined {
    return this.opts.priceScale?.margins;
  }

  private applyWindowInternal(win: WindowInput): void {
    const next = this.config.withWindow(win.startTime, win.endTime);
    if (next === this.config) {
      return;
    }
    this.config = next;
    this.invalidator.invalidate("viewport");
  }

  /**
   * Returns the timestamps of every bar slot the chart's current window
   * covers, inclusive-inclusive: `[alignDown(startTime, interval),
   * alignDown(endTime, interval)]` stepping by `intervalDuration`. Empty
   * array when the config is degenerate.
   */
  barsInWindow(): readonly Time[] {
    const scale = this.currentTimeScale();
    return scale.visibleBarSlots();
  }

  /** Visible tick list from the most-recent render. Dev/test introspection. */
  visibleTicks(): readonly TickInfo[] {
    return this.timeAxis.ticks();
  }

  /** Label-pool capacity (constant after first render). Dev/test introspection. */
  axisPoolSize(): number {
    return this.timeAxis.poolSize();
  }

  /**
   * Dev/test introspection. Returns cumulative counters for the crosshair and
   * series rendering so Playwright can assert pool stability and fast-path
   * correctness (e.g. "series render count stays flat during pure crosshair
   * activity"). Not part of the committed public API — prefixed with `__`.
   */
  __debugStats(): {
    readonly seriesRenderCount: number;
    readonly crosshair: {
      readonly emitCount: number;
      readonly bgRedrawCount: number;
      readonly atlasSeedCount: number;
      readonly isVisible: boolean;
    };
    readonly tracking: {
      readonly active: boolean;
      readonly viewportTracking: boolean;
    };
    readonly dpr: {
      readonly resolution: number;
      readonly listenerArmed: boolean;
    };
  } {
    return {
      seriesRenderCount: this.seriesRenderCounter,
      crosshair: {
        emitCount: this.crosshair.getEmitCount(),
        bgRedrawCount: this.crosshair.getBgRedrawCount(),
        atlasSeedCount: this.crosshair.getAtlasSeedCount(),
        isVisible: this.crosshair.isVisible(),
      },
      tracking: {
        active: this.trackingActive,
        viewportTracking: this.viewport.isTrackingMode(),
      },
      dpr: {
        resolution: this.currentResolution,
        listenerArmed: this.dprMediaQuery !== null,
      },
    };
  }

  destroy(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.dataRequestDebouncer.cancel();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (
      this.documentPointerDownHandler !== null &&
      typeof globalThis.document !== "undefined"
    ) {
      globalThis.document.removeEventListener(
        "pointerdown",
        this.documentPointerDownHandler,
        { capture: true },
      );
    }
    this.documentPointerDownHandler = null;
    this.trackingActive = false;
    this.trackingAnchor = null;
    this.disarmDprListener();
    this.drawingsController.destroy();
    this.crosshair.destroy();
    this.priceAxisController.destroy();
    this.viewport.destroy();
    this.invalidator.dispose();
    this.timeAxis.destroy();
    this.priceAxis.destroy();
    for (const s of this.series) {
      s.destroy();
    }
    this.series.length = 0;
    this.priceRangeProviders.clear();
    this.dataStore.clearAll();
    this.emitter.removeAllListeners();
    for (const ctx of this.sharedContexts) {
      ctx.destroy();
    }
    this.sharedContexts.length = 0;
    this.renderer.destroy();
  }

  private flush(reasons: ReadonlySet<DirtyReason>): void {
    if (this.disposed) {
      return;
    }

    // Fast path: pointer moves that only set the `'crosshair'` dirty flag
    // must not redraw series / axes / grid. Uses the current plot rect +
    // scales against the last committed window — no layout work.
    if (reasons.size === 1 && reasons.has("crosshair")) {
      const plotRect = this.computePlotRect();
      const snap = this.config.snapshot;
      this.crosshair.redraw({
        plotRect,
        timeScale: this.currentTimeScaleForRect(plotRect),
        priceScale: this.currentPriceScaleForRect(plotRect),
        theme: snap.theme,
        dataStore: this.dataStore,
        series: this.series,
        intervalDuration: snap.intervalDuration,
        priceFormatter: this.priceFormatter,
        inTrackingMode: this.trackingActive,
      });
      this.renderer.render();
      return;
    }

    // Phase 09 cycle B — when tracking is active, every full-path flush
    // (window/size/layout/data change) must re-project the stored data
    // anchor through the new scales BEFORE the crosshair redraws. Without
    // this, a pinch / pan / DPR change would leave the crosshair pinned to
    // its old pixel even though the bar underneath moved.
    if (
      this.trackingActive &&
      this.trackingAnchor !== null &&
      (reasons.has("viewport") || reasons.has("size") || reasons.has("layout") || reasons.has("data"))
    ) {
      this.reprojectTrackingAnchor();
    }

    const plotRect = this.computePlotRect();
    this.renderer.layout(plotRect);
    this.renderer.renderFrame(
      this.config.snapshot.theme,
      this.config.snapshot.width,
      this.config.snapshot.height,
      plotRect,
    );
    this.reconcileRenderedDomain();
    this.priceAxisController.syncHitArea();
    const scale = this.currentTimeScaleForRect(plotRect);
    const priceScale = this.currentPriceScaleForRect(plotRect);
    if (this.series.length > 0 && (reasons.has("data") || reasons.has("viewport") || reasons.has("size") || reasons.has("layout") || reasons.has("theme"))) {
      const snap = this.config.snapshot;
      const ctx: SeriesRenderContext = {
        startTime: snap.startTime,
        endTime: snap.endTime,
        intervalDuration: snap.intervalDuration,
        plotWidth: plotRect.w,
        plotHeight: plotRect.h,
        timeScale: scale,
        priceScale,
        dataStore: this.dataStore,
        theme: snap.theme,
      };
      for (const s of this.series) {
        s.render(ctx);
        this.seriesRenderCounter += 1;
      }
    }
    if (
      reasons.has("drawings") ||
      reasons.has("viewport") ||
      reasons.has("size") ||
      reasons.has("layout") ||
      reasons.has("theme")
    ) {
      this.drawingsController.render({
        plotRect,
        timeScale: scale,
        priceScale,
        theme: this.config.snapshot.theme,
        dpr: this.currentResolution,
      });
    }
    this.timeAxis.render(scale, plotRect, this.config.snapshot.theme);
    this.priceAxis.render(
      priceScale,
      plotRect,
      this.config.snapshot.theme,
      this.priceFormatter,
      this.opts.logger,
    );
    // Keep the crosshair in sync with whatever scales / data / theme just
    // changed — without this branch, a pan drag would leave the hair pointing
    // at the bar under the cursor *before* the drag, and a theme swap while
    // the crosshair is visible would strand stale colours until the next
    // pointer move.
    if (
      reasons.has("crosshair") ||
      reasons.has("viewport") ||
      reasons.has("data") ||
      reasons.has("layout") ||
      reasons.has("size") ||
      reasons.has("theme")
    ) {
      const snap = this.config.snapshot;
      this.crosshair.redraw({
        plotRect,
        timeScale: scale,
        priceScale,
        theme: snap.theme,
        dataStore: this.dataStore,
        series: this.series,
        intervalDuration: snap.intervalDuration,
        priceFormatter: this.priceFormatter,
        inTrackingMode: this.trackingActive,
      });
    }
    this.renderer.render();
    this.maybeEmitWindowChange(reasons);
  }

  /**
   * Emit `window:change` once per flush when the window payload (start/end/
   * intervalDuration) differs from the last emission. Gated on viewport reason
   * so resize-only or theme-only flushes don't fire a spurious event.
   * Scheduling a debounced `data:request` emission piggybacks the same path.
   */
  private maybeEmitWindowChange(reasons: ReadonlySet<DirtyReason>): void {
    if (!reasons.has("viewport")) {
      return;
    }
    const current = this.getWindow();
    const prev = this.lastEmittedWindow;
    if (
      prev !== null &&
      prev.startTime === current.startTime &&
      prev.endTime === current.endTime &&
      prev.intervalDuration === current.intervalDuration
    ) {
      return;
    }
    this.lastEmittedWindow = current;
    this.emitter.emit("window:change", current);
    this.dataRequestDebouncer.push();
  }

  /**
   * Debouncer trailing-edge callback. Iterates every registered channel
   * (marker channels short-circuit to `[]` inside `DataStore.missingRanges`)
   * and emits one `data:request` per contiguous gap. Fires against the
   * chart's current window + interval at the moment of firing — not the
   * window at the moment of the debouncer push.
   */
  private emitDataRequests(): void {
    if (this.disposed) {
      return;
    }
    const snap = this.config.snapshot;
    const ivRaw = Number(snap.intervalDuration);
    const start = Number(snap.startTime);
    const end = Number(snap.endTime);
    if (
      !Number.isFinite(ivRaw) ||
      ivRaw <= 0 ||
      !Number.isInteger(ivRaw) ||
      !Number.isFinite(start) ||
      !Number.isFinite(end)
    ) {
      return;
    }
    const stats = this.dataStore.snapshot();
    for (const s of stats) {
      if (s.kind === "marker") {
        continue;
      }
      const gaps = this.dataStore.missingRanges(s.channelId, ivRaw, start, end);
      for (const g of gaps) {
        const payload: DataRequest = Object.freeze({
          channelId: s.channelId,
          kind: s.kind,
          intervalDuration: snap.intervalDuration,
          startTime: asTime(g.start),
          endTime: asTime(g.end),
        });
        this.emitter.emit("data:request", payload);
      }
    }
  }

  /** Subscribe to a typed chart event. See `CartaEventMap` for payloads. */
  on<K extends EventKey>(event: K, handler: CartaEventHandler<K>): void {
    this.emitter.on(event, handler);
  }

  /** Unsubscribe a specific handler. */
  off<K extends EventKey>(event: K, handler: CartaEventHandler<K>): void {
    this.emitter.off(event, handler);
  }

  /** Subscribe for exactly one emission. */
  once<K extends EventKey>(event: K, handler: CartaEventHandler<K>): void {
    this.emitter.once(event, handler);
  }

  /**
   * Emit a typed event on the chart's bus. Public so cross-cutting helpers
   * (e.g. `installHotkeys`) can route input into the same channel hosts
   * subscribe to via `chart.on(...)`.
   */
  emit<K extends EventKey>(event: K, payload: CartaEventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  /** Unsubscribe every handler for every event. Safe to call during shutdown. */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }

  /** Test-only: whether `data:request` is currently awaiting its trailing edge. */
  hasPendingDataRequest(): boolean {
    return this.dataRequestDebouncer.hasPending();
  }

  /** Pull-based reconciliation of the rendered price domain. Runs once per
   *  flush, writes `lastRenderedDomain` only. Never calls `invalidate`. */
  private reconcileRenderedDomain(): void {
    if (!this.autoScaleEnabled) {
      this.lastRenderedDomain = this.priceDomain;
      return;
    }
    const snap = this.config.snapshot;
    const reduced: PriceRange | null = reducePriceRanges(
      this.priceRangeProviders,
      snap.startTime,
      snap.endTime,
    );
    if (reduced === null) {
      // Retain the prior rendered domain — don't collapse to [0, 1].
      return;
    }
    this.lastRenderedDomain = Object.freeze({ min: reduced.min, max: reduced.max });
  }

  private currentPriceScaleForRect(plotRect: PlotRect): PriceScale {
    return new PriceScale({
      domainMin: this.lastRenderedDomain.min,
      domainMax: this.lastRenderedDomain.max,
      pixelHeight: plotRect.h,
      margins: this.resolvePriceMargins(),
    });
  }

  private currentTimeScale(): TimeScale {
    return this.currentTimeScaleForRect(this.computePlotRect());
  }

  private currentTimeScaleForRect(plotRect: PlotRect): TimeScale {
    const snap = this.config.snapshot;
    return new TimeScale({
      startTime: snap.startTime,
      endTime: snap.endTime,
      intervalDuration: snap.intervalDuration,
      pixelWidth: plotRect.w,
    });
  }

  private computePlotRect(): PlotRect {
    const { width, height } = this.config.snapshot;
    return {
      x: 0,
      y: 0,
      w: Math.max(0, width - PRICE_AXIS_STRIP_WIDTH),
      h: Math.max(0, height - BOTTOM_MARGIN),
    };
  }

  private onAutoResize(): void {
    if (this.disposed) {
      return;
    }
    const w = this.opts.container.clientWidth;
    const h = this.opts.container.clientHeight;
    if (w <= 0 || h <= 0) {
      return;
    }
    this.resize(w, h);
  }
}

interface ResolvedWindow {
  readonly startTime: Time;
  readonly endTime: Time;
  readonly intervalDuration: Interval;
}

function resolveWindow(
  options: TimeSeriesChartOptions,
  logger: Logger,
): ResolvedWindow {
  const rawStart = Number(options.startTime);
  const rawEnd = Number(options.endTime);
  const rawInterval = Number(options.intervalDuration);

  const startOk = Number.isFinite(rawStart);
  const endOk = Number.isFinite(rawEnd);
  const intervalOk = Number.isFinite(rawInterval) && rawInterval > 0;

  if (!startOk || !endOk) {
    logger.warn(
      "[carta] non-finite startTime/endTime — axis will hide until setWindow() is called with finite values",
    );
  }
  if (!intervalOk) {
    logger.warn(
      `[carta] invalid intervalDuration (${String(options.intervalDuration)}) — axis will hide until setInterval() is called with a positive value`,
    );
  }
  if (startOk && endOk && rawStart > rawEnd) {
    logger.warn(
      "[carta] startTime > endTime — axis will hide until the window is corrected",
    );
  }

  return {
    startTime: asTime(startOk ? rawStart : Number.NaN),
    endTime: asTime(endOk ? rawEnd : Number.NaN),
    intervalDuration: asInterval(intervalOk ? rawInterval : Number.NaN),
  };
}
