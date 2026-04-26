/**
 * Pixi v8 rendering for drawings + anchor handles. The controller calls
 * `redrawDrawing(g, drawing, geom, theme, dpr)` once per drawing per
 * `'drawings'` flush; `g` is pooled, so we `clear()` then re-draw.
 *
 * Anchor handles are drawn into a SECOND graphics that lives on the
 * `drawingsHandlesLayer` (outside the plot clip) and use a SHARED
 * `GraphicsContext` so 200 drawings × 2 handles share the same ~12-vertex
 * circle geometry rather than re-uploading it per drawing.
 */

import { Graphics, GraphicsContext } from "pixi.js";
import type { Theme } from "../../types.js";
import type {
  Drawing,
  DrawingStroke,
  ExtendMode,
} from "./types.js";
import type {
  ArrowGeom,
  CalloutGeom,
  DateRangeGeom,
  EllipseGeom,
  ExtendedLineGeom,
  FibRetracementGeom,
  GannFanGeom,
  HorizontalLineGeom,
  HorizontalRayGeom,
  ParallelChannelGeom,
  PitchforkGeom,
  PositionGeom,
  PriceDateRangeGeom,
  PriceRangeGeom,
  RayGeom,
  RectangleGeom,
  ScreenGeom,
  TextGeom,
  TrendlineGeom,
  VerticalLineGeom,
} from "./project.js";

export type HandleVariant = "normal" | "hover" | "active";

interface ResolvedStroke {
  readonly color: number;
  readonly alpha: number;
  readonly width: number;
  readonly style: "solid" | "dashed" | "dotted";
}

function resolveStroke(stroke: DrawingStroke | undefined, theme: Theme, dpr: number): ResolvedStroke {
  const baseWidth = stroke?.width ?? 1;
  const dprBucket = dpr <= 1 ? 1 : dpr <= 1.5 ? 1.5 : 2;
  return Object.freeze({
    color: stroke?.color ?? theme.line,
    alpha: stroke?.alpha ?? 1,
    width: baseWidth * dprBucket,
    style: stroke?.style ?? "solid",
  });
}

function drawSegment(
  g: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke: ResolvedStroke,
): void {
  if (stroke.style === "dashed" || stroke.style === "dotted") {
    drawDashedSegment(g, x1, y1, x2, y2, stroke);
    return;
  }
  g.moveTo(x1, y1).lineTo(x2, y2).stroke({
    color: stroke.color,
    alpha: stroke.alpha,
    width: stroke.width,
  });
}

function drawDashedSegment(
  g: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke: ResolvedStroke,
): void {
  const dash = stroke.style === "dotted" ? [1, 3] : [6, 3];
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0) {
    return;
  }
  const ux = dx / length;
  const uy = dy / length;
  let traveled = 0;
  let on = true;
  while (traveled < length) {
    const idx = on ? 0 : 1;
    const segLen = Math.min(dash[idx] ?? 0, length - traveled);
    if (on && segLen > 0) {
      const sx = x1 + ux * traveled;
      const sy = y1 + uy * traveled;
      const ex = x1 + ux * (traveled + segLen);
      const ey = y1 + uy * (traveled + segLen);
      g.moveTo(sx, sy).lineTo(ex, ey).stroke({
        color: stroke.color,
        alpha: stroke.alpha,
        width: stroke.width,
      });
    }
    traveled += segLen;
    on = !on;
  }
}

function drawTrendline(g: Graphics, geom: TrendlineGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  const v0 = geom.visible[0];
  const v1 = geom.visible[1];
  drawSegment(g, v0.x, v0.y, v1.x, v1.y, stroke);
}

function drawHorizontal(g: Graphics, geom: HorizontalLineGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  drawSegment(g, geom.x1, geom.snappedY, geom.x2, geom.snappedY, stroke);
}

function drawVertical(g: Graphics, geom: VerticalLineGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  drawSegment(g, geom.snappedX, geom.y1, geom.snappedX, geom.y2, stroke);
}

