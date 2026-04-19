import { Renderer } from "./Renderer.js";
import { TimeScale } from "../scales/TimeScale.js";
import { LinearScale } from "../scales/LinearScale.js";
import { PriceAxis } from "../axes/PriceAxis.js";
import { TimeAxis } from "../axes/TimeAxis.js";
import type { Series } from "../series/Series.js";
import type { ChartOptions } from "../types.js";
import { DEFAULT_THEME } from "../types.js";

interface ResolvedOptions {
  container: HTMLElement;
  width: number;
  height: number;
  background: number;
  autoResize: boolean;
  devicePixelRatio: number;
}

export class Chart {
  private renderer!: Renderer;
  private readonly options: ResolvedOptions;
  private readonly xScale = new TimeScale();
  private readonly yScale = new LinearScale();
  private readonly priceAxis = new PriceAxis();
  private readonly timeAxis = new TimeAxis();
  private readonly seriesList: Series[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private rafHandle = 0;
  private disposed = false;

  private constructor(options: ResolvedOptions) {
    this.options = options;
  }

  static async create(options: ChartOptions): Promise<Chart> {
    const resolved: ResolvedOptions = {
      container: options.container,
      width: options.width ?? (options.container.clientWidth || 800),
      height: options.height ?? (options.container.clientHeight || 400),
      background: options.background ?? DEFAULT_THEME.background,
      autoResize: options.autoResize ?? true,
      devicePixelRatio: options.devicePixelRatio ?? (window.devicePixelRatio || 1),
    };

    const chart = new Chart(resolved);
    chart.renderer = await Renderer.create({
      container: resolved.container,
      width: resolved.width,
      height: resolved.height,
      background: resolved.background,
      devicePixelRatio: resolved.devicePixelRatio,
    });
    chart.renderer.axesLayer.addChild(chart.priceAxis.container, chart.timeAxis.container);

    if (resolved.autoResize && typeof ResizeObserver !== "undefined") {
      chart.resizeObserver = new ResizeObserver(() => chart.handleAutoResize());
      chart.resizeObserver.observe(resolved.container);
    }

    return chart;
  }

  addSeries(series: Series): void {
    this.seriesList.push(series);
    this.renderer.seriesLayer.addChild(series.container);
    this.fitContent();
    this.requestDraw();
  }

  removeSeries(series: Series): void {
    const idx = this.seriesList.indexOf(series);
    if (idx === -1) {
      return;
    }
    this.seriesList.splice(idx, 1);
    this.renderer.seriesLayer.removeChild(series.container);
    series.destroy();
    this.requestDraw();
  }

  fitContent(): void {
    let tMin = Infinity;
    let tMax = -Infinity;
    let pMin = Infinity;
    let pMax = -Infinity;

    for (const s of this.seriesList) {
      const tr = s.timeRange();
      const pr = s.priceRange();
      if (tr !== null) {
        if (tr.min < tMin) {
          tMin = tr.min;
        }
        if (tr.max > tMax) {
          tMax = tr.max;
        }
      }
      if (pr !== null) {
        if (pr.min < pMin) {
          pMin = pr.min;
        }
        if (pr.max > pMax) {
          pMax = pr.max;
        }
      }
    }

    if (Number.isFinite(tMin) && Number.isFinite(tMax) && tMax > tMin) {
      this.xScale.setTimeDomain(tMin, tMax);
    }
    if (Number.isFinite(pMin) && Number.isFinite(pMax) && pMax > pMin) {
      const pad = (pMax - pMin) * 0.05;
      this.yScale.setDomain(pMin - pad, pMax + pad);
    }
  }

  resize(width: number, height: number): void {
    this.options.width = width;
    this.options.height = height;
    this.renderer.resize(width, height);
    this.requestDraw();
  }

  requestDraw(): void {
    if (this.disposed || this.rafHandle !== 0) {
      return;
    }
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0;
      this.draw();
    });
  }

  destroy(): void {
    this.disposed = true;
    if (this.rafHandle !== 0) {
      cancelAnimationFrame(this.rafHandle);
    }
    this.resizeObserver?.disconnect();
    for (const s of this.seriesList) {
      s.destroy();
    }
    this.seriesList.length = 0;
    this.renderer.destroy();
  }

  private draw(): void {
    const rightPadding = 64;
    const bottomPadding = 28;
    const plotWidth = this.options.width - rightPadding;
    const plotHeight = this.options.height - bottomPadding;

    this.xScale.setRange(0, plotWidth);
    this.yScale.setRange(plotHeight, 0);

    this.priceAxis.render(this.yScale, plotWidth, plotHeight);
    this.timeAxis.render(this.xScale, plotWidth, plotHeight);

    for (const s of this.seriesList) {
      s.render({ xScale: this.xScale, yScale: this.yScale, width: plotWidth, height: plotHeight });
    }
  }

  private handleAutoResize(): void {
    const el = this.options.container;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w > 0 && h > 0 && (w !== this.options.width || h !== this.options.height)) {
      this.resize(w, h);
    }
  }
}
