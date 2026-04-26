/**
 * Pure hit-test utilities for drawings. All inputs are plot-local pixels
 * (caller has already subtracted `plotRect.x/y`). Tolerances are pre-resolved
 * to the active pointer-type / DPR.
 */

import type { Drawing } from "./types.js";
import type {
  ArrowGeom,
  BrushGeom,
  CalloutGeom,
  DateRangeGeom,
  EllipseGeom,
  ExtendedLineGeom,
  FibArcsGeom,
  FibExtensionGeom,
  FibFanGeom,
  FibRetracementGeom,
  FibTimeZonesGeom,
  GannFanGeom,
  HorizontalLineGeom,
  HorizontalRayGeom,
  IconGeom,
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

/** Distance from `(px,py)` to the segment `[(ax,ay), (bx,by)]`. Degenerate-safe. */
export function pointToSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ex0 = px - ax;
    const ey0 = py - ay;
    return Math.sqrt(ex0 * ex0 + ey0 * ey0);
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) {
    t = 0;
  } else if (t > 1) {
    t = 1;
  }
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

export interface HitTolerances {
  /** Anchor handle hit radius (CSS px / dpr). */
  readonly handle: number;
  /** Line/border body tolerance (CSS px / dpr). */
  readonly body: number;
}

export type PointerKind = "mouse" | "pen" | "touch";

/** Defaults: 22 (touch handle) / 10 (mouse handle); 12 (touch body) / 8 (mouse body). */
export function defaultTolerancesFor(pointerType: PointerKind, dpr: number): HitTolerances {
  const safeDpr = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const isTouch = pointerType === "touch";
  return Object.freeze({
    handle: (isTouch ? 22 : 10) / safeDpr,
    body: (isTouch ? 12 : 8) / safeDpr,
  });
}

/** Phase 13 Cycle B.2 — handle key superset. `'time-end'` is the position-tool right-edge puller. */
export type HandleKey = number | "corner-tr" | "corner-bl" | "time-end";

export interface HitResult {
  readonly drawing: Drawing;
  /** Anchor index when the hit is on a handle. `'corner-*'` for derived corners on rectangle; `'time-end'` for the position-tool right-edge puller. */
  readonly handle?: HandleKey;
  readonly part: "handle" | "border" | "body" | "line";
}

interface ProjectedDrawing {
  readonly drawing: Drawing;
  readonly geom: ScreenGeom;
}

/**
 * Topmost-hit linear scan + bbox prefilter. Drawings ordered by `z` ascending
 * so iterate from the end (highest z first); first hit wins.
 */
export function hitTestDrawings(
  px: number,
  py: number,
  projected: readonly ProjectedDrawing[],
  selectedId: string | null,
  tols: HitTolerances,
): HitResult | null {
  for (let i = projected.length - 1; i >= 0; i--) {
    const entry = projected[i];
    if (entry === undefined) {
      continue;
    }
    const d = entry.drawing;
    if (!d.visible) {
      continue;
    }
    // 1. Selected drawing first — handle hit takes precedence over body hit.
    if (selectedId !== null && (d.id as unknown as string) === selectedId) {
      const handleHit = hitHandle(d, entry.geom, px, py, tols.handle);
      if (handleHit !== null) {
        return Object.freeze({ drawing: d, handle: handleHit, part: "handle" as const });
      }
    }
    // 2. Body / line hit.
    const bodyHit = hitGeom(entry.geom, px, py, tols.body);
    if (bodyHit !== null) {
      return Object.freeze({ drawing: d, part: bodyHit });
    }
  }
  return null;
}