function drawRectangle(g: Graphics, geom: RectangleGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  const fill = drawing.style.fill;
  const x = geom.xMin;
  const y = geom.yMin;
  const w = geom.xMax - geom.xMin;
  const h = geom.yMax - geom.yMin;
  if (fill !== undefined) {
    g.rect(x, y, w, h).fill({ color: fill.color, alpha: fill.alpha ?? 0.2 });
  }
  // Border (sub-pixel snap so 1-px strokes render sharply).
  const sx = Math.round(x) + 0.5;
  const sy = Math.round(y) + 0.5;
  g.rect(sx, sy, Math.max(0, w - 1), Math.max(0, h - 1)).stroke({
    color: stroke.color,
    alpha: stroke.alpha,
    width: stroke.width,
  });
}

function drawRay(g: Graphics, geom: RayGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  const v0 = geom.visible[0];
  const v1 = geom.visible[1];
  drawSegment(g, v0.x, v0.y, v1.x, v1.y, stroke);
}

function drawExtendedLine(g: Graphics, geom: ExtendedLineGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  const v0 = geom.visible[0];
  const v1 = geom.visible[1];
  drawSegment(g, v0.x, v0.y, v1.x, v1.y, stroke);
}

function drawHorizontalRay(g: Graphics, geom: HorizontalRayGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  drawSegment(g, geom.x1, geom.snappedY, geom.x2, geom.snappedY, stroke);
}

function drawParallelChannel(g: Graphics, geom: ParallelChannelGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  const fill = drawing.style.fill;
  // Fill the polygon first so strokes sit on top.
  const fillColor = fill?.color ?? stroke.color;
  const fillAlpha = fill?.alpha ?? 0.10;
  if (fillAlpha > 0) {
    const flat: number[] = [];
    for (const p of geom.polygon) {
      flat.push(p.x, p.y);
    }
    g.poly(flat).fill({ color: fillColor, alpha: fillAlpha });
  }
  // Top + bottom strokes.
  drawSegment(g, geom.top[0].x, geom.top[0].y, geom.top[1].x, geom.top[1].y, stroke);
  drawSegment(g, geom.bottom[0].x, geom.bottom[0].y, geom.bottom[1].x, geom.bottom[1].y, stroke);
}

function drawFib(g: Graphics, geom: FibRetracementGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  // Trend connector between anchors (subtle).
  const a0 = geom.anchors[0];
  const a1 = geom.anchors[1];
  g.moveTo(a0.x, a0.y).lineTo(a1.x, a1.y).stroke({
    color: stroke.color,
    alpha: stroke.alpha * 0.55,
    width: Math.max(1, stroke.width * 0.8),
  });
  // Level lines.
  for (const lvl of geom.levels) {
    if (!lvl.visible) {
      continue;
    }
    g.moveTo(geom.xMin, lvl.snappedY).lineTo(geom.xMax, lvl.snappedY).stroke({
      color: lvl.color ?? stroke.color,
      alpha: lvl.alpha ?? stroke.alpha,
      width: stroke.width,
    });
  }
}

