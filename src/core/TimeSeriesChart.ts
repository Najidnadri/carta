import type { GraphicsContext } from "pixi.js";
import { ConfigState } from "./ConfigState.js";
import { DataStore } from "./DataStore.js";
import { InvalidationQueue, type DirtyReason } from "./InvalidationQueue.js";
import { noopLogger } from "./Logger.js";
import {
  defaultPriceFormatter,
  PRICE_AXIS_STRIP_WIDTH,
  PriceAxis,
} from "./PriceAxis.js";
import type { PriceTickInfo } from "./PriceAxis.js";
import {
  PriceAxisController,
  type PriceAxisDragOptions,
} from "./PriceAxisController.js";
import {
  reducePriceRanges,
  type PriceRange,
  type PriceRangeProvider,
} from "./PriceRangeProvider.js";
import { PriceScale } from "./PriceScale.js";
import { Renderer, type PlotRect } from "./Renderer.js";
import { TimeAxis, type TimeAxisOptions } from "./TimeAxis.js";
import type { TickInfo } from "./TimeAxis.js";
import { TimeScale } from "./TimeScale.js";
import { ViewportController } from "./ViewportController.js";
import {
  asInterval,
  asPrice,
  asTime,
  DEFAULT_THEME,
  type ApplyOptions,
  type CacheStats,
  type Channel,
  type ChartWindow,
  type ClearCacheOptions,
  type DataOptions,
  type DataRecord,
  type Interval,
  type Logger,
  type MissingRangesQuery,
  type Price,
  type PriceAxisOptions,
  type PriceDomain,
  type PriceFormatter,
  type PriceScaleFacade,
  type PriceScaleMargins,
  type PriceScaleOptions,
  type Range,
  type Theme,
  type Time,
  type TimeSeriesChartOptions,
  type ViewportOptions,
} from "../types.js";

const BOTTOM_MARGIN = 28;

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
}

export interface TimeSeriesChartConstructionOptions extends TimeSeriesChartOptions {
  readonly timeAxis?: TimeAxisOptions;
  readonly priceAxisDrag?: PriceAxisDragOptions;
}

