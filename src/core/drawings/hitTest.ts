/**
 * Pure hit-test utilities for drawings. All inputs are plot-local pixels
 * (caller has already subtracted `plotRect.x/y`). Tolerances are pre-resolved
 * to the active pointer-type / DPR.
 */

import type { Drawing } from "./types.js";
import type {
  FibRetracementGeom,
  HorizontalLineGeom,
  RectangleGeom,
  ScreenGeom,
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

export interface HitResult {
  readonly drawing: Drawing;
  /** Anchor index when the hit is on a handle. `'corner'` for derived corners on rectangle. */
  readonly handle?: number | "corner-tr" | "corner-bl";
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
): number | "corner-tr" | "corner-bl" | null {
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
    case "fibRetracement": {
      if (within(px, py, geom.anchors[0].x, geom.anchors[0].y, tol)) {
        return 0;
      }
      if (within(px, py, geom.anchors[1].x, geom.anchors[1].y, tol)) {
        return 1;
      }
      return null;
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
  }
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