function hitHandle(
  d: Drawing,
  geom: ScreenGeom,
  px: number,
  py: number,
  tol: number,
): HandleKey | null {
  switch (geom.kind) {
    case "trendline": {
      if (within(px, py, geom.anchors[0].x, geom.anchors[0].y, tol)) {
        return 0;
      }
      if (within(px, py, geom.anchors[1].x, geom.anchors[1].y, tol)) {
        return 1;
      }
      return null;
    }
    case "horizontalLine":
    case "verticalLine": {
      const a = geom.anchor;
      return within(px, py, a.x, a.y, tol) ? 0 : null;
    }
    case "rectangle": {
      // Stored anchors live on opposite corners; derived are the other two.
      if (within(px, py, geom.anchors[0].x, geom.anchors[0].y, tol)) {
        return 0;
      }
      if (within(px, py, geom.anchors[1].x, geom.anchors[1].y, tol)) {
        return 1;
      }
      // Derived corners — we know they're at `(a.x, b.y)` and `(b.x, a.y)`.
      const a = d.kind === "rectangle" ? geom.anchors[0] : null;
      const b = d.kind === "rectangle" ? geom.anchors[1] : null;
      if (a !== null && b !== null) {
        if (within(px, py, b.x, a.y, tol)) {
          return "corner-tr";
        }
        if (within(px, py, a.x, b.y, tol)) {
          return "corner-bl";
        }
      }
      return null;
    }
    case "fibRetracement":
    case "ray":
    case "extendedLine": {
      if (within(px, py, geom.anchors[0].x, geom.anchors[0].y, tol)) {
        return 0;
      }
      if (within(px, py, geom.anchors[1].x, geom.anchors[1].y, tol)) {
        return 1;
      }
      return null;
    }
    case "horizontalRay": {
      const a = geom.anchor;
      return within(px, py, a.x, a.y, tol) ? 0 : null;
    }
    case "parallelChannel": {
      if (within(px, py, geom.anchors[0].x, geom.anchors[0].y, tol)) {
        return 0;
      }
      if (within(px, py, geom.anchors[1].x, geom.anchors[1].y, tol)) {
        return 1;
      }
      if (within(px, py, geom.anchors[2].x, geom.anchors[2].y, tol)) {
        return 2;
      }
      return null;
    }
    case "longPosition":
    case "shortPosition": {
      if (within(px, py, geom.entry.x, geom.entry.y, tol)) {
        return 0;
      }
      if (within(px, py, geom.endX, geom.sl.y, tol)) {
        return 1;
      }
      if (within(px, py, geom.endX, geom.tp.y, tol)) {
        return 2;
      }
      const timeEndY = (geom.sl.y + geom.tp.y) / 2;
      if (within(px, py, geom.endX, timeEndY, tol)) {
        return "time-end";
      }
      return null;
    }
    case "text": {
      const a = geom.anchor;
      return within(px, py, a.x, a.y, tol) ? 0 : null;
    }
    case "callout": {
      if (within(px, py, geom.pin.x, geom.pin.y, tol)) {
        return 0;
      }
      if (within(px, py, geom.labelCenter.x, geom.labelCenter.y, tol)) {
        return 1;
      }
      return null;
    }
    case "arrow": {
      if (within(px, py, geom.anchors[0].x, geom.anchors[0].y, tol)) {
        return 0;
      }
      if (within(px, py, geom.anchors[1].x, geom.anchors[1].y, tol)) {
        return 1;
      }
      return null;
    }
    case "dateRange":
    case "priceRange":
    case "priceDateRange": {
      if (within(px, py, geom.anchors[0].x, geom.anchors[0].y, tol)) {
        return 0;
      }
      if (within(px, py, geom.anchors[1].x, geom.anchors[1].y, tol)) {
        return 1;
      }
      return null;
    }
    case "pitchfork": {
      if (within(px, py, geom.anchors[0].x, geom.anchors[0].y, tol)) {
        return 0;
      }
      if (within(px, py, geom.anchors[1].x, geom.anchors[1].y, tol)) {
        return 1;
      }
      if (within(px, py, geom.anchors[2].x, geom.anchors[2].y, tol)) {
        return 2;
      }
      return null;
    }
    case "gannFan":
    case "ellipse":
    case "fibFan":
    case "fibArcs": {
      if (within(px, py, geom.anchors[0].x, geom.anchors[0].y, tol)) {
        return 0;
      }
      if (within(px, py, geom.anchors[1].x, geom.anchors[1].y, tol)) {
        return 1;
      }
      return null;
    }
    case "fibExtension": {
      if (within(px, py, geom.anchors[0].x, geom.anchors[0].y, tol)) {
        return 0;
      }
      if (within(px, py, geom.anchors[1].x, geom.anchors[1].y, tol)) {
        return 1;
      }
      if (within(px, py, geom.anchors[2].x, geom.anchors[2].y, tol)) {
        return 2;
      }
      return null;
    }
    case "fibTimeZones": {
      const a = geom.anchor;
      return within(px, py, a.x, a.y, tol) ? 0 : null;
    }
    case "brush": {
      // Bbox-endpoint handles intentionally hidden in v1 — body-drag only.
      return null;
    }
    case "icon": {
      const a = geom.anchor;
      return within(px, py, a.x, a.y, tol) ? 0 : null;
    }
  }
}

