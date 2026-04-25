import type { PriceRange } from "./PriceRangeProvider.js";
import { Series, type SeriesRenderContext } from "./Series.js";
import { ShapePool } from "./ShapePool.js";
import {
  asPrice,
  type DataRecord,
  type HistogramSeriesOptions,
  type PointRecord,
  type Theme,
  type Time,
} from "../types.js";

const DEFAULT_BAR_FILL_FRACTION = 0.8;
const DEFAULT_BASE = 0;
const MIN_HALF_WIDTH_PX = 1;
const MIN_BAR_HEIGHT_PX = 1;

function isFinitePoint(r: DataRecord): r is PointRecord {
  if (!("value" in r)) {
    return false;
  }
  return Number.isFinite(Number(r.value));
}

function resolveBarColor(
  record: PointRecord,
  seriesDefault: number,
  theme: Theme,
): number {
  const raw = record.color;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  if (Number.isFinite(seriesDefault) && seriesDefault >= 0) {
    return seriesDefault;
  }
  return theme.line;
}

/**
 * Point-channel histogram series: one pool-backed rectangle per visible
 * point, growing from a configurable `base` price (default 0) to
 * `record.value`. Supports per-record `color` override so volume bars can
 * be green/red-coloured by the host when supplying data. Non-finite or
 * negative colour values fall back to the series default, then the theme.
 *
 * Renders bars in the window ±1 interval to avoid edge-clipped columns
 * during a pan (matches candle/line behaviour).
 */
export class HistogramSeries extends Series {
  private readonly pool: ShapePool;
  private opts: HistogramSeriesOptions;

  constructor(options: HistogramSeriesOptions) {
    super(options.channel, "point", `HistogramSeries(${options.channel})`);
    this.opts = options;
    this.pool = new ShapePool(this.container);
  }

  applyOptions(patch: Partial<HistogramSeriesOptions>): void {
    this.opts = this.mergeOptions(this.opts, patch);
    // Flipping `participatesInAutoScale` correctly re-fires auto-scale via
    // the chart's `'data'` invalidation — `priceRangeInWindow` is re-polled
    // on the next flush.
    this.requestInvalidate();
  }

  priceRangeInWindow(startTime: Time, endTime: Time): PriceRange | null {
    if (this.query === null) {
      return null;
    }
    if (this.opts.participatesInAutoScale === false) {
      return null;
    }
    const start = Number(startTime);
    const end = Number(endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      return null;
    }
    const iv = this.query.getInterval();
    if (!Number.isFinite(iv) || iv <= 0) {
      return null;
    }
    const records = this.query.dataStore.recordsInRange(this.channel, iv, start, end);
    if (records.length === 0) {
      return null;
    }
    const base = this.opts.base ?? DEFAULT_BASE;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    let sawFinite = false;
    for (const r of records) {
      if (!isFinitePoint(r)) {
        continue;
      }
      sawFinite = true;
      const v = Number(r.value);
      if (v < lo) {
        lo = v;
      }
      if (v > hi) {
        hi = v;
      }
    }
    if (!sawFinite) {
      return null;
    }
    if (base < lo) {
      lo = base;
    }
    if (base > hi) {
      hi = base;
    }
    return { min: asPrice(lo), max: asPrice(hi) };
  }

  render(ctx: SeriesRenderContext): void {
    this.pool.releaseAll();
    const iv = Number(ctx.intervalDuration);
    if (!Number.isFinite(iv) || iv <= 0) {
      return;
    }
    const start = Number(ctx.startTime);
    const end = Number(ctx.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      return;
    }
    const queryStart = start - iv;
    const queryEnd = end + iv;
    const records = ctx.dataStore.recordsInRange(this.channel, iv, queryStart, queryEnd);
    if (records.length === 0) {
      return;
    }

    const base = this.opts.base ?? DEFAULT_BASE;
    const yBase = Number(ctx.priceScale.valueToPixel(asPrice(base)));
    if (!Number.isFinite(yBase)) {
      return;
    }
    const seriesDefault = this.opts.color ?? ctx.theme.line;
    const spacing = ctx.timeScale.barSpacingPx;
    const half = Math.max(
      MIN_HALF_WIDTH_PX,
      Math.floor((spacing * DEFAULT_BAR_FILL_FRACTION) / 2),
    );

    for (const r of records) {
      if (!isFinitePoint(r)) {
        continue;
      }
      const x = Math.round(Number(ctx.timeScale.timeToPixel(r.time)));
      const yValue = Number(ctx.priceScale.valueToPixel(r.value));
      if (!Number.isFinite(yValue)) {
        continue;
      }
      const top = Math.min(yBase, yValue);
      const height = Math.max(MIN_BAR_HEIGHT_PX, Math.abs(yValue - yBase));
      const color = resolveBarColor(r, seriesDefault, ctx.theme);
      const g = this.pool.acquire();
      g.clear();
      g.rect(x - half, top, half * 2, height).fill(color);
    }
  }

  /** Dev / test introspection: number of pool slots currently drawing a bar. */
  activePoolSize(): number {
    return this.pool.activeCount();
  }

  /** Dev / test introspection: high-water-mark of the pool. */
  totalPoolSize(): number {
    return this.pool.totalCount();
  }

  destroy(): void {
    this.pool.destroy();
    super.destroy();
  }
}

export const __internals__ = { resolveBarColor };
