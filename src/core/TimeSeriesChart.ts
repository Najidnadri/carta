import type { GraphicsContext } from "pixi.js";
import { ConfigState } from "./ConfigState.js";
import { InvalidationQueue, type DirtyReason } from "./InvalidationQueue.js";
import { noopLogger } from "./Logger.js";
import { Renderer, type PlotRect } from "./Renderer.js";
import { TimeAxis, type TimeAxisOptions } from "./TimeAxis.js";
import type { TickInfo } from "./TimeAxis.js";
import { TimeScale } from "./TimeScale.js";
import { ViewportController } from "./ViewportController.js";
import {
  asInterval,
  asTime,
  DEFAULT_THEME,
  type ChartWindow,
  type Interval,
  type Logger,
  type Theme,
  type Time,
  type TimeSeriesChartOptions,
  type ViewportOptions,
} from "../types.js";

const RIGHT_MARGIN = 64;
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
}

export interface TimeSeriesChartConstructionOptions extends TimeSeriesChartOptions {
  readonly timeAxis?: TimeAxisOptions;
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
  private resizeObserver: ResizeObserver | null = null;
  private config: ConfigState;
  private disposed = false;

  private constructor(opts: ResolvedOptions, renderer: Renderer, config: ConfigState) {
    this.opts = opts;
    this.renderer = renderer;
    this.config = config;
    this.invalidator = new InvalidationQueue((reasons) => this.flush(reasons));
    this.timeAxis = new TimeAxis(renderer.gridLayer, renderer.axesLayer, opts.timeAxis);
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

  /** Dev/test hook: whether the kinetic-scroll RAF is currently running. */
  isKineticActive(): boolean {
    return this.viewport.isKineticActive();
  }

  /** Dev/test hook: cancel any in-flight kinetic-scroll fling. */
  stopKinetic(): void {
    this.viewport.stopKinetic();
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
    this.viewport.destroy();
    this.invalidator.dispose();
    this.timeAxis.destroy();
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
    const scale = this.currentTimeScaleForRect(plotRect);
    this.timeAxis.render(scale, plotRect, this.config.snapshot.theme);
    this.renderer.render();
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
      w: Math.max(0, width - RIGHT_MARGIN),
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