const DEFAULT_DOMAIN_MIN = 0;
const DEFAULT_DOMAIN_MAX = 1;

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
  private readonly dataStore: DataStore;
  private resizeObserver: ResizeObserver | null = null;
  private config: ConfigState;
  private disposed = false;

  private priceDomain: PriceDomain;
  private autoScaleEnabled = false;
  private lastRenderedDomain: PriceDomain;
  private readonly priceRangeProviders = new Set<PriceRangeProvider>();
  private priceFormatter: PriceFormatter;
  private readonly priceScaleFacade: PriceScaleFacade;

  private constructor(opts: ResolvedOptions, renderer: Renderer, config: ConfigState) {
    this.opts = opts;
    this.renderer = renderer;
    this.config = config;
    this.dataStore =
      opts.data === undefined
        ? new DataStore({ logger: opts.logger })
        : new DataStore({ logger: opts.logger, options: opts.data });
    this.invalidator = new InvalidationQueue((reasons) => this.flush(reasons));
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
      setDomain: (min, max): void => this.setPriceDomain(min, max),
      getDomain: (): PriceDomain => this.lastRenderedDomain,
      isAutoScale: (): boolean => this.autoScaleEnabled,
      setAutoScale: (on: boolean): void => this.setAutoScaleInternal(on),
    };
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
      applyWindow: (win: ChartWindow): void => this.applyWindowInternal(win),
      plotRect: (): PlotRect => this.computePlotRect(),
      options: opts.viewport,
    });
    this.priceAxisController = new PriceAxisController({
      axesLayer: renderer.axesLayer,
      plotRect: (): PlotRect => this.computePlotRect(),
      getRenderedDomain: (): PriceDomain => this.lastRenderedDomain,
      setManualDomain: (min, max): void => this.applyManualDomain(min, max),
      setAutoScale: (on): void => this.setAutoScaleInternal(on),
      onGestureStart: (): void => this.viewport.stopKinetic(),
      options: opts.priceAxisDrag,
    });
  }

  static async create(options: TimeSeriesChartConstructionOptions): Promise<TimeSeriesChart> {
    const logger = options.logger ?? noopLogger;
    const theme: Theme = {
      ...DEFAULT_THEME,
      ...(options.theme ?? {}),
    };

    const containerWidth = options.container.clientWidth;
    const containerHeight = options.container.clientHeight;
    const resolved: ResolvedOptions = {
      container: options.container,
      width: options.width ?? (containerWidth > 0 ? containerWidth : 800),
      height: options.height ?? (containerHeight > 0 ? containerHeight : 400),
      autoResize: options.autoResize ?? true,
      devicePixelRatio:
        options.devicePixelRatio ??
        (typeof globalThis.window === "undefined" ? 1 : globalThis.window.devicePixelRatio || 1),
      theme,
      logger,
      timeAxis: options.timeAxis,
      viewport: options.viewport,
      priceScale: options.priceScale,
      priceAxis: options.priceAxis,
      priceAxisDrag: options.priceAxisDrag,
      priceFormatter: options.priceFormatter ?? defaultPriceFormatter,
      data: options.data,
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
    });

    const chart = new TimeSeriesChart(resolved, renderer, config);

    if (resolved.autoResize && typeof ResizeObserver !== "undefined") {
      chart.resizeObserver = new ResizeObserver(() => chart.onAutoResize());
      chart.resizeObserver.observe(resolved.container);
    }

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
  }

  setWindow(win: ChartWindow): void {
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
    const { startTime, endTime } = this.config.snapshot;
    return Object.freeze({ startTime, endTime });
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
    this.invalidator.invalidate("viewport");
    this.invalidator.invalidate("data");
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
  supplyData<R extends DataRecord>(
    channelId: string,
    intervalDuration: Interval | number,
    records: readonly R[],
  ): void {
    if (this.disposed) {
      return;
    }
    const raw = Number(intervalDuration);
    if (!Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) {
      this.opts.logger.warn(
        `[carta] supplyData received invalid intervalDuration (${String(intervalDuration)}) — must be a positive integer; ignored`,
      );
      return;
    }
    this.dataStore.insertMany<R>(channelId, raw, records);
    this.invalidator.invalidate("data");
  }

  /**
   * Single-record live update. Defaults `intervalDuration` to the chart's
   * current interval. Validation + kind enforcement match `supplyData`.
   */
  supplyTick<R extends DataRecord>(
    channelId: string,
    record: R,
    intervalDuration?: Interval | number,
  ): void {
    if (this.disposed) {
      return;
    }
    const resolved = intervalDuration ?? this.config.snapshot.intervalDuration;
    const raw = Number(resolved);
    if (!Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) {
      this.opts.logger.warn(
        `[carta] supplyTick received invalid intervalDuration (${String(resolved)}) — must be a positive integer; ignored`,
      );
      return;
    }
    this.dataStore.insert<R>(channelId, raw, record);
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
  recordsInRange<R extends DataRecord>(
    channelId: string,
    intervalDuration: Interval | number,
    startTime: Time | number,
    endTime: Time | number,
  ): readonly R[] {
    return this.dataStore.recordsInRange<R>(
      channelId,
      Number(intervalDuration),
      Number(startTime),
      Number(endTime),
    );
  }

  /**
   * Sub-windows of `[startTime, endTime]` that have no cached records on
   * this channel. Defaults to the chart's current window + interval. Marker
   * channels always return `[]`.
   */
  missingRanges(channelId: string, query?: MissingRangesQuery): readonly Range[] {
    const snap = this.config.snapshot;
    const startRaw = Number(query?.startTime ?? snap.startTime);
    const endRaw = Number(query?.endTime ?? snap.endTime);
    const ivRaw = Number(query?.intervalDuration ?? snap.intervalDuration);
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

  private applyWindowInternal(win: ChartWindow): void {
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

  destroy(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.priceAxisController.destroy();
    this.viewport.destroy();
    this.invalidator.dispose();
    this.timeAxis.destroy();
    this.priceAxis.destroy();
    this.priceRangeProviders.clear();
    this.dataStore.clearAll();
    for (const ctx of this.sharedContexts) {
      ctx.destroy();
    }
    this.sharedContexts.length = 0;
    this.renderer.destroy();
  }

  private flush(_reasons: ReadonlySet<DirtyReason>): void {
    if (this.disposed) {
      return;
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
    this.timeAxis.render(scale, plotRect, this.config.snapshot.theme);
    const priceScale = this.currentPriceScaleForRect(plotRect);
    this.priceAxis.render(
      priceScale,
      plotRect,
      this.config.snapshot.theme,
      this.priceFormatter,
      this.opts.logger,
    );
    this.renderer.render();
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
