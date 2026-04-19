import { drawCandleGlyph } from "./candleGlyph.js";
import { computeHeikinAshi, type HeikinAshiBar } from "./heikinAshi.js";
import type { PriceRange } from "./PriceRangeProvider.js";
import { Series, type SeriesQueryContext, type SeriesRenderContext } from "./Series.js";
import { ShapePool } from "./ShapePool.js";
import {
  asPrice,
  type DataRecord,
  type HeikinAshiSeriesOptions,
  type OhlcRecord,
  type Time,
} from "../types.js";

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
 * Pool-backed Heikin-Ashi series. Derives HA (open, high, low, close) from
 * the channel's OHLC records during `render`, caches the derived bars by
 * `time`, and reuses the cache while `dataStore.revision(channel, iv)` is
 * stable. Any mutation to the source channel (insert, clear, eviction)
 * bumps the revision, so the next render clears + recomputes forward from
 * the earliest visible bar.
 *
 * The seed is `HA_open[0] = (O[0] + C[0]) / 2` where `0` is the earliest
 * bar in the computed output — when hosts supply a truncated history the
 * HA values are approximate vs. the channel's true origin. Matches
 * industry practice (TradingView / Lightweight-Charts behave the same).
 *
 * Non-finite OHLC records are skipped without advancing HA state.
 */
export class HeikinAshiSeries extends Series {
  private readonly pool: ShapePool;
  private readonly opts: HeikinAshiSeriesOptions;
  private readonly cache = new Map<number, HeikinAshiBar>();
  private lastRevision = -1;
  private lastInterval = -1;

  constructor(options: HeikinAshiSeriesOptions) {
    super(options.channel, "ohlc", `HeikinAshiSeries(${options.channel})`);
    this.opts = options;
    this.pool = new ShapePool(this.container);
  }

  setQueryContext(query: SeriesQueryContext): void {
    super.setQueryContext(query);
    this.invalidateCache();
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
    this.syncCache(iv);
    if (this.cache.size === 0) {
      return null;
    }
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const ha of this.cache.values()) {
      const t = Number(ha.time);
      if (t < start || t > end) {
        continue;
      }
      const haLow = Number(ha.low);
      const haHigh = Number(ha.high);
      if (haLow < lo) {
        lo = haLow;
      }
      if (haHigh > hi) {
        hi = haHigh;
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
    this.syncCache(iv);
    if (this.cache.size === 0) {
      return;
    }
    const queryStart = start - iv;
    const queryEnd = end + iv;
    const upColor = this.opts.upColor ?? ctx.theme.up;
    const downColor = this.opts.downColor ?? ctx.theme.down;
    const wickWidth = this.opts.wickWidth ?? DEFAULT_WICK_WIDTH;
    const bodyGap = this.opts.bodyGapPx ?? DEFAULT_BODY_GAP_PX;
    const spacing = ctx.timeScale.barSpacingPx;
    const half = Math.max(
      MIN_HALF_WIDTH_PX,
      Math.floor((spacing * BODY_FILL_FRACTION - bodyGap) / 2),
    );
    for (const ha of this.cache.values()) {
      const t = Number(ha.time);
      if (t < queryStart || t > queryEnd) {
        continue;
      }
      const open = Number(ha.open);
      const close = Number(ha.close);
      const x = Math.round(Number(ctx.timeScale.timeToPixel(ha.time)));
      const yOpen = Number(ctx.priceScale.valueToPixel(ha.open));
      const yClose = Number(ctx.priceScale.valueToPixel(ha.close));
      const yHigh = Number(ctx.priceScale.valueToPixel(ha.high));
      const yLow = Number(ctx.priceScale.valueToPixel(ha.low));
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

  /** Dev / test introspection: number of cached HA bars. */
  cacheSize(): number {
    return this.cache.size;
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
    this.invalidateCache();
    super.destroy();
  }

  /**
   * Recompute the HA cache if the source channel's revision has moved or
   * the interval has changed. On `setInterval`, the DataStore wipes the
   * previous-interval bucket and the new interval starts at revision 0 —
   * we detect both by tracking `(interval, revision)` as the cache key.
   */
  private syncCache(iv: number): void {
    if (this.query === null) {
      return;
    }
    const rev = this.query.dataStore.revision(this.channel, iv);
    if (iv === this.lastInterval && rev === this.lastRevision) {
      return;
    }
    this.cache.clear();
    this.lastInterval = iv;
    this.lastRevision = rev;
    const records = this.query.dataStore.recordsInRange(
      this.channel,
      iv,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    if (records.length === 0) {
      return;
    }
    const ohlc: OhlcRecord[] = [];
    for (const r of records) {
      if (isFiniteOhlc(r)) {
        ohlc.push(r);
      }
    }
    if (ohlc.length === 0) {
      return;
    }
    const ha = computeHeikinAshi(ohlc);
    for (const bar of ha) {
      this.cache.set(Number(bar.time), bar);
    }
  }

  private invalidateCache(): void {
    this.cache.clear();
    this.lastRevision = -1;
    this.lastInterval = -1;
  }
}