function drawPosition(g: Graphics, geom: PositionGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  // Reward zone (green-ish) + risk zone (red-ish) regardless of long/short —
  // the projector already places `tp` in the reward rect.
  const rewardColor = theme.up;
  const riskColor = theme.down;
  const rewardW = geom.rewardRect.xRight - geom.rewardRect.xLeft;
  const rewardH = Math.max(0, geom.rewardRect.yBottom - geom.rewardRect.yTop);
  const riskW = geom.riskRect.xRight - geom.riskRect.xLeft;
  const riskH = Math.max(0, geom.riskRect.yBottom - geom.riskRect.yTop);
  if (rewardW > 0 && rewardH > 0) {
    g.rect(geom.rewardRect.xLeft, geom.rewardRect.yTop, rewardW, rewardH).fill({
      color: rewardColor,
      alpha: 0.18,
    });
  }
  if (riskW > 0 && riskH > 0) {
    g.rect(geom.riskRect.xLeft, geom.riskRect.yTop, riskW, riskH).fill({
      color: riskColor,
      alpha: 0.18,
    });
  }
  // Entry signal line (sub-pixel snapped 1-px stroke).
  const entryY = Math.round(geom.entry.y) + 0.5;
  g.moveTo(geom.rewardRect.xLeft, entryY).lineTo(geom.rewardRect.xRight, entryY).stroke({
    color: stroke.color,
    alpha: stroke.alpha,
    width: stroke.width,
  });
  // SL line (red).
  const slY = Math.round(geom.sl.y) + 0.5;
  g.moveTo(geom.riskRect.xLeft, slY).lineTo(geom.riskRect.xRight, slY).stroke({
    color: riskColor,
    alpha: 0.9,
    width: stroke.width,
  });
  // TP line (green).
  const tpY = Math.round(geom.tp.y) + 0.5;
  g.moveTo(geom.rewardRect.xLeft, tpY).lineTo(geom.rewardRect.xRight, tpY).stroke({
    color: rewardColor,
    alpha: 0.9,
    width: stroke.width,
  });
}

function drawText(g: Graphics, geom: TextGeom, drawing: Drawing, theme: Theme): void {
  // The pill background + actual text are emitted by `DrawingTextPool` from
  // the controller. Here we draw a subtle anchor dot at the pin location so
  // an empty-text drawing remains visually selectable.
  const dotColor = drawing.style.text?.color ?? theme.text;
  g.circle(geom.anchor.x, geom.anchor.y, 2).fill({ color: dotColor, alpha: 0.7 });
}

function drawCallout(g: Graphics, geom: CalloutGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  // Pin marker.
  g.circle(geom.pin.x, geom.pin.y, 3).fill({ color: stroke.color, alpha: 1 });
  // Leader line (only when pin is outside label bbox).
  if (geom.leaderEnd !== null) {
    g.moveTo(geom.pin.x, geom.pin.y)
      .lineTo(geom.leaderEnd.x, geom.leaderEnd.y)
      .stroke({ color: stroke.color, alpha: stroke.alpha, width: stroke.width });
  }
  // Label background; the pool draws the actual BitmapText pill.
  // We only stroke the bbox border at low alpha so the box is visible when
  // it is empty (zero-text bbox is clipped to 0).
  const fill = drawing.style.fill;
  if (geom.labelW > 0 && geom.labelH > 0 && fill !== undefined) {
    g.rect(geom.labelX, geom.labelY, geom.labelW, geom.labelH).fill({
      color: fill.color,
      alpha: fill.alpha ?? 0.12,
    });
  }
}

function drawArrow(g: Graphics, geom: ArrowGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  const v0 = geom.shaft[0];
  const v1 = geom.shaft[1];
  // Skip degenerate arrows (zero-length).
  if (geom.headLength <= 0 || (v0.x === v1.x && v0.y === v1.y)) {
    return;
  }
  drawSegment(g, v0.x, v0.y, v1.x, v1.y, stroke);
  const tip = geom.head[0];
  const bl = geom.head[1];
  const br = geom.head[2];
  g.poly([tip.x, tip.y, bl.x, bl.y, br.x, br.y]).fill({
    color: stroke.color,
    alpha: stroke.alpha,
  });
}

function drawDateRange(g: Graphics, geom: DateRangeGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  const w = geom.xRight - geom.xLeft;
  if (w > 0) {
    g.rect(geom.xLeft, geom.yTop, w, geom.yBottom - geom.yTop).fill({
      color: drawing.style.fill?.color ?? theme.line,
      alpha: drawing.style.fill?.alpha ?? 0.08,
    });
  }
  const xL = Math.round(geom.xLeft) + 0.5;
  const xR = Math.round(geom.xRight) + 0.5;
  g.moveTo(xL, geom.yTop).lineTo(xL, geom.yBottom).stroke({
    color: stroke.color,
    alpha: stroke.alpha,
    width: stroke.width,
  });
  g.moveTo(xR, geom.yTop).lineTo(xR, geom.yBottom).stroke({
    color: stroke.color,
    alpha: stroke.alpha,
    width: stroke.width,
  });
}