function within(px: number, py: number, ax: number, ay: number, tol: number): boolean {
  const dx = px - ax;
  const dy = py - ay;
  return dx * dx + dy * dy <= tol * tol;
}

function hitGeom(
  geom: ScreenGeom,
  px: number,
  py: number,
  tol: number,
): "border" | "body" | "line" | null {
  switch (geom.kind) {
    case "trendline":
      return hitTrendline(geom, px, py, tol);
    case "horizontalLine":
      return hitHorizontal(geom, px, py, tol);
    case "verticalLine":
      return hitVertical(geom, px, py, tol);
    case "rectangle":
      return hitRectangle(geom, px, py, tol);
    case "fibRetracement":
      return hitFib(geom, px, py, tol);
    case "ray":
    case "extendedLine":
      return hitExtended(geom, px, py, tol);
    case "horizontalRay":
      return hitHorizontalRay(geom, px, py, tol);
    case "parallelChannel":
      return hitParallelChannel(geom, px, py, tol);
    case "longPosition":
    case "shortPosition":
      return hitPosition(geom, px, py, tol);
    case "text":
      return hitText(geom, px, py, tol);
    case "callout":
      return hitCallout(geom, px, py, tol);
    case "arrow":
      return hitArrow(geom, px, py, tol);
    case "dateRange":
      return hitDateRange(geom, px, py, tol);
    case "priceRange":
      return hitPriceRange(geom, px, py, tol);
    case "priceDateRange":
      return hitPriceDateRange(geom, px, py, tol);
    case "pitchfork":
      return hitPitchfork(geom, px, py, tol);
    case "gannFan":
      return hitGannFan(geom, px, py, tol);
    case "ellipse":
      return hitEllipse(geom, px, py, tol);
    case "fibExtension":
      return hitFibExtension(geom, px, py, tol);
    case "fibTimeZones":
      return hitFibTimeZones(geom, px, py, tol);
    case "fibFan":
      return hitFibFan(geom, px, py, tol);
    case "fibArcs":
      return hitFibArcs(geom, px, py, tol);
    case "brush":
      return hitBrush(geom, px, py, tol);
    case "icon":
      return hitIcon(geom, px, py, tol);
  }
}

function hitPosition(geom: PositionGeom, px: number, py: number, tol: number): "border" | "body" | "line" | null {
  const bb = geom.bbox;
  if (px < bb.xMin - tol || px > bb.xMax + tol || py < bb.yMin - tol || py > bb.yMax + tol) {
    return null;
  }
  // Entry / SL / TP horizontal lines.
  if (px >= geom.rewardRect.xLeft - tol && px <= geom.rewardRect.xRight + tol) {
    if (Math.abs(py - geom.entry.y) <= tol) {
      return "line";
    }
    if (Math.abs(py - geom.sl.y) <= tol) {
      return "line";
    }
    if (Math.abs(py - geom.tp.y) <= tol) {
      return "line";
    }
  }
  // Body inside reward or risk zone.
  const inReward =
    px >= geom.rewardRect.xLeft &&
    px <= geom.rewardRect.xRight &&
    py >= geom.rewardRect.yTop &&
    py <= geom.rewardRect.yBottom;
  if (inReward) {
    return "body";
  }
  const inRisk =
    px >= geom.riskRect.xLeft &&
    px <= geom.riskRect.xRight &&
    py >= geom.riskRect.yTop &&
    py <= geom.riskRect.yBottom;
  if (inRisk) {
    return "body";
  }
  return null;
}

function hitText(geom: TextGeom, px: number, py: number, tol: number): "body" | null {
  // Generous body tolerance — without measured text dimensions in the geom,
  // we hit-test against a `2*tol`-wide square centered at the anchor.
  if (Math.abs(px - geom.anchor.x) <= tol * 2 && Math.abs(py - geom.anchor.y) <= tol * 2) {
    return "body";
  }
  return null;
}

