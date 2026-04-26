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
  ArrowDrawing,
  CalloutDrawing,
  DateRangeDrawing,
  Drawing,
  EllipseDrawing,
  ExtendedLineDrawing,
  ExtendMode,
  FibArcsDrawing,
  FibExtensionDrawing,
  FibFanDrawing,
  FibLevel,
  FibRetracementDrawing,
  FibTimeZonesDrawing,
  GannFanDrawing,
  HorizontalLineDrawing,
  HorizontalRayDrawing,
  LongPositionDrawing,
  ParallelChannelDrawing,
  PitchforkDrawing,
  PriceDateRangeDrawing,
  PriceRangeDrawing,
  RayDrawing,
  RectangleDrawing,
  ShortPositionDrawing,
  TextDrawing,
  TrendlineDrawing,
  VerticalLineDrawing,
} from "./types.js";
import { computePitchforkCenterlineBase, GANN_FAN_SLOPES } from "./pitchfork.js";

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

export interface RayGeom {
  readonly kind: "ray";
  readonly anchors: readonly [ScreenPoint, ScreenPoint];
  /** Ray clipped to the plot rect, starting at `anchors[0]`. */
  readonly visible: readonly [ScreenPoint, ScreenPoint];
}

export interface ExtendedLineGeom {
  readonly kind: "extendedLine";
  readonly anchors: readonly [ScreenPoint, ScreenPoint];
  /** Both directions clipped to the plot rect. */
  readonly visible: readonly [ScreenPoint, ScreenPoint];
}

export interface HorizontalRayGeom {
  readonly kind: "horizontalRay";
  readonly anchor: ScreenPoint;
  readonly snappedY: number;
  readonly x1: number;
  readonly x2: number;
}

