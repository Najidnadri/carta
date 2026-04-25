/**
 * Pure projection from data-space anchors to screen geometry.
 * No Pixi imports — kept renderer-free so it's vitest-friendly and so the
 * hit-tester can consume the same `ScreenGeom` shapes.
 *
 * Off-window anchors are projected anyway (clip mask hides them); we never
 * clamp to data range — clamping would visibly drag a line as the user
 * scrolls into older data and the cache expands.
 */

import type { PlotRect } from "../render/Renderer.js";
import type { PriceScale } from "../price/PriceScale.js";
import type { TimeScale } from "../time/TimeScale.js";
import { asPixel } from "../../types.js";
import type {
  Drawing,
  ExtendMode,
  FibLevel,
  FibRetracementDrawing,
  HorizontalLineDrawing,
  RectangleDrawing,
  TrendlineDrawing,
  VerticalLineDrawing,
} from "./types.js";

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface TrendlineGeom {
  readonly kind: "trendline";
  /** Original anchors (used for handle placement). */
  readonly anchors: readonly [ScreenPoint, ScreenPoint];
  /** Visible (possibly extended) line. */
  readonly visible: readonly [ScreenPoint, ScreenPoint];
}

export interface HorizontalLineGeom {
  readonly kind: "horizontalLine";
  readonly anchor: ScreenPoint;
  /** Y after sub-pixel snap (`Math.round(y) + 0.5`). */
  readonly snappedY: number;
  readonly x1: number;
  readonly x2: number;
}

export interface VerticalLineGeom {
  readonly kind: "verticalLine";
  readonly anchor: ScreenPoint;
  readonly snappedX: number;
  readonly y1: number;
  readonly y2: number;
}

export interface RectangleGeom {
  readonly kind: "rectangle";
  readonly anchors: readonly [ScreenPoint, ScreenPoint];
  /** Stored corner points + 2 derived corners (clockwise from top-left). */
  readonly corners: readonly [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

export interface FibLevelGeom {
  readonly value: number;
  readonly y: number;
  readonly snappedY: number;
  readonly price: number;
  readonly visible: boolean;
  readonly color: number | undefined;
  readonly alpha: number | undefined;
}

export interface FibRetracementGeom {
  readonly kind: "fibRetracement";
  readonly anchors: readonly [ScreenPoint, ScreenPoint];
  readonly xMin: number;
  readonly xMax: number;
  readonly levels: readonly FibLevelGeom[];
  readonly bbox: { readonly xMin: number; readonly xMax: number; readonly yMin: number; readonly yMax: number };
}

export type ScreenGeom =
  | TrendlineGeom
  | HorizontalLineGeom
  | VerticalLineGeom
  | RectangleGeom
  | FibRetracementGeom;

export interface ProjectionContext {
  readonly timeScale: TimeScale;
  readonly priceScale: PriceScale;
  readonly plotRect: PlotRect;
}

function projectAnchor(
  ts: TimeScale,
  ps: PriceScale,
  time: number,
  price: number,
): ScreenPoint {
  const x = Number(ts.timeToPixel(time as never));
  const y = Number(ps.valueToPixel(price));
  return Object.freeze({
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  });
}

/** Sub-pixel snap for axis-aligned 1-pixel strokes. */
function pixelSnap(v: number): number {
  return Math.round(v) + 0.5;
}

function projectTrendline(d: TrendlineDrawing, ctx: ProjectionContext): TrendlineGeom {
  const a = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[0].time), Number(d.anchors[0].price));
  const b = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[1].time), Number(d.anchors[1].price));
  const extend: ExtendMode = d.style.extend ?? "none";
  const visible = extendSegment(a, b, extend, ctx.plotRect);
  const anchors: readonly [ScreenPoint, ScreenPoint] = Object.freeze([a, b] as const);
  return Object.freeze({
    kind: "trendline" as const,
    anchors,
    visible,
  });
}

/**
 * Extend an `[a, b]` segment to the plot rect edges per `extend` mode.
 * Computes the line equation in pixel space (post-projection) using `t`
 * parameter against the original endpoints — this is equivalent to extending
 * in price/time space because the projection is linear.
 */
export function extendSegment(
  a: ScreenPoint,
  b: ScreenPoint,
  extend: ExtendMode,
  plot: PlotRect,
): readonly [ScreenPoint, ScreenPoint] {
  if (extend === "none") {
    return Object.freeze([a, b] as const);
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) {
    return Object.freeze([a, b] as const);
  }
  // Parameter t against (a + t*(b-a)): t=0 → a, t=1 → b.
  // We want to clip the infinite line to the plot rect (or to one side).
  const xMin = 0;
  const xMax = plot.w;
  const yMin = 0;
  const yMax = plot.h;
  // Use Liang–Barsky clipping but on the infinite line. We compute the t
  // bounds for x ∈ [xMin, xMax] and y ∈ [yMin, yMax].
  let tMin = -Infinity;
  let tMax = Infinity;
  if (dx !== 0) {
    const t1 = (xMin - a.x) / dx;
    const t2 = (xMax - a.x) / dx;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  } else if (a.x < xMin || a.x > xMax) {
    return Object.freeze([a, b] as const);
  }
  if (dy !== 0) {
    const t1 = (yMin - a.y) / dy;
    const t2 = (yMax - a.y) / dy;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  } else if (a.y < yMin || a.y > yMax) {
    return Object.freeze([a, b] as const);
  }
  if (tMin > tMax) {
    return Object.freeze([a, b] as const);
  }
  // Clamp t per extend direction.
  const leftT = extend === "left" || extend === "both" ? tMin : 0;
  const rightT = extend === "right" || extend === "both" ? tMax : 1;
  if (leftT > rightT) {
    return Object.freeze([a, b] as const);
  }
  const start: ScreenPoint = Object.freeze({ x: a.x + leftT * dx, y: a.y + leftT * dy });
  const end: ScreenPoint = Object.freeze({ x: a.x + rightT * dx, y: a.y + rightT * dy });
  return Object.freeze([start, end] as const);
}

