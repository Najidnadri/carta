import type { GraphicsContext } from "pixi.js";
import { ConfigState } from "./ConfigState.js";
import { CrosshairController } from "../interaction/CrosshairController.js";
import { DataStore } from "../data/DataStore.js";
import { DrawingsController, type DrawingsFacade } from "../drawings/DrawingsController.js";
import { MAIN_PANE_ID, asPaneId, type PaneId } from "../drawings/types.js";
import { DarkTheme } from "../infra/themes.js";
import { DebouncedEmitter } from "../infra/DebouncedEmitter.js";
import { EventBus } from "../infra/EventBus.js";
import { InvalidationQueue, type DirtyReason } from "../infra/InvalidationQueue.js";
import { noopLogger } from "../infra/Logger.js";
import { Pane } from "../pane/Pane.js";
import { computePaneRects, type PaneLayoutInput } from "../pane/PaneLayout.js";
import { PaneResizeController } from "../pane/PaneResizeController.js";
import type { PaneOptions, PaneRect, PriceScaleId } from "../pane/types.js";
import {
  defaultPriceFormatter,
  PRICE_AXIS_STRIP_WIDTH,
} from "../price/PriceAxis.js";
import type { PriceTickInfo } from "../price/PriceAxis.js";
import {
  PriceAxisController,
  type PriceAxisDragOptions,
} from "../price/PriceAxisController.js";
import type { PriceRangeProvider } from "../price/PriceRangeProvider.js";
import type { PriceScale } from "../price/PriceScale.js";
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
  private readonly viewport: ViewportController;
  private readonly priceAxisController: PriceAxisController;
  private readonly crosshair: CrosshairController;
  private readonly drawingsController: DrawingsController;
  private readonly drawingsFacade: DrawingsFacade;
  private readonly paneResizeController: PaneResizeController;
  private lastPaneRects: readonly PaneRect[] = [];
  private readonly dataStore: DataStore;
  private readonly emitter: EventBus<CartaEventMap>;
  private readonly dataRequestDebouncer: DebouncedEmitter<void>;
  private lastEmittedWindow: ChartWindow | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private config: ConfigState;
  private disposed = false;

  private readonly panesList: Pane[] = [];
  private readonly panesById = new Map<PaneId, Pane>();
  private readonly seriesPaneById = new Map<Series, PaneId>();
  private readonly seriesScaleById = new Map<Series, PriceScaleId>();
  private readonly series: Series[] = [];
  private priceFormatter: PriceFormatter;
  private seriesRenderCounter = 0;
  private trackingActive = false;
  private trackingAnchor: { time: Time; price: Price; paneId: PaneId } | null = null;
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

    // Phase 14 Cycle A — primary pane wraps the existing single-pane scene
    // graph. Initial price-axis options propagate to the primary pane only;
    // future panes get a default `PriceAxis` (cycle B will accept per-pane
    // axis options).
    const primary = new Pane({ id: MAIN_PANE_ID });
    this.panesList.push(primary);
    this.panesById.set(MAIN_PANE_ID, primary);
    this.renderer.setPrimaryPane(primary);
    if (opts.priceScale?.margins !== undefined) {
      primary.ensureSlot("right", opts.priceScale.margins);
    }

    this.timeAxis = new TimeAxis(renderer.gridLayer, renderer.axesLayer, opts.timeAxis);
    this.priceFormatter = opts.priceFormatter;
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
        // Phase 13 Cycle B.3 — drawings consume long-press first.  If a
        // drawing is hit, the controller selects it + emits
        // `drawing:contextmenu` with `source: 'long-press'` and we skip
        // tracking-mode entry.
        if (this.drawingsController.tryClaimLongPress(localX, localY)) {
          return;
        }
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
      // Phase 13 Cycle B.3 — pinch entry rolls back any in-flight drawing
      // drag (parity with `interval:change` rollback).  Mid-create FSM is
      // intentionally untouched: a half-placed trendline survives the pinch.
      onPinchStart: (): void => {
        this.drawingsController.cancelActiveDrag();
        // Phase 13 Cycle C.3 — pinch mid-stroke discards any partial brush
        // capture so a 2-finger pinch rolls back to viewport zoom cleanly.
        this.drawingsController.cancelActiveBrush();
      },
    });
    this.priceAxisController = new PriceAxisController({
      axesLayer: renderer.axesLayer,
      plotRect: (): PlotRect => this.computePlotRect(),
      getRenderedDomain: (): PriceDomain => this.primaryRightSlotDomain(),
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
    // Phase 14 Cycle A — drag-to-resize divider between adjacent panes.
    this.paneResizeController = new PaneResizeController({
      canvas: renderer.app.canvas,
      separatorLayer: renderer.separatorLayer,
      panes: () => this.panesList,
      paneRects: () => this.lastPaneRects,
      onResize: (aboveId, aboveH, belowId, belowH): void => {
        this.applyPaneDragResize(aboveId, aboveH, belowId, belowH);
      },
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
    // Phase 13 Cycle C.3 — same rationale for an active brush capture.
    this.drawingsController.cancelActiveBrush();
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
  private dataAnchorAtLocalPixel(
    localX: number,
    localY: number,
  ): { time: Time; price: Price; paneId: PaneId } | null {
    const plot = this.computePlotRect();
    if (plot.w <= 0 || plot.h <= 0) {
      return null;
    }
    const timeScale = this.currentTimeScaleForRect(plot);
    const priceScale = this.currentPriceScaleForRect(plot);
    const time = timeScale.pixelToTime(asPixel(localX));
    const price = priceScale.pixelToValue(asPixel(localY));
    return { time, price, paneId: MAIN_PANE_ID };
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
  private enterTrackingInternal(anchor: { time: Time; price: Price; paneId?: PaneId }): void {
    if (this.disposed) {
      return;
    }
    const fullAnchor: { time: Time; price: Price; paneId: PaneId } = {
      time: anchor.time,
      price: anchor.price,
      paneId: anchor.paneId ?? MAIN_PANE_ID,
    };
    if (this.trackingActive) {
      // Re-anchor only — no event on idempotent calls.
      this.trackingAnchor = fullAnchor;
      this.reprojectTrackingAnchor();
      this.invalidator.invalidate("crosshair");
      return;
    }
    this.trackingActive = true;
    this.trackingAnchor = fullAnchor;
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

  /**
   * Facade for the **primary pane's right** price-scale. Equivalent to
   * `chart.primaryPane().priceScale('right')`. Phase 14 Cycle A introduced
   * panes; pre-cycle-A host code that calls `chart.priceScale()` continues
   * to work unchanged.
   */
  priceScale(): PriceScaleFacade {
    return this.primaryPane().priceScale("right");
  }

  /**
   * Phase 14 Cycle A — public read-side accessors for the pane abstraction.
   * `panes()` returns a top-to-bottom snapshot; `pane(id)` is `null` if
   * unknown; `primaryPane()` is shorthand for `pane(MAIN_PANE_ID)`.
   */
  panes(): readonly Pane[] {
    return this.panesList;
  }

  pane(id: PaneId): Pane | null {
    return this.panesById.get(id) ?? null;
  }

  primaryPane(): Pane {
    const p = this.panesById.get(MAIN_PANE_ID);
    if (p === undefined) {
      throw new Error("[carta] primaryPane: primary pane not constructed (chart disposed?)");
    }
    return p;
  }

  /**
   * Phase 14 Cycle A — append a new pane below the existing stack. Auto-
   * generates a stable id when omitted; throws if the supplied id collides.
   * Stretch factor defaults to 1; `minHeight` defaults to 50 (hard floor 30
   * inside `PaneLayout`).
   */
  addPane(opts?: PaneOptions): Pane {
    if (this.disposed) {
      throw new Error("[carta] addPane: chart is disposed");
    }
    const id = opts?.id ?? asPaneId(`pane-${generatePaneIdSuffix()}`);
    if (this.panesById.has(id)) {
      throw new Error(`[carta] addPane: id '${String(id)}' already exists`);
    }
    const pane = new Pane({
      id,
      stretchFactor: opts?.stretchFactor,
      minHeight: opts?.minHeight,
    });
    this.renderer.attachPane(pane);
    this.panesList.push(pane);
    this.panesById.set(id, pane);
    this.invalidator.invalidate("layout");
    return pane;
  }

  /**
   * Phase 14 Cycle A — remove a non-primary pane. Destroys every series
   * attached to that pane (channel data caches are NOT touched, so re-adding
   * a series on the same channel works). Throws on the primary pane.
   */
  /**
   * Phase 14 Cycle A — programmatic resize. Pins the pane's height to
   * `px`. Pass `null` to release the override and let the pane flex via
   * `stretchFactor`. Emits `pane:resize` with `source: 'programmatic'`.
   */
  setPaneHeight(id: PaneId, px: number | null): void {
    if (this.disposed) {
      return;
    }
    const pane = this.panesById.get(id);
    if (pane === undefined) {
      return;
    }
    pane.setHeight(px);
    this.invalidator.invalidate("layout");
    if (typeof px === "number" && Number.isFinite(px)) {
      this.emitter.emit("pane:resize", {
        paneId: id,
        height: pane.heightOverride ?? Math.floor(px),
        source: "programmatic",
      });
    }
  }

  /**
   * Phase 14 Cycle A — toggle pane visibility. Hidden panes occupy 0 px of
   * layout; the pane's series + scale state are preserved so unhiding
   * restores the prior visual. Emits `pane:visibility`.
   */
  setPaneHidden(id: PaneId, hidden: boolean): void {
    if (this.disposed) {
      return;
    }
    const pane = this.panesById.get(id);
    if (pane === undefined) {
      return;
    }
    if (pane.hidden === hidden) {
      return;
    }
    pane.setHidden(hidden);
    this.invalidator.invalidate("layout");
    this.emitter.emit("pane:visibility", { paneId: id, hidden });
    // Phase 14 Cycle A — emit `pane:resize` with `source: 'hidden'` only on
    // hide (height collapses to 0 in the same frame). On show, the post-flush
    // chart-resize path emits the restored height; emitting it here would
    // require querying the not-yet-laid-out rect.
    if (hidden) {
      this.emitter.emit("pane:resize", {
        paneId: id,
        height: 0,
        source: "hidden",
      });
    }
  }

  /**
   * Phase 14 Cycle A — internal callback from `PaneResizeController` when
   * the user finishes a divider drag. Pins both neighbouring panes to their
   * new heights and emits one `pane:resize` per pane with `source: 'user-drag'`.
   */
  private applyPaneDragResize(
    aboveId: string,
    aboveH: number,
    belowId: string,
    belowH: number,
  ): void {
    const above = this.panesById.get(aboveId as PaneId);
    const below = this.panesById.get(belowId as PaneId);
    if (above === undefined || below === undefined) {
      return;
    }
    above.setHeight(aboveH);
    below.setHeight(belowH);
    this.invalidator.invalidate("layout");
    this.emitter.emit("pane:resize", {
      paneId: above.id,
      height: above.heightOverride ?? aboveH,
      source: "user-drag",
    });
    this.emitter.emit("pane:resize", {
      paneId: below.id,
      height: below.heightOverride ?? belowH,
      source: "user-drag",
    });
  }

  removePane(id: PaneId): void {
    if (this.disposed) {
      return;
    }
    if (id === MAIN_PANE_ID) {
      throw new Error("[carta] removePane: cannot remove the primary pane");
    }
    const pane = this.panesById.get(id);
    if (pane === undefined) {
      return;
    }
    // Destroy series owned by this pane.
    const survivors: Series[] = [];
    for (const s of this.series) {
      const sPane = this.seriesPaneById.get(s) ?? MAIN_PANE_ID;
      if (sPane === id) {
        s.destroy();
        this.seriesPaneById.delete(s);
        this.seriesScaleById.delete(s);
        continue;
      }
      survivors.push(s);
    }
    this.series.length = 0;
    this.series.push(...survivors);
    this.renderer.detachPane(pane);
    pane.destroy();
    this.panesList.splice(this.panesList.indexOf(pane), 1);
    this.panesById.delete(id);
    this.crosshair.releasePaneTag(id);
    this.invalidator.invalidate("layout");
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
    return this.primaryPane().priceAxis?.ticks() ?? [];
  }

  /** Price-label pool capacity (constant after first render). Dev/test introspection. */
  priceAxisPoolSize(): number {
    return this.primaryPane().priceAxis?.poolSize() ?? 0;
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

    // Phase 14 Cycle A — route the series to its target pane + scale slot.
    // Default = primary pane / right scale. Throws if the requested pane id
    // does not exist (host typo / removed pane).
    const paneId = series.paneId ?? MAIN_PANE_ID;
    const pane = this.panesById.get(paneId);
    if (pane === undefined) {
      throw new Error(
        `[carta] addSeries: paneId '${String(paneId)}' does not exist`,
      );
    }
    const scaleId: PriceScaleId = series.priceScaleId ?? "right";
    pane.addSeriesToScale(series, scaleId, series.scaleMargins);
    series.attach(pane.seriesLayer);
    this.series.push(series);
    this.seriesPaneById.set(series, paneId);
    this.seriesScaleById.set(series, scaleId);
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
    const paneId = this.seriesPaneById.get(series) ?? MAIN_PANE_ID;
    const scaleId = this.seriesScaleById.get(series) ?? "right";
    this.panesById.get(paneId)?.removeSeriesFromScale(series, scaleId);
    this.seriesPaneById.delete(series);
    this.seriesScaleById.delete(series);
    series.destroy();
    this.invalidator.invalidate("data");
    return true;
  }

  /**
   * Register a provider for auto-scale reconciliation on the **primary pane's
   * right scale**. Providers added here participate in the same `'right'`
   * slot as series. No-op if already registered. Cycle B may add a
   * pane-aware variant.
   */
  addPriceRangeProvider(provider: PriceRangeProvider): void {
    if (this.disposed) {
      return;
    }
    const slot = this.primaryRightSlotState();
    if (slot.providers.has(provider)) {
      return;
    }
    slot.providers.add(provider);
    if (slot.autoScaleEnabled) {
      this.invalidator.invalidate("viewport");
    }
  }

  removePriceRangeProvider(provider: PriceRangeProvider): void {
    if (this.disposed) {
      return;
    }
    const slot = this.primaryRightSlotState();
    if (!slot.providers.delete(provider)) {
      return;
    }
    if (slot.autoScaleEnabled) {
      this.invalidator.invalidate("viewport");
    }
  }

  /**
   * Manual-domain write entrypoint used by the `PriceAxisController` drag
   * handler. Mutates the primary pane's `'right'` slot in place; `setDomain`
   * via the public facade flips `autoScale` off, so we mirror that here.
   */
  private applyManualDomain(min: Price, max: Price): void {
    this.primaryPane().applyManualDomain("right", { min, max });
    this.invalidator.invalidate("viewport");
  }

  /**
   * Toggle auto-scale on the primary pane's right slot. Public surface goes
   * through the slot's facade (`chart.priceScale().setAutoScale(on)`); the
   * internal call exists so the price-axis controller's gesture-end handler
   * can flip it without re-routing through the facade.
   */
  private setAutoScaleInternal(on: boolean): void {
    if (this.disposed) {
      return;
    }
    const slot = this.primaryRightSlotState();
    if (slot.autoScaleEnabled === on) {
      return;
    }
    slot.autoScaleEnabled = on;
    this.invalidator.invalidate("viewport");
  }

  // ─── Phase 14 Cycle A — primary pane shorthands ─────────────────────────

  /** Read-only domain accessor for the primary pane's right slot. */
  private primaryRightSlotDomain(): PriceDomain {
    return this.primaryPane().priceScale("right").getDomain();
  }

  /** Internal slot state for direct provider-set / autoScale mutation. */
  private primaryRightSlotState(): {
    autoScaleEnabled: boolean;
    readonly providers: Set<PriceRangeProvider>;
  } {
    // Reach into the pane's slot via `ensureSlot` so we get the live state
    // object rather than a snapshot. The cast is internal-only — the public
    // `priceScale` facade is the host-facing surface.
    const slots = this.primaryPane().scales();
    const right = slots.find((s) => s.id === "right");
    if (right === undefined) {
      throw new Error("[carta] primary pane right slot missing");
    }
    return right;
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
    this.paneResizeController.destroy();
    this.crosshair.destroy();
    this.priceAxisController.destroy();
    this.viewport.destroy();
    this.invalidator.dispose();
    this.timeAxis.destroy();
    for (const s of this.series) {
      s.destroy();
    }
    this.series.length = 0;
    this.seriesPaneById.clear();
    this.seriesScaleById.clear();
    for (const pane of this.panesList) {
      pane.destroy();
    }
    this.panesList.length = 0;
    this.panesById.clear();
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

    // Layout panes once per flush (also used by the crosshair fast path).
    const paneRects = this.computePaneRects();
    this.lastPaneRects = paneRects;
    for (let i = 0; i < this.panesList.length; i += 1) {
      const pane = this.panesList[i];
      const rect = paneRects[i];
      if (pane !== undefined && rect !== undefined) {
        pane.applyRect(rect);
      }
    }
    const primaryRect = paneRects[0] ?? { x: 0, y: 0, w: 0, h: 0 };
    const snap = this.config.snapshot;

    // Fast path: pointer moves that only set the `'crosshair'` dirty flag
    // must not redraw series / axes / grid. Uses the current plot rect +
    // scales against the last committed window — no layout work.
    if (reasons.size === 1 && reasons.has("crosshair")) {
      const priceScalesByPane = this.collectPriceScalesByPane();
      this.crosshair.redraw({
        plotRect: primaryRect,
        paneRects: this.paneRectsForCrosshair(paneRects),
        priceScalesByPane,
        timeScale: this.currentTimeScaleForRect(primaryRect),
        priceScale: this.primaryPane().currentPriceScaleForSlot("right"),
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
    // anchor through the new scales BEFORE the crosshair redraws.
    if (
      this.trackingActive &&
      this.trackingAnchor !== null &&
      (reasons.has("viewport") || reasons.has("size") || reasons.has("layout") || reasons.has("data"))
    ) {
      this.reprojectTrackingAnchor();
    }

    this.renderer.renderFrame(snap.theme, snap.width, snap.height, paneRects);
    this.paneResizeController.render(snap.theme);
    // Reconcile each pane's scales (auto-scale → lastRenderedDomain).
    const winStart = Number(snap.startTime);
    const winEnd = Number(snap.endTime);
    for (const pane of this.panesList) {
      pane.reconcileEachScale(winStart, winEnd);
    }
    this.priceAxisController.syncHitArea();
    const timeScale = this.currentTimeScaleForRect(primaryRect);

    if (
      this.series.length > 0 &&
      (reasons.has("data") ||
        reasons.has("viewport") ||
        reasons.has("size") ||
        reasons.has("layout") ||
        reasons.has("theme"))
    ) {
      for (const s of this.series) {
        const paneId = this.seriesPaneById.get(s) ?? MAIN_PANE_ID;
        const scaleId = this.seriesScaleById.get(s) ?? "right";
        const pane = this.panesById.get(paneId);
        if (pane === undefined) {
          continue;
        }
        const paneRect = pane.getRect();
        const ctx: SeriesRenderContext = {
          startTime: snap.startTime,
          endTime: snap.endTime,
          intervalDuration: snap.intervalDuration,
          plotWidth: paneRect.w,
          plotHeight: paneRect.h,
          timeScale,
          priceScale: pane.currentPriceScaleForSlot(scaleId),
          dataStore: this.dataStore,
          theme: snap.theme,
        };
        s.render(ctx);
        this.seriesRenderCounter += 1;
      }
    }

    // Drawings are pinned to the primary pane in cycle A — cycle B opens
    // them up to non-primary panes via the anchor's `paneId` field.
    if (
      reasons.has("drawings") ||
      reasons.has("viewport") ||
      reasons.has("size") ||
      reasons.has("layout") ||
      reasons.has("theme")
    ) {
      this.drawingsController.render({
        plotRect: primaryRect,
        timeScale,
        priceScale: this.primaryPane().currentPriceScaleForSlot("right"),
        theme: snap.theme,
        dpr: this.currentResolution,
      });
    }

    // Time axis renders against the bottom of the entire pane stack so its
    // labels sit in the bottom margin — single-pane invocation matches the
    // prior `plotRect` shape exactly.
    const stackRect: PlotRect = paneStackBottomRect(primaryRect, paneRects);
    this.timeAxis.render(timeScale, stackRect, snap.theme);

    // Per-pane price axes — each pane owns its own labels.
    for (const pane of this.panesList) {
      pane.renderPriceAxis(snap.theme, this.priceFormatter, this.opts.logger);
    }

    if (
      reasons.has("crosshair") ||
      reasons.has("viewport") ||
      reasons.has("data") ||
      reasons.has("layout") ||
      reasons.has("size") ||
      reasons.has("theme")
    ) {
      this.crosshair.redraw({
        plotRect: primaryRect,
        paneRects: this.paneRectsForCrosshair(paneRects),
        priceScalesByPane: this.collectPriceScalesByPane(),
        timeScale,
        priceScale: this.primaryPane().currentPriceScaleForSlot("right"),
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

  /** Pane-aware `priceScalesByPane` snapshot — primary pane's right scale only. */
  private collectPriceScalesByPane(): ReadonlyMap<PaneId, PriceScale> {
    const out = new Map<PaneId, PriceScale>();
    for (const pane of this.panesList) {
      out.set(pane.id, pane.currentPriceScaleForSlot("right"));
    }
    return out;
  }

  private paneRectsForCrosshair(rects: readonly PaneRect[]): readonly { id: PaneId; rect: PaneRect }[] {
    const out: { id: PaneId; rect: PaneRect }[] = [];
    for (let i = 0; i < this.panesList.length; i += 1) {
      const pane = this.panesList[i];
      const rect = rects[i];
      if (pane === undefined || rect === undefined) {
        continue;
      }
      out.push({ id: pane.id, rect });
    }
    return out;
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

  /**
   * Phase 14 Cycle A — read the primary pane's right scale at the current
   * primary pane rect height. Used by `dataAnchorAtLocalPixel` and
   * `reprojectTrackingAnchor` for tracking-mode reprojection.
   */
  private currentPriceScaleForRect(_plotRect: PlotRect): PriceScale {
    return this.primaryPane().currentPriceScaleForSlot("right");
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

  /**
   * Phase 14 Cycle A — primary pane plot rect. Single-pane charts: returns
   * the same shape as the legacy `computePlotRect`. Multi-pane charts:
   * returns the primary pane's rect computed by `PaneLayout`.
   */
  private computePlotRect(): PlotRect {
    const rects = this.computePaneRects();
    return rects[0] ?? { x: 0, y: 0, w: 0, h: 0 };
  }

  /**
   * Phase 14 Cycle A — distribute the chart canvas across panes. Panes
   * occupy the canvas minus `BOTTOM_MARGIN` (time-axis gutter) and minus
   * `PRICE_AXIS_STRIP_WIDTH` on the right (each pane's PriceAxis renders
   * inside its own subtree, so the rect's `w` is canvas - strip).
   */
  private computePaneRects(): PaneRect[] {
    const { width, height } = this.config.snapshot;
    const usableW = Math.max(0, width - PRICE_AXIS_STRIP_WIDTH);
    const inputs: PaneLayoutInput[] = this.panesList.map((p) => ({
      stretchFactor: p.stretchFactor,
      minHeight: p.minHeight,
      hidden: p.hidden,
      heightOverride: p.heightOverride,
    }));
    return computePaneRects(usableW, height, inputs, {
      bottomMargin: BOTTOM_MARGIN,
      minHeight: 50,
    });
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

/**
 * Phase 14 Cycle A — short stable suffix for auto-generated `PaneId`s. Uses
 * `crypto.randomUUID()` when available, falls back to a monotonic counter
 * for environments without WebCrypto.
 */
let __paneIdCounter = 0;
function generatePaneIdSuffix(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) {
    return c.randomUUID().slice(0, 8);
  }
  __paneIdCounter += 1;
  return `auto${String(__paneIdCounter)}`;
}

/**
 * Phase 14 Cycle A — shape passed to `TimeAxis.render`. `x` matches the
 * primary pane's `x` (= 0), `w` matches the primary pane's `w` (= canvas −
 * price-axis strip), `y + h` lands at the bottom of the bottom-most pane so
 * tick labels render in the bottom-margin gutter.
 */
function paneStackBottomRect(primary: PlotRect, rects: readonly PaneRect[]): PlotRect {
  if (rects.length === 0) {
    return primary;
  }
  const last = rects[rects.length - 1] ?? primary;
  return {
    x: primary.x,
    y: primary.y,
    w: primary.w,
    h: Math.max(0, last.y + last.h - primary.y),
  };
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