function drawPriceRange(g: Graphics, geom: PriceRangeGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  const h = geom.yBottom - geom.yTop;
  if (h > 0) {
    g.rect(geom.xLeft, geom.yTop, geom.xRight - geom.xLeft, h).fill({
      color: drawing.style.fill?.color ?? theme.line,
      alpha: drawing.style.fill?.alpha ?? 0.08,
    });
  }
  const yT = Math.round(geom.yTop) + 0.5;
  const yB = Math.round(geom.yBottom) + 0.5;
  g.moveTo(geom.xLeft, yT).lineTo(geom.xRight, yT).stroke({
    color: stroke.color,
    alpha: stroke.alpha,
    width: stroke.width,
  });
  g.moveTo(geom.xLeft, yB).lineTo(geom.xRight, yB).stroke({
    color: stroke.color,
    alpha: stroke.alpha,
    width: stroke.width,
  });
}

function drawPriceDateRange(
  g: Graphics,
  geom: PriceDateRangeGeom,
  drawing: Drawing,
  theme: Theme,
  dpr: number,
): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  const w = geom.xRight - geom.xLeft;
  const h = geom.yBottom - geom.yTop;
  if (w > 0 && h > 0) {
    g.rect(geom.xLeft, geom.yTop, w, h).fill({
      color: drawing.style.fill?.color ?? theme.line,
      alpha: drawing.style.fill?.alpha ?? 0.08,
    });
    const x = Math.round(geom.xLeft) + 0.5;
    const y = Math.round(geom.yTop) + 0.5;
    g.rect(x, y, Math.max(0, w - 1), Math.max(0, h - 1)).stroke({
      color: stroke.color,
      alpha: stroke.alpha,
      width: stroke.width,
    });
  }
}

// ─── Phase 13 Cycle C.1 — exotic geometry renderers ────────────────────────

function drawPitchfork(g: Graphics, geom: PitchforkGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  // Centreline at full alpha; rails slightly fainter so the centreline reads
  // as the median (matches TradingView).
  const railStroke: ResolvedStroke = Object.freeze({
    color: stroke.color,
    alpha: stroke.alpha * 0.85,
    width: stroke.width,
    style: stroke.style,
  });
  const c0 = geom.centerline[0];
  const c1 = geom.centerline[1];
  drawSegment(g, c0.x, c0.y, c1.x, c1.y, stroke);
  const u0 = geom.upperRail[0];
  const u1 = geom.upperRail[1];
  drawSegment(g, u0.x, u0.y, u1.x, u1.y, railStroke);
  const l0 = geom.lowerRail[0];
  const l1 = geom.lowerRail[1];
  drawSegment(g, l0.x, l0.y, l1.x, l1.y, railStroke);
}

function drawGannFan(g: Graphics, geom: GannFanGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  for (const ray of geom.rays) {
    // 1×1 line gets full stroke; other slopes slightly faded so the 1×1 reads as primary.
    const isUnity = ray.slope === 1;
    const rayStroke: ResolvedStroke = isUnity
      ? stroke
      : Object.freeze({
          color: stroke.color,
          alpha: stroke.alpha * 0.7,
          width: stroke.width,
          style: stroke.style,
        });
    drawSegment(g, ray.visible[0].x, ray.visible[0].y, ray.visible[1].x, ray.visible[1].y, rayStroke);
  }
}

