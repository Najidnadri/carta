import { FillGradient, Graphics } from "pixi.js";
import type { PriceRange } from "./PriceRangeProvider.js";
import { Series, type SeriesRenderContext } from "./Series.js";
import {
  asPrice,
  type BaselineMode,
  type BaselineSeriesOptions,
  type DataRecord,
  type PointRecord,
  type Theme,
  type Time,
} from "../types.js";

const DEFAULT_LINE_WIDTH = 1.5;
const DEFAULT_BASELINE: BaselineMode = 0;
const DEFAULT_TOP_ALPHA = 0.45;
const DEFAULT_BOTTOM_ALPHA = 0.05;
const CHUNK_SIZE = 64;

function isFinitePoint(r: DataRecord): r is PointRecord {
  if (!("value" in r)) {
    return false;
  }
  return Number.isFinite(Number(r.value));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function rgbaString(hex: number, alpha: number): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${clamp01(alpha).toFixed(4)})`;
}

/** Point shape used by the baseline-split algorithm — projected pixel coords. */
export interface BaselinePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Split the polyline defined by `points` into closed polygons of pixel
 * coordinates above / below `baselineY`. Assumes `points` is x-ordered.
 * Pixi's y axis grows downward, so "above the baseline" in *price* maps to
 * *smaller* y values; the helper is purely mechanical and treats "above"
 * as `y < baselineY`.
 *
 * Points whose `y === baselineY` inherit the previous segment's side (no
 * double-emission of on-baseline vertices). Polygons shorter than 3
 * vertices are filtered out since they have no area to fill.
 */
export function splitAtBaseline(
  points: readonly BaselinePoint[],
  baselineY: number,
): { readonly above: readonly (readonly BaselinePoint[])[]; readonly below: readonly (readonly BaselinePoint[])[] } {
  if (points.length === 0 || !Number.isFinite(baselineY)) {
    return { above: [], below: [] };
  }
  const aboveGroups: BaselinePoint[][] = [];
  const belowGroups: BaselinePoint[][] = [];

  const sideOf = (y: number): -1 | 0 | 1 => (y < baselineY ? -1 : y > baselineY ? 1 : 0);

  let current: BaselinePoint[] = [];
  let side: -1 | 1 = -1;

  const firstRaw = points[0];
  if (firstRaw === undefined) {
    return { above: [], below: [] };
  }

  const firstSide = sideOf(firstRaw.y);
  if (firstSide === 0) {
    for (let j = 1; j < points.length; j++) {
      const pj = points[j];
      if (pj === undefined) {
        continue;
      }
      const sj = sideOf(pj.y);
      if (sj !== 0) {
        current = [{ x: firstRaw.x, y: baselineY }];
        side = sj;
        break;
      }
    }
    if (current.length === 0) {
      return { above: [], below: [] };
    }
  } else {
    current = [{ x: firstRaw.x, y: baselineY }, firstRaw];
    side = firstSide;
  }

  const commit = (tail: BaselinePoint): void => {
    if (current.length === 0) {
      return;
    }
    current.push(tail);
    const bucket = side === -1 ? aboveGroups : belowGroups;
    if (current.length >= 3) {
      bucket.push(current);
    }
    current = [];
  };

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    if (prev === undefined || curr === undefined) {
      continue;
    }
    const currSide = sideOf(curr.y);
    if (current.length === 0) {
      if (currSide === 0) {
        continue;
      }
      current = [{ x: curr.x, y: baselineY }, curr];
      side = currSide;
      continue;
    }
    if (currSide === 0 || currSide === side) {
      current.push(curr);
      continue;
    }
    const denom = curr.y - prev.y;
    const t = denom === 0 ? 0 : (baselineY - prev.y) / denom;
    const xCross = prev.x + t * (curr.x - prev.x);
    const crossPoint: BaselinePoint = { x: xCross, y: baselineY };
    commit(crossPoint);
    current = [crossPoint, curr];
    side = currSide;
  }

  if (current.length > 0) {
    const last = points[points.length - 1];
    if (last !== undefined) {
      commit({ x: last.x, y: baselineY });
    }
  }

  return {
    above: aboveGroups.filter((g) => g.length >= 3),
    below: belowGroups.filter((g) => g.length >= 3),
  };
}

/**
 * Point-channel baseline series: polyline with two-color fill split at a
 * configurable baseline price. The baseline can be a fixed number,
 * `'first'` (the first finite visible value), or `'average'` (mean of
 * visible finite values).
 *
 * Three pre-owned `Graphics` children (`aboveFill`, `belowFill`, `stroke`),
 * rebuilt on every invalidation. Two cached `FillGradient` instances
 * (positive / negative), rebuilt on theme or colour-option changes.
 */
export class BaselineSeries extends Series {
  private readonly opts: BaselineSeriesOptions;
  private readonly aboveFill: Graphics;
  private readonly belowFill: Graphics;
  private readonly strokeGraphics: Graphics;
  private positiveGradient: FillGradient | null = null;
  private negativeGradient: FillGradient | null = null;
  private gradientKey: string | null = null;

  constructor(options: BaselineSeriesOptions) {
    super(options.channel, "point", `BaselineSeries(${options.channel})`);
    this.opts = options;
    this.aboveFill = new Graphics();
    this.belowFill = new Graphics();
    this.strokeGraphics = new Graphics();
    this.container.addChild(this.aboveFill);
    this.container.addChild(this.belowFill);
    this.container.addChild(this.strokeGraphics);
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
    this.aboveFill.clear();
    this.belowFill.clear();
    this.strokeGraphics.clear();
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

    const points: BaselinePoint[] = [];
    const values: number[] = [];
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
      values.push(Number(r.value));
    }
    if (points.length === 0) {
      return;
    }

    const baselineValue = this.resolveBaselineValue(values);
    if (baselineValue === null) {
      return;
    }
    const yBaseline = Number(ctx.priceScale.valueToPixel(asPrice(baselineValue)));
    if (!Number.isFinite(yBaseline)) {
      return;
    }

    const { above, below } = splitAtBaseline(points, yBaseline);
    const { positive, negative } = this.ensureGradients(ctx.theme);

    for (const poly of above) {
      this.aboveFill.poly(polyToFlat(poly)).fill(positive);
    }
    for (const poly of below) {
      this.belowFill.poly(polyToFlat(poly)).fill(negative);
    }

    const color = this.opts.lineColor ?? ctx.theme.line;
    const width = this.opts.lineWidth ?? DEFAULT_LINE_WIDTH;
    const strokeStyle = { color, width };
    const first = points[0];
    if (first !== undefined) {
      this.strokeGraphics.moveTo(first.x, first.y);
      let countInChunk = 0;
      for (let i = 1; i < points.length; i++) {
        const p = points[i];
        if (p === undefined) {
          continue;
        }
        this.strokeGraphics.lineTo(p.x, p.y);
        countInChunk++;
        if (countInChunk >= CHUNK_SIZE) {
          this.strokeGraphics.stroke(strokeStyle);
          this.strokeGraphics.moveTo(p.x, p.y);
          countInChunk = 0;
        }
      }
      if (countInChunk > 0 || points.length === 1) {
        this.strokeGraphics.stroke(strokeStyle);
      }
    }
  }

  private resolveBaselineValue(finiteValues: readonly number[]): number | null {
    const mode: BaselineMode = this.opts.baseline ?? DEFAULT_BASELINE;
    if (typeof mode === "number") {
      return Number.isFinite(mode) ? mode : null;
    }
    if (finiteValues.length === 0) {
      return null;
    }
    if (mode === "first") {
      return finiteValues[0] ?? null;
    }
    let sum = 0;
    for (const v of finiteValues) {
      sum += v;
    }
    return sum / finiteValues.length;
  }

  private ensureGradients(theme: Theme): { positive: FillGradient; negative: FillGradient } {
    const positiveTop = this.opts.positiveTopColor ?? theme.baselinePositiveTop;
    const positiveBottom = this.opts.positiveBottomColor ?? theme.baselinePositiveBottom;
    const negativeTop = this.opts.negativeTopColor ?? theme.baselineNegativeTop;
    const negativeBottom = this.opts.negativeBottomColor ?? theme.baselineNegativeBottom;
    const topAlpha = this.opts.fillTopAlpha ?? DEFAULT_TOP_ALPHA;
    const bottomAlpha = this.opts.fillBottomAlpha ?? DEFAULT_BOTTOM_ALPHA;
    const key = [
      positiveTop,
      positiveBottom,
      negativeTop,
      negativeBottom,
      topAlpha,
      bottomAlpha,
    ]
      .map((n) => String(n))
      .join("|");
    if (
      this.positiveGradient !== null &&
      this.negativeGradient !== null &&
      this.gradientKey === key
    ) {
      return { positive: this.positiveGradient, negative: this.negativeGradient };
    }
    this.positiveGradient?.destroy();
    this.negativeGradient?.destroy();
    this.positiveGradient = new FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: rgbaString(positiveTop, topAlpha) },
        { offset: 1, color: rgbaString(positiveBottom, bottomAlpha) },
      ],
      textureSpace: "local",
    });
    this.negativeGradient = new FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: rgbaString(negativeBottom, bottomAlpha) },
        { offset: 1, color: rgbaString(negativeTop, topAlpha) },
      ],
      textureSpace: "local",
    });
    this.gradientKey = key;
    return { positive: this.positiveGradient, negative: this.negativeGradient };
  }

  destroy(): void {
    this.positiveGradient?.destroy();
    this.negativeGradient?.destroy();
    this.positiveGradient = null;
    this.negativeGradient = null;
    this.aboveFill.destroy();
    this.belowFill.destroy();
    this.strokeGraphics.destroy();
    super.destroy();
  }
}

function polyToFlat(poly: readonly BaselinePoint[]): number[] {
  const flat: number[] = [];
  for (const p of poly) {
    flat.push(p.x, p.y);
  }
  return flat;
}