export interface ParallelChannelGeom {
  readonly kind: "parallelChannel";
  /** Original anchors `(a, b, c)` in screen space (pre-extension, pre-offset). */
  readonly anchors: readonly [ScreenPoint, ScreenPoint, ScreenPoint];
  /** Top line `(a, b)` (visible segment). */
  readonly top: readonly [ScreenPoint, ScreenPoint];
  /** Bottom line, parallel offset `Δprice` away from `(a, b)`. */
  readonly bottom: readonly [ScreenPoint, ScreenPoint];
  /** Quadrilateral fill in clockwise order: top-a, top-b, bottom-b, bottom-a. */
  readonly polygon: readonly [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
  readonly bbox: { readonly xMin: number; readonly xMax: number; readonly yMin: number; readonly yMax: number };
}

// ─── Phase 13 Cycle B.2 — position / text / callout / arrow / range geom ──

export interface PositionGeom {
  readonly kind: "longPosition" | "shortPosition";
  /** [entry, sl, tp] anchors projected; entry handle at `(entryX, entryY)`. */
  readonly entry: ScreenPoint;
  readonly sl: ScreenPoint;
  readonly tp: ScreenPoint;
  /** Right edge of the position band (`endTime` projected). */
  readonly endX: number;
  /** Stored anchor times — used to detect off-axis drag. */
  readonly entryX: number;
  /** Reward zone (entry → tp): top/bottom in screen y. xLeft, xRight clip-clamped. */
  readonly rewardRect: { readonly xLeft: number; readonly xRight: number; readonly yTop: number; readonly yBottom: number };
  readonly riskRect: { readonly xLeft: number; readonly xRight: number; readonly yTop: number; readonly yBottom: number };
  readonly bbox: { readonly xMin: number; readonly xMax: number; readonly yMin: number; readonly yMax: number };
}

export interface TextGeom {
  readonly kind: "text";
  readonly anchor: ScreenPoint;
  /** Top-left of the label pill in plot-local pixels. */
  readonly labelX: number;
  readonly labelY: number;
}

export interface CalloutGeom {
  readonly kind: "callout";
  readonly pin: ScreenPoint;
  readonly labelCenter: ScreenPoint;
  /** Top-left of the label pill in plot-local pixels. */
  readonly labelX: number;
  readonly labelY: number;
  /** Width / height of the label pill (caller computes from text content). */
  readonly labelW: number;
  readonly labelH: number;
  /** Leader endpoint on the label-bbox edge nearest the pin. `null` when pin inside bbox. */
  readonly leaderEnd: ScreenPoint | null;
}

export interface ArrowGeom {
  readonly kind: "arrow";
  readonly anchors: readonly [ScreenPoint, ScreenPoint];
  /** Trendline shortened so its end sits flush against the arrowhead's back edge. */
  readonly shaft: readonly [ScreenPoint, ScreenPoint];
  /** Filled triangle vertices: tip, back-left, back-right. */
  readonly head: readonly [ScreenPoint, ScreenPoint, ScreenPoint];
  /** Length of the arrowhead used for hit-test. */
  readonly headLength: number;
}

export interface DateRangeGeom {
  readonly kind: "dateRange";
  readonly anchors: readonly [ScreenPoint, ScreenPoint];
  readonly xLeft: number;
  readonly xRight: number;
  readonly yTop: number;
  readonly yBottom: number;
  /** Centered top of the band in screen px (for the readout). */
  readonly badgeAnchor: ScreenPoint;
}

export interface PriceRangeGeom {
  readonly kind: "priceRange";
  readonly anchors: readonly [ScreenPoint, ScreenPoint];
  readonly xLeft: number;
  readonly xRight: number;
  readonly yTop: number;
  readonly yBottom: number;
  readonly badgeAnchor: ScreenPoint;
}

export interface PriceDateRangeGeom {
  readonly kind: "priceDateRange";
  readonly anchors: readonly [ScreenPoint, ScreenPoint];
  readonly xLeft: number;
  readonly xRight: number;
  readonly yTop: number;
  readonly yBottom: number;
  readonly badgeAnchor: ScreenPoint;
}

// ─── Phase 13 Cycle C.1 — exotic geometry geoms ────────────────────────────

export interface PitchforkGeom {
  readonly kind: "pitchfork";
  /** Original anchors `(pivot, reaction1, reaction2)` projected. */
  readonly anchors: readonly [ScreenPoint, ScreenPoint, ScreenPoint];
  /** Centreline visible segment (clipped + optionally extended per `style.extend`). */
  readonly centerline: readonly [ScreenPoint, ScreenPoint];
  /** Upper rail (parallel to centreline, through `reaction1`). */
  readonly upperRail: readonly [ScreenPoint, ScreenPoint];
  /** Lower rail (parallel to centreline, through `reaction2`). */
  readonly lowerRail: readonly [ScreenPoint, ScreenPoint];
  readonly bbox: { readonly xMin: number; readonly xMax: number; readonly yMin: number; readonly yMax: number };
}

export interface GannRayGeom {
  /** Slope multiple this ray represents (1×8 → 0.125 etc.; 1×1 → 1; 8×1 → 8). */
  readonly slope: number;
  /** Visible (clipped + extended) segment in screen space. */
  readonly visible: readonly [ScreenPoint, ScreenPoint];
}

export interface GannFanGeom {
  readonly kind: "gannFan";
  readonly anchors: readonly [ScreenPoint, ScreenPoint];
  /** 9 rays from the pivot at the configured Gann slopes. Empty if pivot/direction degenerate. */
  readonly rays: readonly GannRayGeom[];
  readonly bbox: { readonly xMin: number; readonly xMax: number; readonly yMin: number; readonly yMax: number };
}

export interface EllipseGeom {
  readonly kind: "ellipse";
  readonly anchors: readonly [ScreenPoint, ScreenPoint];
  /** Centre in screen px. */
  readonly cx: number;
  readonly cy: number;
  /** Half-width / half-height in screen px (always non-negative). */
  readonly rx: number;
  readonly ry: number;
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

// ─── Phase 13 Cycle C.2 — fib variant geoms ─────────────────────────────────

export interface FibExtensionGeom {
  readonly kind: "fibExtension";
  readonly anchors: readonly [ScreenPoint, ScreenPoint, ScreenPoint];
  readonly xMin: number;
  readonly xMax: number;
  readonly levels: readonly FibLevelGeom[];
  readonly bbox: { readonly xMin: number; readonly xMax: number; readonly yMin: number; readonly yMax: number };
}

export interface FibTimeZoneGeom {
  /** Bar offset this zone represents (positive integer). */
  readonly offset: number;
  readonly x: number;
  readonly snappedX: number;
  /** Time the zone projects to in ms epoch (origin + offset * intervalMs). */
  readonly time: number;
}

export interface FibTimeZonesGeom {
  readonly kind: "fibTimeZones";
  readonly anchor: ScreenPoint;
  readonly zones: readonly FibTimeZoneGeom[];
  /** `true` when the chart's `intervalDuration` was non-positive — caller renders origin handle only and may emit a warn. */
  readonly intervalMissing: boolean;
  readonly y1: number;
  readonly y2: number;
  readonly bbox: { readonly xMin: number; readonly xMax: number; readonly yMin: number; readonly yMax: number };
}

export interface FibFanRayGeom {
  readonly level: number;
  readonly visible: readonly [ScreenPoint, ScreenPoint];
}

export interface FibFanGeom {
  readonly kind: "fibFan";
  readonly anchors: readonly [ScreenPoint, ScreenPoint];
  readonly rays: readonly FibFanRayGeom[];
  readonly bbox: { readonly xMin: number; readonly xMax: number; readonly yMin: number; readonly yMax: number };
}

export interface FibArcRingGeom {
  readonly level: number;
  /** Screen-space radius for this ring = `r * level`. */
  readonly r: number;
}

export interface FibArcsGeom {
  readonly kind: "fibArcs";
  readonly anchors: readonly [ScreenPoint, ScreenPoint];
  /** Screen-space center (anchor A projected). */
  readonly cx: number;
  readonly cy: number;
  /** Screen-space radius `‖proj(B) − proj(A)‖`. Recomputed every frame — never cached. */
  readonly r: number;
  readonly rings: readonly FibArcRingGeom[];
  readonly bbox: { readonly xMin: number; readonly xMax: number; readonly yMin: number; readonly yMax: number };
}

export type ScreenGeom =
  | TrendlineGeom
  | HorizontalLineGeom
  | VerticalLineGeom
  | RectangleGeom
  | FibRetracementGeom
  | RayGeom
  | ExtendedLineGeom
  | HorizontalRayGeom
  | ParallelChannelGeom
  | PositionGeom
  | TextGeom
  | CalloutGeom
  | ArrowGeom
  | DateRangeGeom
  | PriceRangeGeom
  | PriceDateRangeGeom
  | PitchforkGeom
  | GannFanGeom
  | EllipseGeom
  | FibExtensionGeom
  | FibTimeZonesGeom
  | FibFanGeom
  | FibArcsGeom;

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

function projectRay(d: RayDrawing, ctx: ProjectionContext): RayGeom {
  const a = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[0].time), Number(d.anchors[0].price));
  const b = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[1].time), Number(d.anchors[1].price));
  // Ray is anchor[0] extended through anchor[1] to the plot edge — i.e.
  // `extend: 'right'` semantics applied to the (a, b) parameterisation.
  const visible = extendSegment(a, b, "right", ctx.plotRect);
  return Object.freeze({
    kind: "ray" as const,
    anchors: Object.freeze([a, b] as const),
    visible,
  });
}