function drawEllipse(g: Graphics, geom: EllipseGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  // Degenerate radii — render nothing without throwing.
  if (geom.rx <= 0 || geom.ry <= 0) {
    return;
  }
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  const fill = drawing.style.fill;
  if (fill !== undefined) {
    g.ellipse(geom.cx, geom.cy, geom.rx, geom.ry).fill({
      color: fill.color,
      alpha: fill.alpha ?? 0.18,
    });
  }
  g.ellipse(geom.cx, geom.cy, geom.rx, geom.ry).stroke({
    color: stroke.color,
    alpha: stroke.alpha,
    width: stroke.width,
  });
}

export function redrawDrawing(
  g: Graphics,
  drawing: Drawing,
  geom: ScreenGeom,
  theme: Theme,
  dpr: number,
): void {
  g.clear();
  if (!drawing.visible) {
    g.visible = false;
    return;
  }
  g.visible = true;
  switch (geom.kind) {
    case "trendline":
      drawTrendline(g, geom, drawing, theme, dpr);
      return;
    case "horizontalLine":
      drawHorizontal(g, geom, drawing, theme, dpr);
      return;
    case "verticalLine":
      drawVertical(g, geom, drawing, theme, dpr);
      return;
    case "rectangle":
      drawRectangle(g, geom, drawing, theme, dpr);
      return;
    case "fibRetracement":
      drawFib(g, geom, drawing, theme, dpr);
      return;
    case "ray":
      drawRay(g, geom, drawing, theme, dpr);
      return;
    case "extendedLine":
      drawExtendedLine(g, geom, drawing, theme, dpr);
      return;
    case "horizontalRay":
      drawHorizontalRay(g, geom, drawing, theme, dpr);
      return;
    case "parallelChannel":
      drawParallelChannel(g, geom, drawing, theme, dpr);
      return;
    case "longPosition":
    case "shortPosition":
      drawPosition(g, geom, drawing, theme, dpr);
      return;
    case "text":
      drawText(g, geom, drawing, theme);
      return;
    case "callout":
      drawCallout(g, geom, drawing, theme, dpr);
      return;
    case "arrow":
      drawArrow(g, geom, drawing, theme, dpr);
      return;
    case "dateRange":
      drawDateRange(g, geom, drawing, theme, dpr);
      return;
    case "priceRange":
      drawPriceRange(g, geom, drawing, theme, dpr);
      return;
    case "priceDateRange":
      drawPriceDateRange(g, geom, drawing, theme, dpr);
      return;
    case "pitchfork":
      drawPitchfork(g, geom, drawing, theme, dpr);
      return;
    case "gannFan":
      drawGannFan(g, geom, drawing, theme, dpr);
      return;
    case "ellipse":
      drawEllipse(g, geom, drawing, theme, dpr);
      return;
  }
}

// ─── Handles ───────────────────────────────────────────────────────────────

const HANDLE_RADIUS_PX = 6;

export class HandleContextCache {
  private readonly cache = new Map<string, GraphicsContext>();