function hitCallout(geom: CalloutGeom, px: number, py: number, tol: number): "body" | "line" | null {
  // Body: point-in-rect on label bbox.
  if (
    geom.labelW > 0 &&
    geom.labelH > 0 &&
    px >= geom.labelX - tol &&
    px <= geom.labelX + geom.labelW + tol &&
    py >= geom.labelY - tol &&
    py <= geom.labelY + geom.labelH + tol
  ) {
    return "body";
  }
  // Leader line.
  if (geom.leaderEnd !== null) {
    const dist = pointToSegmentDistance(
      px,
      py,
      geom.pin.x,
      geom.pin.y,
      geom.leaderEnd.x,
      geom.leaderEnd.y,
    );
    if (dist <= tol) {
      return "line";
    }
  }
  return null;
}

function hitArrow(geom: ArrowGeom, px: number, py: number, tol: number): "line" | null {
  const v0 = geom.shaft[0];
  const v1 = geom.shaft[1];
  if (pointToSegmentDistance(px, py, v0.x, v0.y, v1.x, v1.y) <= tol) {
    return "line";
  }
  // Hit the head triangle bbox.
  const tip = geom.head[0];
  const bl = geom.head[1];
  const br = geom.head[2];
  const xs = [tip.x, bl.x, br.x];
  const ys = [tip.y, bl.y, br.y];
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  if (px >= xMin - tol && px <= xMax + tol && py >= yMin - tol && py <= yMax + tol) {
    return "line";
  }
  return null;
}

function hitDateRange(geom: DateRangeGeom, px: number, _py: number, tol: number): "border" | "body" | null {
  if (px < geom.xLeft - tol || px > geom.xRight + tol) {
    return null;
  }
  if (Math.abs(px - geom.xLeft) <= tol || Math.abs(px - geom.xRight) <= tol) {
    return "border";
  }
  return "body";
}

function hitPriceRange(geom: PriceRangeGeom, _px: number, py: number, tol: number): "border" | "body" | null {
  if (py < geom.yTop - tol || py > geom.yBottom + tol) {
    return null;
  }
  if (Math.abs(py - geom.yTop) <= tol || Math.abs(py - geom.yBottom) <= tol) {
    return "border";
  }
  return "body";
}

function hitPriceDateRange(
  geom: PriceDateRangeGeom,
  px: number,
  py: number,
  tol: number,
): "border" | "body" | null {
  if (px < geom.xLeft - tol || px > geom.xRight + tol) {
    return null;
  }
  if (py < geom.yTop - tol || py > geom.yBottom + tol) {
    return null;
  }
  const onBorder =
    Math.abs(px - geom.xLeft) <= tol ||
    Math.abs(px - geom.xRight) <= tol ||
    Math.abs(py - geom.yTop) <= tol ||
    Math.abs(py - geom.yBottom) <= tol;
  return onBorder ? "border" : "body";
}

function hitTrendline(geom: TrendlineGeom, px: number, py: number, tol: number): "line" | null {
  const v0 = geom.visible[0];
  const v1 = geom.visible[1];
  return pointToSegmentDistance(px, py, v0.x, v0.y, v1.x, v1.y) <= tol ? "line" : null;
}

function hitHorizontal(geom: HorizontalLineGeom, px: number, py: number, tol: number): "line" | null {
  if (px < geom.x1 - tol || px > geom.x2 + tol) {
    return null;
  }
  return Math.abs(py - geom.snappedY) <= tol ? "line" : null;
}

function hitVertical(geom: VerticalLineGeom, px: number, py: number, tol: number): "line" | null {
  if (py < geom.y1 - tol || py > geom.y2 + tol) {
    return null;
  }
  return Math.abs(px - geom.snappedX) <= tol ? "line" : null;
}

function hitRectangle(geom: RectangleGeom, px: number, py: number, tol: number): "border" | "body" | null {
  if (px < geom.xMin - tol || px > geom.xMax + tol) {
    return null;
  }
  if (py < geom.yMin - tol || py > geom.yMax + tol) {
    return null;
  }
  const insideInset =
    px > geom.xMin + tol &&
    px < geom.xMax - tol &&
    py > geom.yMin + tol &&
    py < geom.yMax - tol;
  if (insideInset) {
    return "body";
  }
  return "border";
}

function hitExtended(geom: RayGeom | ExtendedLineGeom, px: number, py: number, tol: number): "line" | null {
  const v0 = geom.visible[0];
  const v1 = geom.visible[1];
  return pointToSegmentDistance(px, py, v0.x, v0.y, v1.x, v1.y) <= tol ? "line" : null;
}

