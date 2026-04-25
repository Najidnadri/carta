import { Graphics } from "pixi.js";
import type { PriceRange } from "../price/PriceRangeProvider.js";
import { Series, type SeriesRenderContext } from "./Series.js";
import {
  DASH_PATTERNS,
  INITIAL_DASH_STATE,
  emitDashedSegment,
  type DashState,
} from "./dashSegment.js";
import {
  asPrice,
  type DataRecord,
  type LineSeriesOptions,
  type LineStyle,
  type LineType,
  type PointRecord,
  type Time,
} from "../../types.js";

const DEFAULT_LINE_WIDTH = 1.5;
const DEFAULT_LINE_STYLE: LineStyle = "solid";
const DEFAULT_LINE_TYPE: LineType = "simple";
/**
 * Max `lineTo` calls per `stroke()` submission. Respects Pixi v8's ~100-point
 * batcher cliff regardless of whether we're in a simple, stepped, or dashed
 * path — each mode can emit many sub-primitives per input point.
 */
const CHUNK_SIZE = 64;

interface Point {
  readonly x: number;
  readonly y: number;
}

function isFinitePoint(r: DataRecord): r is PointRecord {
  if (!("value" in r)) {
    return false;
  }
  return Number.isFinite(Number(r.value));
}

/**
 * Single-Graphics line series. Supports:
 *
 * - `lineStyle: 'solid' | 'dashed' | 'dotted'` — dashes are phase-continuous
 *   across polyline joints (see `dashSegment.ts`).
 * - `lineType: 'simple' | 'stepped'` — stepped holds the previous y until
 *   the next x, then jumps. Dashed-stepped emits dashes along the whole
 *   L-shaped staircase, both horizontal and vertical legs.
 *
 * Rebuilds the whole polyline on every invalidation; chunks `stroke()`
 * calls every `CHUNK_SIZE` emitted lineTo-pairs so long / dashed series
 * don't fall off Pixi v8's batcher cliff (research §2 "Performance cliffs").
 * Non-finite values are silently skipped.
 *
 * Renders points in the window ±1 interval so the polyline doesn't sever
 * at viewport edges during a pan.
 */
export class LineSeries extends Series {
  private opts: LineSeriesOptions;
  private readonly graphics: Graphics;

  constructor(options: LineSeriesOptions) {
    super(options.channel, "point", `LineSeries(${options.channel})`);
    this.opts = options;
    this.graphics = new Graphics();
    this.container.addChild(this.graphics);
  }

  applyOptions(patch: Partial<LineSeriesOptions>): void {
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
    const records = ctx.dataStore.recordsInRange(this.channel, iv, start - iv, end + iv);
    if (records.length === 0) {
      return;
    }
    const color = this.opts.color ?? ctx.theme.line;
    const width = this.opts.lineWidth ?? DEFAULT_LINE_WIDTH;
    if (!(width > 0)) {
      return;
    }
    const lineStyle = this.opts.lineStyle ?? DEFAULT_LINE_STYLE;
    const lineType = this.opts.lineType ?? DEFAULT_LINE_TYPE;
    const strokeStyle = { color, width };

    const points: Point[] = [];
    for (const r of records) {
      if (!isFinitePoint(r)) {
        continue;
      }
      const x = Number(ctx.timeScale.timeToPixel(r.time));
      const y = Number(ctx.priceScale.valueToPixel(r.value));
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }
      points.push({ x, y });
    }
    if (points.length === 0) {
      return;
    }

    // Expand input points into the list of straight segments we'll feed to
    // the renderer. For simple lines this is just consecutive pairs; for
    // stepped it's two sub-segments per input pair (horizontal then vertical).
    interface Segment {
      readonly x0: number;
      readonly y0: number;
      readonly x1: number;
      readonly y1: number;
    }
    const segments: Segment[] = [];
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      if (prev === undefined || curr === undefined) {
        continue;
      }
      if (lineType === "stepped") {
        segments.push({ x0: prev.x, y0: prev.y, x1: curr.x, y1: prev.y });
        segments.push({ x0: curr.x, y0: prev.y, x1: curr.x, y1: curr.y });
      } else {
        segments.push({ x0: prev.x, y0: prev.y, x1: curr.x, y1: curr.y });
      }
    }
    if (segments.length === 0) {
      // Single-point polyline — nothing to stroke.
      return;
    }

    if (lineStyle === "solid") {
      this.strokeSolid(segments, strokeStyle);
      return;
    }
    const pattern = DASH_PATTERNS[lineStyle];
    this.strokeDashed(segments, pattern, strokeStyle);
  }

  private strokeSolid(
    segments: readonly { x0: number; y0: number; x1: number; y1: number }[],
    strokeStyle: { readonly color: number; readonly width: number },
  ): void {
    const first = segments[0];
    if (first === undefined) {
      return;
    }
    this.graphics.moveTo(first.x0, first.y0);
    let lastX = first.x0;
    let lastY = first.y0;
    let emitted = 0;
    for (const s of segments) {
      if (s.x0 !== lastX || s.y0 !== lastY) {
        this.graphics.moveTo(s.x0, s.y0);
      }
      this.graphics.lineTo(s.x1, s.y1);
      emitted++;
      lastX = s.x1;
      lastY = s.y1;
      if (emitted >= CHUNK_SIZE) {
        this.graphics.stroke(strokeStyle);
        this.graphics.moveTo(lastX, lastY);
        emitted = 0;
      }
    }
    if (emitted > 0) {
      this.graphics.stroke(strokeStyle);
    }
  }

  private strokeDashed(
    segments: readonly { x0: number; y0: number; x1: number; y1: number }[],
    pattern: readonly [number, number],
    strokeStyle: { readonly color: number; readonly width: number },
  ): void {
    let state: DashState = INITIAL_DASH_STATE;
    let emittedInChunk = 0;
    for (const s of segments) {
      let x = s.x0;
      let y = s.y0;
      // Loop so segments with more than CHUNK_SIZE dashes get split across
      // multiple stroke() submissions, respecting the 100-pt batcher cliff.
      let exhausted = true;
      while (exhausted) {
        const budget = Math.max(1, CHUNK_SIZE - emittedInChunk);
        const r = emitDashedSegment(
          this.graphics,
          x, y, s.x1, s.y1,
          pattern,
          state,
          budget,
        );
        state = r.state;
        emittedInChunk += r.emitted;
        if (emittedInChunk >= CHUNK_SIZE) {
          this.graphics.stroke(strokeStyle);
          emittedInChunk = 0;
        }
        exhausted = r.exhausted;
        if (exhausted) {
          x = r.nextX;
          y = r.nextY;
        }
      }
    }
    if (emittedInChunk > 0) {
      this.graphics.stroke(strokeStyle);
    }
  }

  destroy(): void {
    this.graphics.destroy();
    super.destroy();
  }
}