function projectExtendedLine(d: ExtendedLineDrawing, ctx: ProjectionContext): ExtendedLineGeom {
  const a = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[0].time), Number(d.anchors[0].price));
  const b = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[1].time), Number(d.anchors[1].price));
  const visible = extendSegment(a, b, "both", ctx.plotRect);
  return Object.freeze({
    kind: "extendedLine" as const,
    anchors: Object.freeze([a, b] as const),
    visible,
  });
}

function projectHorizontalRay(d: HorizontalRayDrawing, ctx: ProjectionContext): HorizontalRayGeom {
  const a = projectAnchor(
    ctx.timeScale,
    ctx.priceScale,
    Number(d.anchors[0].time),
    Number(d.anchors[0].price),
  );
  const snappedY = pixelSnap(a.y);
  const x1 = d.direction === "left" ? 0 : a.x;
  const x2 = d.direction === "left" ? a.x : ctx.plotRect.w;
  return Object.freeze({
    kind: "horizontalRay" as const,
    anchor: a,
    snappedY,
    x1,
    x2,
  });
}

function projectParallelChannel(d: ParallelChannelDrawing, ctx: ProjectionContext): ParallelChannelGeom {
  const aPrice = Number(d.anchors[0].price);
  const bPrice = Number(d.anchors[1].price);
  const aTime = Number(d.anchors[0].time);
  const bTime = Number(d.anchors[1].time);
  const cTime = Number(d.anchors[2].time);
  const cPrice = Number(d.anchors[2].price);
  // priceOnLineAtTime(c.time) = aPrice + (cTime - aTime) / (bTime - aTime) * (bPrice - aPrice)
  // Δprice = cPrice - that.
  // In the degenerate case where aTime === bTime (vertical "trendline" — a
  // pathological input), Δprice collapses to (cPrice - aPrice).
  let priceOnLine: number;
  if (bTime === aTime) {
    priceOnLine = aPrice;
  } else if (!Number.isFinite(aPrice) || !Number.isFinite(bPrice) || !Number.isFinite(cTime) || !Number.isFinite(aTime) || !Number.isFinite(bTime)) {
    priceOnLine = aPrice;
  } else {
    priceOnLine = aPrice + ((cTime - aTime) / (bTime - aTime)) * (bPrice - aPrice);
  }
  const dPrice = Number.isFinite(cPrice) && Number.isFinite(priceOnLine) ? cPrice - priceOnLine : 0;
  const a = projectAnchor(ctx.timeScale, ctx.priceScale, aTime, aPrice);
  const b = projectAnchor(ctx.timeScale, ctx.priceScale, bTime, bPrice);
  const c = projectAnchor(ctx.timeScale, ctx.priceScale, cTime, cPrice);
  const aBottom = projectAnchor(ctx.timeScale, ctx.priceScale, aTime, aPrice + dPrice);
  const bBottom = projectAnchor(ctx.timeScale, ctx.priceScale, bTime, bPrice + dPrice);
  const top = Object.freeze([a, b] as const);
  const bottom = Object.freeze([aBottom, bBottom] as const);
  // Polygon clockwise: top-a → top-b → bottom-b → bottom-a.
  const polygon: readonly [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint] = Object.freeze([
    a,
    b,
    bBottom,
    aBottom,
  ] as const);
  const xMin = Math.min(a.x, b.x, aBottom.x, bBottom.x);
  const xMax = Math.max(a.x, b.x, aBottom.x, bBottom.x);
  const yMin = Math.min(a.y, b.y, aBottom.y, bBottom.y, c.y);
  const yMax = Math.max(a.y, b.y, aBottom.y, bBottom.y, c.y);
  return Object.freeze({
    kind: "parallelChannel" as const,
    anchors: Object.freeze([a, b, c] as const),
    top,
    bottom,
    polygon,
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

function projectPosition(
  d: LongPositionDrawing | ShortPositionDrawing,
  ctx: ProjectionContext,
): PositionGeom {
  const entry = projectAnchor(
    ctx.timeScale,
    ctx.priceScale,
    Number(d.anchors[0].time),
    Number(d.anchors[0].price),
  );
  const sl = projectAnchor(
    ctx.timeScale,
    ctx.priceScale,
    Number(d.anchors[1].time),
    Number(d.anchors[1].price),
  );
  const tp = projectAnchor(
    ctx.timeScale,
    ctx.priceScale,
    Number(d.anchors[2].time),
    Number(d.anchors[2].price),
  );
  const endX = Number(ctx.timeScale.timeToPixel(d.endTime));
  const safeEndX = Number.isFinite(endX) ? endX : entry.x;
  const xLeft = Math.min(entry.x, safeEndX);
  const xRight = Math.max(entry.x, safeEndX);
  // Reward zone: entry ↔ tp. Risk zone: entry ↔ sl. Each rectangle uses
  // min/max so degenerate-axis (sl == entry, tp == entry) collapses cleanly.
  const rewardRect = Object.freeze({
    xLeft,
    xRight,
    yTop: Math.min(entry.y, tp.y),
    yBottom: Math.max(entry.y, tp.y),
  });
  const riskRect = Object.freeze({
    xLeft,
    xRight,
    yTop: Math.min(entry.y, sl.y),
    yBottom: Math.max(entry.y, sl.y),
  });
  const yMin = Math.min(rewardRect.yTop, riskRect.yTop);
  const yMax = Math.max(rewardRect.yBottom, riskRect.yBottom);
  return Object.freeze({
    kind: d.kind,
    entry,
    sl,
    tp,
    endX: safeEndX,
    entryX: entry.x,
    rewardRect,
    riskRect,
    bbox: Object.freeze({ xMin: xLeft, xMax: xRight, yMin, yMax }),
  });
}

function projectText(d: TextDrawing, ctx: ProjectionContext): TextGeom {
  const anchor = projectAnchor(
    ctx.timeScale,
    ctx.priceScale,
    Number(d.anchors[0].time),
    Number(d.anchors[0].price),
  );
  return Object.freeze({
    kind: "text" as const,
    anchor,
    labelX: anchor.x,
    labelY: anchor.y,
  });
}

function projectCallout(d: CalloutDrawing, ctx: ProjectionContext): CalloutGeom {
  const pin = projectAnchor(
    ctx.timeScale,
    ctx.priceScale,
    Number(d.anchors[0].time),
    Number(d.anchors[0].price),
  );
  const labelCenter = projectAnchor(
    ctx.timeScale,
    ctx.priceScale,
    Number(d.anchors[1].time),
    Number(d.anchors[1].price),
  );
  // The renderer measures actual text width; expose the geometric center +
  // a placeholder bbox the renderer will refine. For hit-test purposes,
  // we approximate with a fixed minimum bbox here so projection stays pure.
  // The renderer overrides with measured dimensions — but hit-test against
  // the projected geom uses these defaults until the next projection cycle.
  const charW = 6;
  const padding = 8;
  const lineH = 14;
  const lines = d.text.length === 0 ? 0 : Math.max(1, d.text.split("\n").length);
  const longestLine = d.text.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
  const labelW = lines === 0 ? 0 : Math.max(20, longestLine * charW + padding * 2);
  const labelH = lines === 0 ? 0 : lines * lineH + padding;
  const labelX = labelCenter.x - labelW / 2;
  const labelY = labelCenter.y - labelH / 2;
  const leaderEnd = computeLeaderEnd(pin, labelX, labelY, labelW, labelH);
  return Object.freeze({
    kind: "callout" as const,
    pin,
    labelCenter,
    labelX,
    labelY,
    labelW,
    labelH,
    leaderEnd,
  });
}

/**
 * Compute leader endpoint by intersecting the label bbox with the segment from
 * `labelCenter` toward `pin`. Returns `null` if the pin is inside the bbox.
 */
function computeLeaderEnd(
  pin: ScreenPoint,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): ScreenPoint | null {
  if (bw <= 0 || bh <= 0) {
    return null;
  }
  // Pin inside bbox?
  if (pin.x >= bx && pin.x <= bx + bw && pin.y >= by && pin.y <= by + bh) {
    return null;
  }
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const dx = pin.x - cx;
  const dy = pin.y - cy;
  if (dx === 0 && dy === 0) {
    return null;
  }
  // Parametrise (cx, cy) + t*(dx, dy); want smallest t > 0 that lands on a
  // bbox edge.
  const halfW = bw / 2;
  const halfH = bh / 2;
  let t = Infinity;
  if (dx !== 0) {
    const tx = (Math.sign(dx) * halfW) / dx;
    if (tx > 0 && tx < t) {
      t = tx;
    }
  }
  if (dy !== 0) {
    const ty = (Math.sign(dy) * halfH) / dy;
    if (ty > 0 && ty < t) {
      t = ty;
    }
  }
  if (!Number.isFinite(t)) {
    return null;
  }
  return Object.freeze({ x: cx + t * dx, y: cy + t * dy });
}

function projectArrow(d: ArrowDrawing, ctx: ProjectionContext): ArrowGeom {
  const a = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[0].time), Number(d.anchors[0].price));
  const b = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[1].time), Number(d.anchors[1].price));
  const lineWidth = d.style.stroke?.width ?? 1;
  const headLength = Math.max(8, lineWidth * 4);
  const halfWidth = headLength * 0.5;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    return Object.freeze({
      kind: "arrow" as const,
      anchors: Object.freeze([a, b] as const),
      shaft: Object.freeze([a, b] as const),
      head: Object.freeze([b, b, b] as const),
      headLength,
    });
  }
  const ux = dx / len;
  const uy = dy / len;
  // Shaft shortened so its end sits flush against the arrowhead's back edge
  // (line ends at `b - 0.7 * headLength * unit`).
  const shaftEnd: ScreenPoint = Object.freeze({
    x: b.x - ux * (headLength * 0.7),
    y: b.y - uy * (headLength * 0.7),
  });
  // Triangle vertices: tip = b; back-left/back-right perpendicular to (ux, uy).
  const backCenter = { x: b.x - ux * headLength, y: b.y - uy * headLength };
  const px = -uy;
  const py = ux;
  const backLeft: ScreenPoint = Object.freeze({
    x: backCenter.x + px * halfWidth,
    y: backCenter.y + py * halfWidth,
  });
  const backRight: ScreenPoint = Object.freeze({
    x: backCenter.x - px * halfWidth,
    y: backCenter.y - py * halfWidth,
  });
  return Object.freeze({
    kind: "arrow" as const,
    anchors: Object.freeze([a, b] as const),
    shaft: Object.freeze([a, shaftEnd] as const),
    head: Object.freeze([b, backLeft, backRight] as const),
    headLength,
  });
}

