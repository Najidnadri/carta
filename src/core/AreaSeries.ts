import { FillGradient, Graphics } from "pixi.js";
import type { PriceRange } from "./PriceRangeProvider.js";
import { Series, type SeriesRenderContext } from "./Series.js";
import {
  asPrice,
  type AreaSeriesOptions,
  type DataRecord,
  type PointRecord,
  type Theme,
  type Time,
} from "../types.js";

const DEFAULT_LINE_WIDTH = 1.5;
const DEFAULT_TOP_ALPHA = 0.45;
const DEFAULT_BOTTOM_ALPHA = 0;
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

/**
 * Point-channel area series: closed polygon fill (top → bottom linear
 * gradient in local UV space via `FillGradient`) + stroke polyline on top.
 * Non-finite values silently skipped in both the reducer and render paths.
 *
 * Two pre-owned `Graphics` children (`fill`, `stroke`), rebuilt on every
 * invalidation. A single `FillGradient` instance is cached per series and
 * rebuilt when the theme reference or color inputs change. The gradient is
 * local to the shape, so pans / resizes don't need gradient updates.
 *
 * Renders points in the window ±1 interval so the polygon doesn't sever at
 * viewport edges during a pan.
 */
export class AreaSeries extends Series {
  private opts: AreaSeriesOptions;
  private readonly fillGraphics: Graphics;
  private readonly strokeGraphics: Graphics;
  private gradient: FillGradient | null = null;
  private gradientKey: string | null = null;

  constructor(options: AreaSeriesOptions) {
    super(options.channel, "point", `AreaSeries(${options.channel})`);
    this.opts = options;
    this.fillGraphics = new Graphics();
    this.strokeGraphics = new Graphics();
    this.container.addChild(this.fillGraphics);
    this.container.addChild(this.strokeGraphics);
  }

  applyOptions(patch: Partial<AreaSeriesOptions>): void {
    this.opts = this.mergeOptions(this.opts, patch);
    // Force a gradient rebuild on the next render — the cache key includes
    // colours / alphas, so it'll recompute naturally, but we null out the
    // key to make the failure mode explicit if a future patch ever
    // bypasses `ensureGradient`.
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
    this.fillGraphics.clear();
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

    const baselineValue =
      this.opts.baseline !== undefined && Number.isFinite(this.opts.baseline)
        ? this.opts.baseline
        : null;
    const yBaseline = baselineValue === null
      ? ctx.plotHeight
      : Number(ctx.priceScale.valueToPixel(asPrice(baselineValue)));
    if (!Number.isFinite(yBaseline)) {
      return;
    }

    const polyX: number[] = [];
    const polyY: number[] = [];
    for (const r of records) {
      if (!isFinitePoint(r)) {
        continue;
      }
      const x = Number(ctx.timeScale.timeToPixel(r.time));
      const y = Number(ctx.priceScale.valueToPixel(r.value));
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }
      polyX.push(x);
      polyY.push(y);
    }
    if (polyX.length === 0) {
      return;
    }

    const gradient = this.ensureGradient(ctx.theme);
    const polyPoints: number[] = [];
    const firstX = polyX[0] ?? 0;
    const lastX = polyX[polyX.length - 1] ?? firstX;
    polyPoints.push(firstX, yBaseline);
    for (let i = 0; i < polyX.length; i++) {
      polyPoints.push(polyX[i] ?? 0, polyY[i] ?? 0);
    }
    polyPoints.push(lastX, yBaseline);
    this.fillGraphics.poly(polyPoints).fill(gradient);

    const color = this.opts.lineColor ?? this.opts.topColor ?? ctx.theme.areaTop;
    const width = this.opts.lineWidth ?? DEFAULT_LINE_WIDTH;
    const strokeStyle = { color, width };
    let countInChunk = 0;
    const firstXFinite = polyX[0] ?? 0;
    const firstYFinite = polyY[0] ?? 0;
    this.strokeGraphics.moveTo(firstXFinite, firstYFinite);
    for (let i = 1; i < polyX.length; i++) {
      const x = polyX[i] ?? 0;
      const y = polyY[i] ?? 0;
      this.strokeGraphics.lineTo(x, y);
      countInChunk++;
      if (countInChunk >= CHUNK_SIZE) {
        this.strokeGraphics.stroke(strokeStyle);
        this.strokeGraphics.moveTo(x, y);
        countInChunk = 0;
      }
    }
    if (countInChunk > 0 || polyX.length === 1) {
      this.strokeGraphics.stroke(strokeStyle);
    }
  }

  private ensureGradient(theme: Theme): FillGradient {
    const topColor = this.opts.topColor ?? theme.areaTop;
    const bottomColor = this.opts.bottomColor ?? theme.areaBottom;
    const topAlpha = this.opts.topAlpha ?? DEFAULT_TOP_ALPHA;
    const bottomAlpha = this.opts.bottomAlpha ?? DEFAULT_BOTTOM_ALPHA;
    const key = `${String(topColor)}|${String(bottomColor)}|${String(topAlpha)}|${String(bottomAlpha)}`;
    if (this.gradient !== null && this.gradientKey === key) {
      return this.gradient;
    }
    this.gradient?.destroy();
    this.gradient = new FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: rgbaString(topColor, topAlpha) },
        { offset: 1, color: rgbaString(bottomColor, bottomAlpha) },
      ],
      textureSpace: "local",
    });
    this.gradientKey = key;
    return this.gradient;
  }

  destroy(): void {
    this.gradient?.destroy();
    this.gradient = null;
    this.fillGraphics.destroy();
    this.strokeGraphics.destroy();
    super.destroy();
  }
}
