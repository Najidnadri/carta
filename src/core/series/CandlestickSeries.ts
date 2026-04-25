import { drawCandleGlyph } from "./candleGlyph.js";
import type { PriceRange } from "../price/PriceRangeProvider.js";
import { Series, type SeriesRenderContext } from "./Series.js";
import { ShapePool } from "../render/ShapePool.js";
import {
  asPrice,
  type CandlestickSeriesOptions,
  type DataRecord,
  type OhlcRecord,
  type Time,
} from "../../types.js";

const DEFAULT_WICK_WIDTH = 1;
const DEFAULT_BODY_GAP_PX = 1;
const MIN_HALF_WIDTH_PX = 1;
const BODY_FILL_FRACTION = 0.7;

function isFiniteOhlc(r: DataRecord): r is OhlcRecord {
  if (!("open" in r) || !("high" in r) || !("low" in r) || !("close" in r)) {
    return false;
  }
  const { open, high, low, close } = r;
  return (
    Number.isFinite(Number(open)) &&
    Number.isFinite(Number(high)) &&
    Number.isFinite(Number(low)) &&
    Number.isFinite(Number(close))
  );
}

/**
 * Pool-backed candlestick series. Body = rect from min(open,close) to
 * max(open,close), wick = line from low to high. Bar color picks from the
 * theme by default (`theme.up` / `theme.down`) — override per-instance via
 * `upColor` / `downColor`. Non-finite OHLC records are silently skipped.
 *
 * Renders bars in the window ±1 interval so partial bars at the viewport
 * edge keep their wicks. `plotClip` on the renderer handles overpaint.
 */
export class CandlestickSeries extends Series {
  private readonly pool: ShapePool;
  private opts: CandlestickSeriesOptions;

  constructor(options: CandlestickSeriesOptions) {
    super(options.channel, "ohlc", `CandlestickSeries(${options.channel})`);
    this.opts = options;
    this.pool = new ShapePool(this.container);
  }

  applyOptions(patch: Partial<CandlestickSeriesOptions>): void {
    this.opts = this.mergeOptions(this.opts, patch);
    this.requestInvalidate();
  }

  priceRangeInWindow(startTime: Time, endTime: Time): PriceRange | null {
    if (this.query === null) {
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
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const r of records) {
      if (!isFiniteOhlc(r)) {
        continue;
      }
      const low = Number(r.low);
      const high = Number(r.high);
      if (low < lo) {
        lo = low;
      }
      if (high > hi) {
        hi = high;
      }
    }
    if (lo === Number.POSITIVE_INFINITY || hi === Number.NEGATIVE_INFINITY) {
      return null;
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
    const records = ctx.dataStore.recordsInRange(
      this.channel,
      iv,
      queryStart,
      queryEnd,
    );
    if (records.length === 0) {
      return;
    }
    const upColor = this.opts.upColor ?? ctx.theme.up;
    const downColor = this.opts.downColor ?? ctx.theme.down;
    const wickWidth = this.opts.wickWidth ?? DEFAULT_WICK_WIDTH;
    const bodyGap = this.opts.bodyGapPx ?? DEFAULT_BODY_GAP_PX;
    const spacing = ctx.timeScale.barSpacingPx;
    const half = Math.max(
      MIN_HALF_WIDTH_PX,
      Math.floor((spacing * BODY_FILL_FRACTION - bodyGap) / 2),
    );
    for (const r of records) {
      if (!isFiniteOhlc(r)) {
        continue;
      }
      const open = Number(r.open);
      const close = Number(r.close);
      const x = Math.round(Number(ctx.timeScale.timeToPixel(r.time)));
      const yOpen = Number(ctx.priceScale.valueToPixel(r.open));
      const yClose = Number(ctx.priceScale.valueToPixel(r.close));
      const yHigh = Number(ctx.priceScale.valueToPixel(r.high));
      const yLow = Number(ctx.priceScale.valueToPixel(r.low));
      if (
        !Number.isFinite(yOpen) ||
        !Number.isFinite(yClose) ||
        !Number.isFinite(yHigh) ||
        !Number.isFinite(yLow)
      ) {
        continue;
      }
      const color = close >= open ? upColor : downColor;
      const g = this.pool.acquire();
      g.clear();
      drawCandleGlyph(g, {
        x,
        yOpen,
        yClose,
        yHigh,
        yLow,
        color,
        wickWidth,
        half,
      });
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