function projectDateRange(d: DateRangeDrawing, ctx: ProjectionContext): DateRangeGeom {
  const a = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[0].time), Number(d.anchors[0].price));
  const b = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[1].time), Number(d.anchors[1].price));
  const xLeft = Math.min(a.x, b.x);
  const xRight = Math.max(a.x, b.x);
  // Date-range spans the full plot height.
  const yTop = 0;
  const yBottom = ctx.plotRect.h;
  const badgeAnchor: ScreenPoint = Object.freeze({ x: (xLeft + xRight) / 2, y: 4 });
  return Object.freeze({
    kind: "dateRange" as const,
    anchors: Object.freeze([a, b] as const),
    xLeft,
    xRight,
    yTop,
    yBottom,
    badgeAnchor,
  });
}

function projectPriceRange(d: PriceRangeDrawing, ctx: ProjectionContext): PriceRangeGeom {
  const a = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[0].time), Number(d.anchors[0].price));
  const b = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[1].time), Number(d.anchors[1].price));
  const yTop = Math.min(a.y, b.y);
  const yBottom = Math.max(a.y, b.y);
  const xLeft = 0;
  const xRight = ctx.plotRect.w;
  const badgeAnchor: ScreenPoint = Object.freeze({ x: xRight - 8, y: (yTop + yBottom) / 2 });
  return Object.freeze({
    kind: "priceRange" as const,
    anchors: Object.freeze([a, b] as const),
    xLeft,
    xRight,
    yTop,
    yBottom,
    badgeAnchor,
  });
}

