import { Graphics } from "pixi.js";
import type { PriceRange } from "./PriceRangeProvider.js";
import { Series, type SeriesRenderContext } from "./Series.js";
import {
  asPrice,
  type DataRecord,
  type LineSeriesOptions,
  type PointRecord,
  type Time,
} from "../types.js";

const DEFAULT_LINE_WIDTH = 1.5;
const CHUNK_SIZE = 64; // Respects Pixi v8's ~100-point batcher cliff.

function isFinitePoint(r: DataRecord): r is PointRecord {
  if (!("value" in r)) {
    return false;
  }
  return Number.isFinite(Number(r.value));
}

/**
 * Single-Graphics line series — solid stroke, no dashed/dotted/stepped
 * (deferred to a later slice). Rebuilds the whole polyline on every
 * invalidation; chunks `stroke()` calls every `CHUNK_SIZE` points so long
 * series don't fall off Pixi v8's batcher cliff (research §2 "Performance
 * cliffs"). Non-finite values are silently skipped.
 *
 * Renders points in the window ±1 interval so the polyline doesn't sever
 * at viewport edges during a pan.
 */
export class LineSeries extends Series {
  private readonly opts: LineSeriesOptions;
  private readonly graphics: Graphics;

  constructor(options: LineSeriesOptions) {
    super(options.channel, "point", `LineSeries(${options.channel})`);
    this.opts = options;
    this.graphics = new Graphics();
    this.container.addChild(this.graphics);
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
      if (!isFinitePoint(r)) {
        continue;
      }
      const v = Number(r.value);
      if (v < lo) {
        lo = v;
      }
      if (v > hi) {
        hi = v;
      }
    }
    if (lo === Number.POSITIVE_INFINITY || hi === Number.NEGATIVE_INFINITY) {
      return null;
    }
    return { min: asPrice(lo), max: asPrice(hi) };
  }

  render(ctx: SeriesRenderContext): void {
    this.graphics.clear();
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
    const color = this.opts.color ?? ctx.theme.line;
    const width = this.opts.lineWidth ?? DEFAULT_LINE_WIDTH;
    const strokeStyle = { color, width };

    let first = true;
    let countInChunk = 0;
    for (const r of records) {
      if (!isFinitePoint(r)) {
        continue;
      }
      const x = Number(ctx.timeScale.timeToPixel(r.time));
      const y = Number(ctx.priceScale.valueToPixel(r.value));
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }
      if (first) {
        this.graphics.moveTo(x, y);
        first = false;
        continue;
      }
      this.graphics.lineTo(x, y);
      countInChunk++;
      if (countInChunk >= CHUNK_SIZE) {
        // Close this sub-polyline, stroke it, then reopen at the last
        // point so the visual line stays continuous.
        this.graphics.stroke(strokeStyle);
        this.graphics.moveTo(x, y);
        countInChunk = 0;
      }
    }
    if (!first && countInChunk > 0) {
      this.graphics.stroke(strokeStyle);
    }
  }

  destroy(): void {
    this.graphics.destroy();
    super.destroy();
  }
}
