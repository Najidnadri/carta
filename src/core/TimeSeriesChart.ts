import type { GraphicsContext } from "pixi.js";
import { ConfigState } from "./ConfigState.js";
import { InvalidationQueue, type DirtyReason } from "./InvalidationQueue.js";
import { noopLogger } from "./Logger.js";
import { Renderer, type PlotRect } from "./Renderer.js";
import {
  asInterval,
  asTime,
  DEFAULT_THEME,
  type Interval,
  type Logger,
  type Theme,
  type Time,
  type TimeSeriesChartOptions,
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
}

/**
 * Top-level chart class. Phase 01 surface: create / resize / destroy.
 *
 * React Strict Mode (double-mount) pattern:
 * ```
 * let cancelled = false;
 * let chart: TimeSeriesChart | null = null;
 * (async () => {
 *   const c = await TimeSeriesChart.create({ ... });
 *   if (cancelled) { c.destroy(); return; }
 *   chart = c;
 * })();
 * return () => { cancelled = true; chart?.destroy(); };
 * ```
 */
export class TimeSeriesChart {
  private readonly opts: ResolvedOptions;
  private readonly renderer: Renderer;
  private readonly invalidator: InvalidationQueue;
  private readonly sharedContexts: GraphicsContext[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private config: ConfigState;
  private disposed = false;

  private constructor(opts: ResolvedOptions, renderer: Renderer, config: ConfigState) {
    this.opts = opts;
    this.renderer = renderer;
    this.config = config;
    this.invalidator = new InvalidationQueue((reasons) => this.flush(reasons));
  }

  static async create(options: TimeSeriesChartOptions): Promise<TimeSeriesChart> {
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
      logger: options.logger ?? noopLogger,
    };

    const renderer = await Renderer.create({
      container: resolved.container,
      width: resolved.width,
      height: resolved.height,
      background: theme.background,
      devicePixelRatio: resolved.devicePixelRatio,
    });

    const config = new ConfigState({
      startTime: toBrandedTime(options.startTime),
      endTime: toBrandedTime(options.endTime),
      intervalDuration: toBrandedInterval(options.intervalDuration),
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
    this.invalidator.invalidate("size");
  }

  destroy(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.invalidator.dispose();
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
    this.renderer.render();
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

function toBrandedTime(value: Time | number): Time {
  return asTime(typeof value === "number" ? value : (value as unknown as number));
}

function toBrandedInterval(value: Interval | number): Interval {
  return asInterval(typeof value === "number" ? value : (value as unknown as number));
}