function projectPriceDateRange(d: PriceDateRangeDrawing, ctx: ProjectionContext): PriceDateRangeGeom {
  const a = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[0].time), Number(d.anchors[0].price));
  const b = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[1].time), Number(d.anchors[1].price));
  const xLeft = Math.min(a.x, b.x);
  const xRight = Math.max(a.x, b.x);
  const yTop = Math.min(a.y, b.y);
  const yBottom = Math.max(a.y, b.y);
  const badgeAnchor: ScreenPoint = Object.freeze({ x: (xLeft + xRight) / 2, y: yTop });
  return Object.freeze({
    kind: "priceDateRange" as const,
    anchors: Object.freeze([a, b] as const),
    xLeft,
    xRight,
    yTop,
    yBottom,
    badgeAnchor,
  });
}

// ─── Phase 13 Cycle C.1 — exotic geometry projectors ───────────────────────

function resolveExtendDefault(extend: ExtendMode | undefined, fallback: ExtendMode): ExtendMode {
  return extend ?? fallback;
}

function projectPitchfork(d: PitchforkDrawing, ctx: ProjectionContext): PitchforkGeom {
  const pivot = d.anchors[0];
  const r1 = d.anchors[1];
  const r2 = d.anchors[2];
  const base = computePitchforkCenterlineBase(
    d.variant,
    { time: Number(pivot.time), price: Number(pivot.price) },
    { time: Number(r1.time), price: Number(r1.price) },
    { time: Number(r2.time), price: Number(r2.price) },
  );
  const pPx = projectAnchor(ctx.timeScale, ctx.priceScale, Number(pivot.time), Number(pivot.price));
  const r1Px = projectAnchor(ctx.timeScale, ctx.priceScale, Number(r1.time), Number(r1.price));
  const r2Px = projectAnchor(ctx.timeScale, ctx.priceScale, Number(r2.time), Number(r2.price));
  const basePx = projectAnchor(ctx.timeScale, ctx.priceScale, base.time, base.price);
  // Centreline direction vector in screen space.
  const dx = basePx.x - pPx.x;
  const dy = basePx.y - pPx.y;
  // Upper / lower rail anchors: same direction, translated by (r{1,2} - pivot).
  const upperA: ScreenPoint = Object.freeze({ x: r1Px.x, y: r1Px.y });
  const upperB: ScreenPoint = Object.freeze({ x: r1Px.x + dx, y: r1Px.y + dy });
  const lowerA: ScreenPoint = Object.freeze({ x: r2Px.x, y: r2Px.y });
  const lowerB: ScreenPoint = Object.freeze({ x: r2Px.x + dx, y: r2Px.y + dy });
  const extend = resolveExtendDefault(d.style.extend, "right");
  const centerline = extendSegment(pPx, basePx, extend, ctx.plotRect);
  const upperRail = extendSegment(upperA, upperB, extend, ctx.plotRect);
  const lowerRail = extendSegment(lowerA, lowerB, extend, ctx.plotRect);
  const xs = [
    centerline[0].x,
    centerline[1].x,
    upperRail[0].x,
    upperRail[1].x,
    lowerRail[0].x,
    lowerRail[1].x,
    pPx.x,
    r1Px.x,
    r2Px.x,
  ];
  const ys = [
    centerline[0].y,
    centerline[1].y,
    upperRail[0].y,
    upperRail[1].y,
    lowerRail[0].y,
    lowerRail[1].y,
    pPx.y,
    r1Px.y,
    r2Px.y,
  ];
  return Object.freeze({
    kind: "pitchfork" as const,
    anchors: Object.freeze([pPx, r1Px, r2Px] as const),
    centerline,
    upperRail,
    lowerRail,
    bbox: Object.freeze({
      xMin: Math.min(...xs),
      xMax: Math.max(...xs),
      yMin: Math.min(...ys),
      yMax: Math.max(...ys),
    }),
  });
}

