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
  ExtendedLineGeom,
  FibRetracementGeom,
  HorizontalLineGeom,
  HorizontalRayGeom,
  ParallelChannelGeom,
  RayGeom,
  RectangleGeom,
  ScreenGeom,
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
export function handleSpecsFor(
  geom: ScreenGeom,
  hoveredHandle: number | "corner-tr" | "corner-bl" | null,
  draggingHandle: number | "corner-tr" | "corner-bl" | null,
  plot: { readonly w: number; readonly h: number },
): readonly HandleSpec[] {
  const specs: HandleSpec[] = [];
  const tol = 8;
  const inPlot = (x: number, y: number): boolean =>
    x >= -tol && x <= plot.w + tol && y >= -tol && y <= plot.h + tol;
  const variantFor = (key: number | "corner-tr" | "corner-bl"): HandleVariant =>
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
  }
}

export function resolveExtendMode(extend: ExtendMode | undefined): ExtendMode {
  return extend ?? "none";
}