function projectHorizontal(d: HorizontalLineDrawing, ctx: ProjectionContext): HorizontalLineGeom {
  const a = projectAnchor(
    ctx.timeScale,
    ctx.priceScale,
    Number(d.anchors[0].time),
    Number(d.anchors[0].price),
  );
  return Object.freeze({
    kind: "horizontalLine" as const,
    anchor: a,
    snappedY: pixelSnap(a.y),
    x1: 0,
    x2: ctx.plotRect.w,
  });
}

function projectVertical(d: VerticalLineDrawing, ctx: ProjectionContext): VerticalLineGeom {
  const a = projectAnchor(
    ctx.timeScale,
    ctx.priceScale,
    Number(d.anchors[0].time),
    Number(d.anchors[0].price),
  );
  return Object.freeze({
    kind: "verticalLine" as const,
    anchor: a,
    snappedX: pixelSnap(a.x),
    y1: 0,
    y2: ctx.plotRect.h,
  });
}

function projectRectangle(d: RectangleDrawing, ctx: ProjectionContext): RectangleGeom {
  const a = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[0].time), Number(d.anchors[0].price));
  const b = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[1].time), Number(d.anchors[1].price));
  const xMin = Math.min(a.x, b.x);
  const xMax = Math.max(a.x, b.x);
  const yMin = Math.min(a.y, b.y);
  const yMax = Math.max(a.y, b.y);
  const corners: readonly [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint] = Object.freeze([
    Object.freeze({ x: xMin, y: yMin }),
    Object.freeze({ x: xMax, y: yMin }),
    Object.freeze({ x: xMax, y: yMax }),
    Object.freeze({ x: xMin, y: yMax }),
  ] as const);
  const anchors: readonly [ScreenPoint, ScreenPoint] = Object.freeze([a, b] as const);
  return Object.freeze({
    kind: "rectangle" as const,
    anchors,
    corners,
    xMin,
    xMax,
    yMin,
    yMax,
  });
}

function projectFib(d: FibRetracementDrawing, ctx: ProjectionContext): FibRetracementGeom {
  const aPrice = Number(d.anchors[0].price);
  const bPrice = Number(d.anchors[1].price);
  const a = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[0].time), aPrice);
  const b = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[1].time), bPrice);
  const xMin = Math.min(a.x, b.x);
  const xMax = Math.max(a.x, b.x);
  const span = bPrice - aPrice;
  const finite = Number.isFinite(span);
  const levels: FibLevelGeom[] = [];
  let yMin = Math.min(a.y, b.y);
  let yMax = Math.max(a.y, b.y);
  for (const lvl of d.levels) {
    const visible = lvl.visible !== false;
    if (!finite || span === 0) {
      const y = Math.min(a.y, b.y);
      levels.push(makeLevel(lvl, y, aPrice, visible));
      continue;
    }
    const price = aPrice + lvl.value * span;
    const yPx = Number(ctx.priceScale.valueToPixel(price));
    const safeY = Number.isFinite(yPx) ? yPx : a.y;
    yMin = Math.min(yMin, safeY);
    yMax = Math.max(yMax, safeY);
    levels.push(makeLevel(lvl, safeY, price, visible));
  }
  const fibAnchors: readonly [ScreenPoint, ScreenPoint] = Object.freeze([a, b] as const);
  return Object.freeze({
    kind: "fibRetracement" as const,
    anchors: fibAnchors,
    xMin,
    xMax,
    levels: Object.freeze(levels),
    bbox: Object.freeze({ xMin, xMax, yMin, yMax }),
  });
}

function makeLevel(lvl: FibLevel, y: number, price: number, visible: boolean): FibLevelGeom {
  return Object.freeze({
    value: lvl.value,
    y,
    snappedY: pixelSnap(y),
    price,
    visible,
    color: lvl.color,
    alpha: lvl.alpha,
  });
}

export function projectDrawing(d: Drawing, ctx: ProjectionContext): ScreenGeom {
  switch (d.kind) {
    case "trendline":
      return projectTrendline(d, ctx);
    case "horizontalLine":
      return projectHorizontal(d, ctx);
    case "verticalLine":
      return projectVertical(d, ctx);
    case "rectangle":
      return projectRectangle(d, ctx);
    case "fibRetracement":
      return projectFib(d, ctx);
  }
}

/** Pure inverse — converts plot-local pixels to a `(time, price)` anchor. */
export function unprojectPoint(
  ctx: ProjectionContext,
  px: number,
  py: number,
): { time: number; price: number } {
  const time = Number(ctx.timeScale.pixelToTime(asPixel(px)));
  const price = Number(ctx.priceScale.pixelToValue(asPixel(py)));
  return { time, price };
}