function projectGannFan(d: GannFanDrawing, ctx: ProjectionContext): GannFanGeom {
  const pivot = d.anchors[0];
  const dir = d.anchors[1];
  const pivotT = Number(pivot.time);
  const pivotP = Number(pivot.price);
  const dirT = Number(dir.time);
  const dirP = Number(dir.price);
  const pPx = projectAnchor(ctx.timeScale, ctx.priceScale, pivotT, pivotP);
  const dPx = projectAnchor(ctx.timeScale, ctx.priceScale, dirT, dirP);
  const dt = dirT - pivotT;
  const dp = dirP - pivotP;
  const rays: GannRayGeom[] = [];
  let xMin = pPx.x;
  let xMax = pPx.x;
  let yMin = pPx.y;
  let yMax = pPx.y;
  // Degenerate: zero-vector or non-finite — emit empty fan.
  if (
    !Number.isFinite(dt) ||
    !Number.isFinite(dp) ||
    Math.abs(dt) < 1e-12 ||
    Math.abs(dp) < 1e-12
  ) {
    return Object.freeze({
      kind: "gannFan" as const,
      anchors: Object.freeze([pPx, dPx] as const),
      rays: Object.freeze([] as readonly GannRayGeom[]),
      bbox: Object.freeze({ xMin, xMax, yMin, yMax }),
    });
  }
  const extend = resolveExtendDefault(d.style.extend, "right");
  const sgnT = Math.sign(dt);
  const baseSlope = dp / dt; // 1×1 ratio in price/time space.
  for (const mult of GANN_FAN_SLOPES) {
    const slopePT = baseSlope * mult; // price per time for this ray.
    // Direction-target time: same sign as `dt` so the ray points "forward".
    const targetT = pivotT + sgnT * Math.abs(dt);
    const targetP = pivotP + slopePT * (targetT - pivotT);
    const targetPx = projectAnchor(ctx.timeScale, ctx.priceScale, targetT, targetP);
    const visible = extendSegment(pPx, targetPx, extend, ctx.plotRect);
    rays.push(Object.freeze({ slope: mult, visible }));
    xMin = Math.min(xMin, visible[0].x, visible[1].x);
    xMax = Math.max(xMax, visible[0].x, visible[1].x);
    yMin = Math.min(yMin, visible[0].y, visible[1].y);
    yMax = Math.max(yMax, visible[0].y, visible[1].y);
  }
  return Object.freeze({
    kind: "gannFan" as const,
    anchors: Object.freeze([pPx, dPx] as const),
    rays: Object.freeze(rays),
    bbox: Object.freeze({ xMin, xMax, yMin, yMax }),
  });
}