  get(variant: HandleVariant, theme: Theme, dpr: number): GraphicsContext {
    const radius = HANDLE_RADIUS_PX / Math.max(1, dpr);
    const fill = theme.background;
    const stroke = variant === "active" ? theme.up : theme.frame;
    const strokeWidth = variant === "hover" || variant === "active" ? 2 : 1;
    const key = `${variant}|${String(fill)}|${String(stroke)}|${String(strokeWidth)}|${String(radius)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const ctx = new GraphicsContext()
      .circle(0, 0, radius)
      .fill({ color: fill, alpha: 1 })
      .circle(0, 0, radius)
      .stroke({ color: stroke, alpha: 1, width: strokeWidth });
    this.cache.set(key, ctx);
    return ctx;
  }

  destroy(): void {
    for (const ctx of this.cache.values()) {
      ctx.destroy();
    }
    this.cache.clear();
  }
}

export interface HandleSpec {
  readonly key: number | string;
  readonly x: number;
  readonly y: number;
  readonly variant: HandleVariant;
}

/**
 * Replaces the children of `parent` with one Graphics per handle in `specs`,
 * each using a shared `GraphicsContext` from `cache`. Reuses Graphics across
 * calls (parent's child count grows monotonically; extras are hidden).
 */
export function syncHandleGraphics(
  pool: Graphics[],
  specs: readonly HandleSpec[],
  cache: HandleContextCache,
  theme: Theme,
  dpr: number,
  parent: { addChild: (g: Graphics) => Graphics },
): void {
  let i = 0;
  for (; i < specs.length; i++) {
    const spec = specs[i];
    if (spec === undefined) {
      continue;
    }
    let g = pool[i];
    if (g === undefined) {
      g = new Graphics();
      pool.push(g);
      parent.addChild(g);
    }
    g.context = cache.get(spec.variant, theme, dpr);
    g.position.set(spec.x, spec.y);
    g.visible = true;
  }
  for (let j = i; j < pool.length; j++) {
    const g = pool[j];
    if (g !== undefined) {
      g.visible = false;
    }
  }
}

/**
 * Compute the anchor-handle specs for a drawing in selected state.
 * Off-plot handles are filtered out so we never draw a floating handle.
 *
 * Cycle A simplification: rectangles render handles only at the two stored
 * anchor positions (cycle B can extend to derived corners + edge-midpoints).
 */
/** Phase 13 Cycle B.2 — handle key superset. `'time-end'` is the position-tool right-edge puller. */
export type HandleKey = number | "corner-tr" | "corner-bl" | "time-end";

export function handleSpecsFor(
  geom: ScreenGeom,
  hoveredHandle: HandleKey | null,
  draggingHandle: HandleKey | null,
  plot: { readonly w: number; readonly h: number },
): readonly HandleSpec[] {
  const specs: HandleSpec[] = [];
  const tol = 8;
  const inPlot = (x: number, y: number): boolean =>
    x >= -tol && x <= plot.w + tol && y >= -tol && y <= plot.h + tol;
  const variantFor = (key: HandleKey): HandleVariant =>
    draggingHandle === key ? "active" : hoveredHandle === key ? "hover" : "normal";
  switch (geom.kind) {
    case "trendline":
    case "fibRetracement":
    case "rectangle":
    case "ray":
    case "extendedLine": {
      const a0 = geom.anchors[0];
      const a1 = geom.anchors[1];
      if (inPlot(a0.x, a0.y)) {
        specs.push(Object.freeze({ key: 0, x: a0.x, y: a0.y, variant: variantFor(0) }));
      }
      if (inPlot(a1.x, a1.y)) {
        specs.push(Object.freeze({ key: 1, x: a1.x, y: a1.y, variant: variantFor(1) }));
      }
      return specs;
    }
    case "horizontalLine":
    case "verticalLine":
    case "horizontalRay": {
      const a = geom.anchor;
      if (inPlot(a.x, a.y)) {
        specs.push(Object.freeze({ key: 0, x: a.x, y: a.y, variant: variantFor(0) }));
      }
      return specs;
    }
    case "parallelChannel": {
      const a0 = geom.anchors[0];
      const a1 = geom.anchors[1];
      const a2 = geom.anchors[2];
      if (inPlot(a0.x, a0.y)) {
        specs.push(Object.freeze({ key: 0, x: a0.x, y: a0.y, variant: variantFor(0) }));
      }
      if (inPlot(a1.x, a1.y)) {
        specs.push(Object.freeze({ key: 1, x: a1.x, y: a1.y, variant: variantFor(1) }));
      }
      if (inPlot(a2.x, a2.y)) {
        specs.push(Object.freeze({ key: 2, x: a2.x, y: a2.y, variant: variantFor(2) }));
      }
      return specs;
    }
    case "longPosition":
    case "shortPosition": {
      // Entry circle at left edge (entryX, entryY); SL/TP squares at the
      // right edge (endX, sl.y) / (endX, tp.y); time-end puller midway down
      // the right edge.
      if (inPlot(geom.entry.x, geom.entry.y)) {
        specs.push(Object.freeze({ key: 0, x: geom.entry.x, y: geom.entry.y, variant: variantFor(0) }));
      }
      if (inPlot(geom.endX, geom.sl.y)) {
        specs.push(Object.freeze({ key: 1, x: geom.endX, y: geom.sl.y, variant: variantFor(1) }));
      }
      if (inPlot(geom.endX, geom.tp.y)) {
        specs.push(Object.freeze({ key: 2, x: geom.endX, y: geom.tp.y, variant: variantFor(2) }));
      }
      const timeEndY = (geom.sl.y + geom.tp.y) / 2;
      if (inPlot(geom.endX, timeEndY)) {
        specs.push(Object.freeze({ key: "time-end", x: geom.endX, y: timeEndY, variant: variantFor("time-end") }));
      }
      return specs;
    }
    case "text": {
      const a = geom.anchor;
      if (inPlot(a.x, a.y)) {
        specs.push(Object.freeze({ key: 0, x: a.x, y: a.y, variant: variantFor(0) }));
      }
      return specs;
    }
    case "callout": {
      if (inPlot(geom.pin.x, geom.pin.y)) {
        specs.push(Object.freeze({ key: 0, x: geom.pin.x, y: geom.pin.y, variant: variantFor(0) }));
      }
      if (inPlot(geom.labelCenter.x, geom.labelCenter.y)) {
        specs.push(
          Object.freeze({ key: 1, x: geom.labelCenter.x, y: geom.labelCenter.y, variant: variantFor(1) }),
        );
      }
      return specs;
    }
    case "arrow": {
      const a0 = geom.anchors[0];
      const a1 = geom.anchors[1];
      if (inPlot(a0.x, a0.y)) {
        specs.push(Object.freeze({ key: 0, x: a0.x, y: a0.y, variant: variantFor(0) }));
      }
      if (inPlot(a1.x, a1.y)) {
        specs.push(Object.freeze({ key: 1, x: a1.x, y: a1.y, variant: variantFor(1) }));
      }
      return specs;
    }
    case "dateRange":
    case "priceRange":
    case "priceDateRange": {
      const a0 = geom.anchors[0];
      const a1 = geom.anchors[1];
      if (inPlot(a0.x, a0.y)) {
        specs.push(Object.freeze({ key: 0, x: a0.x, y: a0.y, variant: variantFor(0) }));
      }
      if (inPlot(a1.x, a1.y)) {
        specs.push(Object.freeze({ key: 1, x: a1.x, y: a1.y, variant: variantFor(1) }));
      }
      return specs;
    }
    case "pitchfork": {
      const a0 = geom.anchors[0];
      const a1 = geom.anchors[1];
      const a2 = geom.anchors[2];
      if (inPlot(a0.x, a0.y)) {
        specs.push(Object.freeze({ key: 0, x: a0.x, y: a0.y, variant: variantFor(0) }));
      }
      if (inPlot(a1.x, a1.y)) {
        specs.push(Object.freeze({ key: 1, x: a1.x, y: a1.y, variant: variantFor(1) }));
      }
      if (inPlot(a2.x, a2.y)) {
        specs.push(Object.freeze({ key: 2, x: a2.x, y: a2.y, variant: variantFor(2) }));
      }
      return specs;
    }
    case "gannFan":
    case "ellipse": {
      const a0 = geom.anchors[0];
      const a1 = geom.anchors[1];
      if (inPlot(a0.x, a0.y)) {
        specs.push(Object.freeze({ key: 0, x: a0.x, y: a0.y, variant: variantFor(0) }));
      }
      if (inPlot(a1.x, a1.y)) {
        specs.push(Object.freeze({ key: 1, x: a1.x, y: a1.y, variant: variantFor(1) }));
      }
      return specs;
    }
  }
}

export function resolveExtendMode(extend: ExtendMode | undefined): ExtendMode {
  return extend ?? "none";
}