function hitHorizontalRay(geom: HorizontalRayGeom, px: number, py: number, tol: number): "line" | null {
  if (px < geom.x1 - tol || px > geom.x2 + tol) {
    return null;
  }
  return Math.abs(py - geom.snappedY) <= tol ? "line" : null;
}

function hitParallelChannel(geom: ParallelChannelGeom, px: number, py: number, tol: number): "line" | "body" | null {
  const bb = geom.bbox;
  if (px < bb.xMin - tol || px > bb.xMax + tol || py < bb.yMin - tol || py > bb.yMax + tol) {
    return null;
  }
  // Top stroke
  const topDist = pointToSegmentDistance(px, py, geom.top[0].x, geom.top[0].y, geom.top[1].x, geom.top[1].y);
  if (topDist <= tol) {
    return "line";
  }
  // Bottom stroke
  const bottomDist = pointToSegmentDistance(
    px,
    py,
    geom.bottom[0].x,
    geom.bottom[0].y,
    geom.bottom[1].x,
    geom.bottom[1].y,
  );
  if (bottomDist <= tol) {
    return "line";
  }
  // Body — point inside polygon (ray-casting against the 4 edges).
  if (pointInPolygon(px, py, geom.polygon)) {
    return "body";
  }
  return null;
}

function pointInPolygon(
  px: number,
  py: number,
  poly: readonly { readonly x: number; readonly y: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];
    if (pi === undefined || pj === undefined) {
      continue;
    }
    const intersects =
      pi.y > py !== pj.y > py &&
      px < ((pj.x - pi.x) * (py - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── Phase 13 Cycle C.1 — exotic geometry hit-tests ────────────────────────

function hitPitchfork(geom: PitchforkGeom, px: number, py: number, tol: number): "line" | null {
  const bb = geom.bbox;
  if (px < bb.xMin - tol || px > bb.xMax + tol || py < bb.yMin - tol || py > bb.yMax + tol) {
    return null;
  }
  const cd = pointToSegmentDistance(
    px,
    py,
    geom.centerline[0].x,
    geom.centerline[0].y,
    geom.centerline[1].x,
    geom.centerline[1].y,
  );
  if (cd <= tol) {
    return "line";
  }
  const ud = pointToSegmentDistance(
    px,
    py,
    geom.upperRail[0].x,
    geom.upperRail[0].y,
    geom.upperRail[1].x,
    geom.upperRail[1].y,
  );
  if (ud <= tol) {
    return "line";
  }
  const ld = pointToSegmentDistance(
    px,
    py,
    geom.lowerRail[0].x,
    geom.lowerRail[0].y,
    geom.lowerRail[1].x,
    geom.lowerRail[1].y,
  );
  if (ld <= tol) {
    return "line";
  }
  return null;
}

function hitGannFan(geom: GannFanGeom, px: number, py: number, tol: number): "line" | null {
  const bb = geom.bbox;
  if (px < bb.xMin - tol || px > bb.xMax + tol || py < bb.yMin - tol || py > bb.yMax + tol) {
    return null;
  }
  for (const ray of geom.rays) {
    const d = pointToSegmentDistance(
      px,
      py,
      ray.visible[0].x,
      ray.visible[0].y,
      ray.visible[1].x,
      ray.visible[1].y,
    );
    if (d <= tol) {
      return "line";
    }
  }
  return null;
}

function hitEllipse(geom: EllipseGeom, px: number, py: number, tol: number): "border" | "body" | null {
  if (geom.rx <= 0 || geom.ry <= 0) {
    return null;
  }
  // Bbox prefilter (with tolerance band).
  if (px < geom.xMin - tol || px > geom.xMax + tol) {
    return null;
  }
  if (py < geom.yMin - tol || py > geom.yMax + tol) {
    return null;
  }
  const nx = (px - geom.cx) / geom.rx;
  const ny = (py - geom.cy) / geom.ry;
  const norm = nx * nx + ny * ny;
  // Border: norm ≈ 1. Use a band scaled by `tol / min(rx, ry)` so the
  // tolerance reads in pixels consistently regardless of ellipse size.
  const minR = Math.min(geom.rx, geom.ry);
  const bandHalf = tol / Math.max(1, minR);
  if (norm >= (1 - bandHalf) ** 2 && norm <= (1 + bandHalf) ** 2) {
    return "border";
  }
  if (norm < 1) {
    return "body";
  }
  return null;
}

function hitFib(geom: FibRetracementGeom, px: number, py: number, tol: number): "line" | null {
  const bb = geom.bbox;
  if (px < bb.xMin - tol || px > bb.xMax + tol) {
    return null;
  }
  if (py < bb.yMin - tol || py > bb.yMax + tol) {
    return null;
  }
  let bestDy = Infinity;
  for (const lvl of geom.levels) {
    if (!lvl.visible) {
      continue;
    }
    const dy = Math.abs(py - lvl.snappedY);
    if (dy < bestDy) {
      bestDy = dy;
    }
  }
  return bestDy <= tol ? "line" : null;
}

// ─── Phase 13 Cycle C.2 — fib variant hit-tests ────────────────────────────

function hitFibExtension(geom: FibExtensionGeom, px: number, py: number, tol: number): "line" | null {
  const bb = geom.bbox;
  if (px < bb.xMin - tol || px > bb.xMax + tol) {
    return null;
  }
  if (py < bb.yMin - tol || py > bb.yMax + tol) {
    return null;
  }
  // Level lines span `xMin..xMax`; gate on horizontal extent.
  if (px < geom.xMin - tol || px > geom.xMax + tol) {
    return null;
  }
  let bestDy = Infinity;
  for (const lvl of geom.levels) {
    if (!lvl.visible) {
      continue;
    }
    const dy = Math.abs(py - lvl.snappedY);
    if (dy < bestDy) {
      bestDy = dy;
    }
  }
  return bestDy <= tol ? "line" : null;
}

function hitFibTimeZones(geom: FibTimeZonesGeom, px: number, py: number, tol: number): "line" | null {
  if (py < geom.y1 - tol || py > geom.y2 + tol) {
    return null;
  }
  for (const zone of geom.zones) {
    if (Math.abs(px - zone.snappedX) <= tol) {
      return "line";
    }
  }
  return null;
}

function hitFibFan(geom: FibFanGeom, px: number, py: number, tol: number): "line" | null {
  const bb = geom.bbox;
  if (px < bb.xMin - tol || px > bb.xMax + tol || py < bb.yMin - tol || py > bb.yMax + tol) {
    return null;
  }
  for (const ray of geom.rays) {
    const d = pointToSegmentDistance(
      px,
      py,
      ray.visible[0].x,
      ray.visible[0].y,
      ray.visible[1].x,
      ray.visible[1].y,
    );
    if (d <= tol) {
      return "line";
    }
  }
  return null;
}

function hitFibArcs(geom: FibArcsGeom, px: number, py: number, tol: number): "line" | null {
  // Bottom-half-arc: reject points clearly above the center.
  const dy = py - geom.cy;
  if (dy < -tol) {
    return null;
  }
  const bb = geom.bbox;
  if (px < bb.xMin - tol || px > bb.xMax + tol || py > bb.yMax + tol) {
    return null;
  }
  const d = Math.hypot(px - geom.cx, dy);
  for (const ring of geom.rings) {
    if (!Number.isFinite(ring.r) || ring.r < 1 || ring.r > 4000) {
      continue;
    }
    if (Math.abs(d - ring.r) <= tol) {
      return "line";
    }
  }
  return null;
}

// ─── Phase 13 Cycle C.3 — brush + icon hit-tests ───────────────────────────

function hitBrush(geom: BrushGeom, px: number, py: number, tol: number): "line" | null {
  const bb = geom.bbox;
  if (px < bb.xMin - tol || px > bb.xMax + tol || py < bb.yMin - tol || py > bb.yMax + tol) {
    return null;
  }
  for (let i = 1; i < geom.points.length; i++) {
    const a = geom.points[i - 1];
    const b = geom.points[i];
    if (a === undefined || b === undefined) {
      continue;
    }
    if (pointToSegmentDistance(px, py, a.x, a.y, b.x, b.y) <= tol) {
      return "line";
    }
  }
  return null;
}

function hitIcon(geom: IconGeom, px: number, py: number, tol: number): "body" | null {
  const half = geom.sizeCss / 2;
  if (
    Math.abs(px - geom.anchor.x) <= half + tol &&
    Math.abs(py - geom.anchor.y) <= half + tol
  ) {
    return "body";
  }
  return null;
}