function projectEllipse(d: EllipseDrawing, ctx: ProjectionContext): EllipseGeom {
  const a = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[0].time), Number(d.anchors[0].price));
  const b = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[1].time), Number(d.anchors[1].price));
  const xMin = Math.min(a.x, b.x);
  const xMax = Math.max(a.x, b.x);
  const yMin = Math.min(a.y, b.y);
  const yMax = Math.max(a.y, b.y);
  const cx = (xMin + xMax) / 2;
  const cy = (yMin + yMax) / 2;
  const rx = (xMax - xMin) / 2;
  const ry = (yMax - yMin) / 2;
  return Object.freeze({
    kind: "ellipse" as const,
    anchors: Object.freeze([a, b] as const),
    cx,
    cy,
    rx,
    ry,
    xMin,
    xMax,
    yMin,
    yMax,
  });
}

// ─── Phase 13 Cycle C.2 — fib variant projectors ──────────────────────────

function projectFibExtension(d: FibExtensionDrawing, ctx: ProjectionContext): FibExtensionGeom {
  const aPrice = Number(d.anchors[0].price);
  const bPrice = Number(d.anchors[1].price);
  const cPrice = Number(d.anchors[2].price);
  const a = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[0].time), aPrice);
  const b = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[1].time), bPrice);
  const c = projectAnchor(ctx.timeScale, ctx.priceScale, Number(d.anchors[2].time), cPrice);
  const xMin = Math.min(a.x, b.x, c.x);
  const xMax = Math.max(a.x, b.x, c.x);
  const span = bPrice - aPrice;
  const finite = Number.isFinite(span) && Number.isFinite(cPrice);
  const levels: FibLevelGeom[] = [];
  let yMin = Math.min(a.y, b.y, c.y);
  let yMax = Math.max(a.y, b.y, c.y);
  for (const lvl of d.levels) {
    const visible = lvl.visible !== false;
    if (!finite) {
      levels.push(makeLevel(lvl, c.y, cPrice, visible));
      continue;
    }
    const price = cPrice + lvl.value * span;
    const yPx = Number(ctx.priceScale.valueToPixel(price));
    const safeY = Number.isFinite(yPx) ? yPx : c.y;
    yMin = Math.min(yMin, safeY);
    yMax = Math.max(yMax, safeY);
    levels.push(makeLevel(lvl, safeY, price, visible));
  }
  const anchors: readonly [ScreenPoint, ScreenPoint, ScreenPoint] = Object.freeze([a, b, c] as const);
  return Object.freeze({
    kind: "fibExtension" as const,
    anchors,
    xMin,
    xMax,
    levels: Object.freeze(levels),
    bbox: Object.freeze({ xMin, xMax, yMin, yMax }),
  });
}

function projectFibTimeZones(d: FibTimeZonesDrawing, ctx: ProjectionContext): FibTimeZonesGeom {
  const originTime = Number(d.anchors[0].time);
  const originPrice = Number(d.anchors[0].price);
  const anchor = projectAnchor(ctx.timeScale, ctx.priceScale, originTime, originPrice);
  const intervalMs = Number(ctx.timeScale.intervalDuration);
  const intervalOk = Number.isFinite(intervalMs) && intervalMs > 0;
  const zones: FibTimeZoneGeom[] = [];
  let xMin = anchor.x;
  let xMax = anchor.x;
  if (intervalOk && Number.isFinite(originTime)) {
    for (const offset of d.offsets) {
      if (!Number.isFinite(offset) || offset <= 0 || !Number.isInteger(offset)) {
        continue;
      }
      const time = originTime + offset * intervalMs;
      const xPx = Number(ctx.timeScale.timeToPixel(time as never));
      const safeX = Number.isFinite(xPx) ? xPx : anchor.x;
      const snappedX = pixelSnap(safeX);
      zones.push(Object.freeze({ offset, x: safeX, snappedX, time }));
      xMin = Math.min(xMin, safeX);
      xMax = Math.max(xMax, safeX);
    }
  }
  const y1 = 0;
  const y2 = ctx.plotRect.h;
  return Object.freeze({
    kind: "fibTimeZones" as const,
    anchor,
    zones: Object.freeze(zones),
    intervalMissing: !intervalOk,
    y1,
    y2,
    bbox: Object.freeze({ xMin, xMax, yMin: y1, yMax: y2 }),
  });
}

function projectFibFan(d: FibFanDrawing, ctx: ProjectionContext): FibFanGeom {
  const aTime = Number(d.anchors[0].time);
  const aPrice = Number(d.anchors[0].price);
  const bTime = Number(d.anchors[1].time);
  const bPrice = Number(d.anchors[1].price);
  const aPx = projectAnchor(ctx.timeScale, ctx.priceScale, aTime, aPrice);
  const bPx = projectAnchor(ctx.timeScale, ctx.priceScale, bTime, bPrice);
  const dt = bTime - aTime;
  const dp = bPrice - aPrice;
  const rays: FibFanRayGeom[] = [];
  let xMin = aPx.x;
  let xMax = aPx.x;
  let yMin = aPx.y;
  let yMax = aPx.y;
  if (
    Number.isFinite(dt) &&
    Number.isFinite(dp) &&
    Math.abs(dt) >= 1e-12 &&
    Math.abs(dp) >= 1e-12
  ) {
    for (const lvl of d.levels) {
      if (lvl.visible === false) {
        continue;
      }
      const yPrice = aPrice + lvl.value * dp;
      const targetPx = projectAnchor(ctx.timeScale, ctx.priceScale, bTime, yPrice);
      const visible = extendSegment(aPx, targetPx, "right", ctx.plotRect);
      rays.push(Object.freeze({ level: lvl.value, visible }));
      xMin = Math.min(xMin, visible[0].x, visible[1].x);
      xMax = Math.max(xMax, visible[0].x, visible[1].x);
      yMin = Math.min(yMin, visible[0].y, visible[1].y);
      yMax = Math.max(yMax, visible[0].y, visible[1].y);
    }
  }
  return Object.freeze({
    kind: "fibFan" as const,
    anchors: Object.freeze([aPx, bPx] as const),
    rays: Object.freeze(rays),
    bbox: Object.freeze({ xMin, xMax, yMin, yMax }),
  });
}

function projectFibArcs(d: FibArcsDrawing, ctx: ProjectionContext): FibArcsGeom {
  const aPx = projectAnchor(
    ctx.timeScale,
    ctx.priceScale,
    Number(d.anchors[0].time),
    Number(d.anchors[0].price),
  );
  const bPx = projectAnchor(
    ctx.timeScale,
    ctx.priceScale,
    Number(d.anchors[1].time),
    Number(d.anchors[1].price),
  );
  const dx = bPx.x - aPx.x;
  const dy = bPx.y - aPx.y;
  const r = Number.isFinite(dx) && Number.isFinite(dy) ? Math.hypot(dx, dy) : 0;
  const rings: FibArcRingGeom[] = [];
  let rMax = 0;
  for (const lvl of d.levels) {
    if (lvl.visible === false) {
      continue;
    }
    const ringR = r * lvl.value;
    rings.push(Object.freeze({ level: lvl.value, r: ringR }));
    if (ringR > rMax) {
      rMax = ringR;
    }
  }
  // Bbox covers the bottom half-arcs only: x ∈ [cx - rMax, cx + rMax],
  // y ∈ [cy, cy + rMax]. Caller's bbox prefilter must respect the half.
  return Object.freeze({
    kind: "fibArcs" as const,
    anchors: Object.freeze([aPx, bPx] as const),
    cx: aPx.x,
    cy: aPx.y,
    r,
    rings: Object.freeze(rings),
    bbox: Object.freeze({
      xMin: aPx.x - rMax,
      xMax: aPx.x + rMax,
      yMin: aPx.y,
      yMax: aPx.y + rMax,
    }),
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
    case "ray":
      return projectRay(d, ctx);
    case "extendedLine":
      return projectExtendedLine(d, ctx);
    case "horizontalRay":
      return projectHorizontalRay(d, ctx);
    case "parallelChannel":
      return projectParallelChannel(d, ctx);
    case "longPosition":
    case "shortPosition":
      return projectPosition(d, ctx);
    case "text":
      return projectText(d, ctx);
    case "callout":
      return projectCallout(d, ctx);
    case "arrow":
      return projectArrow(d, ctx);
    case "dateRange":
      return projectDateRange(d, ctx);
    case "priceRange":
      return projectPriceRange(d, ctx);
    case "priceDateRange":
      return projectPriceDateRange(d, ctx);
    case "pitchfork":
      return projectPitchfork(d, ctx);
    case "gannFan":
      return projectGannFan(d, ctx);
    case "ellipse":
      return projectEllipse(d, ctx);
    case "fibExtension":
      return projectFibExtension(d, ctx);
    case "fibTimeZones":
      return projectFibTimeZones(d, ctx);
    case "fibFan":
      return projectFibFan(d, ctx);
    case "fibArcs":
      return projectFibArcs(d, ctx);
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
