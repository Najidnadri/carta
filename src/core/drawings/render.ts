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

/**
 * Phase 13 Cycle C.3 — heuristic dark-theme detector. Compares the luminance
 * of `theme.background` (RGB565-style numeric color) against a 0.3 threshold;
 * the dark themes shipped (`background = 0x0e1116`) clear it, light themes
 * (`background = 0xffffff`) do not. Used to bump default stroke alpha so fib
 * connector / level / ray / ring lines read at trader-grade contrast on
 * dark backgrounds without forcing every host to override `style.alpha`.
 */
export function isDarkTheme(theme: Theme): boolean {
  const bg = theme.background;
  if (typeof bg !== "number" || !Number.isFinite(bg)) {
    return false;
  }
  const r = ((bg >> 16) & 0xff) / 255;
  const g = ((bg >> 8) & 0xff) / 255;
  const b = (bg & 0xff) / 255;
  // Rec.709 relative luminance.
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance < 0.3;
}

const DARK_THEME_DEFAULT_ALPHA_FLOOR = 0.85;

/**
 * Phase 13 Cycle D — ghost mode (live create-preview). When `true`,
 * `resolveStroke` raises every stroke alpha to a `≥ 0.7` floor so the
 * compound `g.alpha = 0.55` container fade lands at ≈ 0.385 visible — readable
 * even on dim fib connectors. Set by `redrawDrawing` before the per-kind
 * switch and cleared in a `finally`. Pixi rendering is single-threaded so the
 * module-level mutable is safe; the `try/finally` guards exception paths.
 */
let CURRENT_GHOST = false;

const GHOST_STROKE_ALPHA_FLOOR = 0.7;

function resolveStroke(stroke: DrawingStroke | undefined, theme: Theme, dpr: number): ResolvedStroke {
  const baseWidth = stroke?.width ?? 1;
  const dprBucket = dpr <= 1 ? 1 : dpr <= 1.5 ? 1.5 : 2;
  // Cycle C.3 — when the host hasn't set an explicit alpha AND the theme is
  // dark, raise the floor so connector / level / ray lines read at
  // trader-grade contrast against the dark background. Light theme is
  // unchanged (default 1).
  let effectiveAlpha = stroke?.alpha ?? 1;
  if (stroke?.alpha === undefined && isDarkTheme(theme)) {
    effectiveAlpha = Math.max(effectiveAlpha, DARK_THEME_DEFAULT_ALPHA_FLOOR);
  }
  if (CURRENT_GHOST) {
    effectiveAlpha = Math.max(effectiveAlpha, GHOST_STROKE_ALPHA_FLOOR);
  }
  return Object.freeze({
    color: stroke?.color ?? theme.line,
    alpha: effectiveAlpha,
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
  // Phase 13 Cycle D — default fill: shapes always render filled at low
  // alpha so a freshly-placed rectangle / ellipse / channel / range is
  // visually obvious without the host setting a fill. Hosts can pass an
  // explicit `fill` to override; pass `{ alpha: 0 }` to opt out entirely.
  const fillColor = fill?.color ?? stroke.color;
  const fillAlpha = fill?.alpha ?? 0.15;
  if (fillAlpha > 0) {
    g.rect(x, y, w, h).fill({ color: fillColor, alpha: fillAlpha });
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
  // Phase 13 Cycle D — always render the speech-bubble pill so the drawing
  // is visible from creation (rather than being a 3-px pin until the user
  // styles a fill). The bubble inherits the host-supplied fill when set,
  // else uses a theme-derived default. Rounded-rect background + 1-px
  // stroke border so the bubble reads on both light and dark themes.
  const fill = drawing.style.fill;
  const fillColor = fill?.color ?? theme.crosshairTagBg;
  const fillAlpha = fill?.alpha ?? 0.85;
  if (geom.labelW > 0 && geom.labelH > 0) {
    g.roundRect(geom.labelX, geom.labelY, geom.labelW, geom.labelH, 4).fill({
      color: fillColor,
      alpha: fillAlpha,
    });
    g.roundRect(geom.labelX, geom.labelY, geom.labelW, geom.labelH, 4).stroke({
      color: stroke.color,
      alpha: stroke.alpha * 0.8,
      width: 1,
    });
  }
  // Leader line (only when pin is outside label bbox).
  if (geom.leaderEnd !== null) {
    g.moveTo(geom.pin.x, geom.pin.y)
      .lineTo(geom.leaderEnd.x, geom.leaderEnd.y)
      .stroke({ color: stroke.color, alpha: stroke.alpha, width: stroke.width });
  }
  // Pin marker — drawn last so it sits on top of the leader.
  g.circle(geom.pin.x, geom.pin.y, 3).fill({ color: stroke.color, alpha: 1 });
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
  // Cycle D — default fill at 0.15 alpha so a freshly-placed ellipse is
  // visible without host styling (mirrors rectangle).
  const fillColor = fill?.color ?? stroke.color;
  const fillAlpha = fill?.alpha ?? 0.15;
  if (fillAlpha > 0) {
    g.ellipse(geom.cx, geom.cy, geom.rx, geom.ry).fill({
      color: fillColor,
      alpha: fillAlpha,
    });
  }
  g.ellipse(geom.cx, geom.cy, geom.rx, geom.ry).stroke({
    color: stroke.color,
    alpha: stroke.alpha,
    width: stroke.width,
  });
}

// ─── Phase 13 Cycle C.2 — fib variant renderers ────────────────────────────

function drawFibExtension(g: Graphics, geom: FibExtensionGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  // Connector through the 3 anchors so users can see the impulse + extension legs.
  // Cycle C.3 — connector multiplier raised from 0.55 → 0.75 so the dim
  // legs read more clearly against dark themes (still subordinate to the
  // full-alpha level lines).
  const a0 = geom.anchors[0];
  const a1 = geom.anchors[1];
  const a2 = geom.anchors[2];
  g.moveTo(a0.x, a0.y).lineTo(a1.x, a1.y).stroke({
    color: stroke.color,
    alpha: stroke.alpha * 0.75,
    width: Math.max(1, stroke.width * 0.8),
  });
  g.moveTo(a1.x, a1.y).lineTo(a2.x, a2.y).stroke({
    color: stroke.color,
    alpha: stroke.alpha * 0.75,
    width: Math.max(1, stroke.width * 0.8),
  });
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

function drawFibTimeZones(g: Graphics, geom: FibTimeZonesGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  for (const zone of geom.zones) {
    g.moveTo(zone.snappedX, geom.y1).lineTo(zone.snappedX, geom.y2).stroke({
      color: stroke.color,
      alpha: stroke.alpha,
      width: stroke.width,
    });
  }
}

function drawFibFan(g: Graphics, geom: FibFanGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  for (const ray of geom.rays) {
    drawSegment(g, ray.visible[0].x, ray.visible[0].y, ray.visible[1].x, ray.visible[1].y, stroke);
  }
}

function drawFibArcs(g: Graphics, geom: FibArcsGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  for (const ring of geom.rings) {
    if (!Number.isFinite(ring.r) || ring.r < 1 || ring.r > 4000) {
      continue;
    }
    g.arc(geom.cx, geom.cy, ring.r, 0, Math.PI).stroke({
      color: stroke.color,
      alpha: stroke.alpha,
      width: stroke.width,
    });
  }
}

// ─── Phase 13 Cycle C.3 — brush + icon renderers ───────────────────────────

function drawBrush(g: Graphics, geom: BrushGeom, drawing: Drawing, theme: Theme, dpr: number): void {
  if (geom.points.length < 2) {
    return;
  }
  const stroke = resolveStroke(drawing.style.stroke, theme, dpr);
  // Build a single flat array and emit one `g.poly()` so the polyline
  // batches as one path / one stroke fill — avoids the N-1-subpath cost of
  // chained moveTo+lineTo.
  const flat: number[] = [];
  for (const p of geom.points) {
    flat.push(p.x, p.y);
  }
  // `false` = open polyline (no closing segment back to the start).
  g.poly(flat, false).stroke({
    color: stroke.color,
    alpha: stroke.alpha,
    width: stroke.width,
  });
}

/**
 * Icon Graphics-layer draw is a no-op: the controller maintains a parallel
 * `Sprite` per icon drawing in `spritesByDrawing`. This stub keeps the
 * pooled Graphics row consistent (cleared, hidden) so other code paths
 * that iterate `graphicsByDrawing` continue to work.
 */
function drawIcon(_g: Graphics): void {
  /* sprite handles the visual; graphics row stays empty */
}

/**
 * Phase 13 Cycle D — selection visual mode passed through to `redrawDrawing`.
 * - `'primary'`: drawing is the selection focus (single-select target or
 *   multi-select primary). Renders a thicker dashed marquee + larger handle.
 * - `'secondary'`: drawing is part of a multi-select but not the primary.
 *   Thinner marquee + smaller handle.
 * - `null`: not selected.
 */
export type SelectedKind = "primary" | "secondary" | null;

export interface RedrawOptions {
  readonly selected?: SelectedKind;
  readonly ghost?: boolean;
}

export function redrawDrawing(
  g: Graphics,
  drawing: Drawing,
  geom: ScreenGeom,
  theme: Theme,
  dpr: number,
  opts: RedrawOptions = {},
): void {
  g.clear();
  if (!drawing.visible) {
    g.visible = false;
    return;
  }
  g.visible = true;
  const ghost = opts.ghost === true;
  const selected = opts.selected ?? null;
  // Container-level fade for ghost previews — single multiplicative pass that
  // dims the entire body uniformly without each draw fn needing an alpha arg.
  // 0.85 reads clearly against both light and dark themes; the per-stroke
  // ghost-floor (0.7) keeps even the dimmest fib connector legible after
  // compound fade.
  g.alpha = ghost ? 0.85 : 1;
  CURRENT_GHOST = ghost;
  try {
    // Cycle D — under-stroke halo on selected drawings. Renders BEFORE the
    // body so the body lays on top of the halo. Skipped for ghost previews.
    if (selected !== null && !ghost) {
      drawHalo(g, drawing, geom, theme, dpr, selected);
    }
    drawBody(g, drawing, geom, theme, dpr);
    if (selected !== null && !ghost) {
      drawSelectionMarquee(g, geom, theme, dpr, selected);
    }
  } finally {
    CURRENT_GHOST = false;
  }
}

function drawBody(
  g: Graphics,
  drawing: Drawing,
  geom: ScreenGeom,
  theme: Theme,
  dpr: number,
): void {
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
    case "fibExtension":
      drawFibExtension(g, geom, drawing, theme, dpr);
      return;
    case "fibTimeZones":
      drawFibTimeZones(g, geom, drawing, theme, dpr);
      return;
    case "fibFan":
      drawFibFan(g, geom, drawing, theme, dpr);
      return;
    case "fibArcs":
      drawFibArcs(g, geom, drawing, theme, dpr);
      return;
    case "brush":
      drawBrush(g, geom, drawing, theme, dpr);
      return;
    case "icon":
      drawIcon(g);
      return;
  }
}

// ─── Phase 13 Cycle D — Selection decoration ──────────────────────────────

const FILLED_KINDS = new Set<ScreenGeom["kind"]>([
  "rectangle",
  "ellipse",
  "parallelChannel",
  "longPosition",
  "shortPosition",
  "dateRange",
  "priceRange",
  "priceDateRange",
]);

const MARQUEE_PADDING_PX = 4;

/** Compute the screen-space bounding box of a `ScreenGeom`. */
export function geomBbox(geom: ScreenGeom): {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
} {
  // Many geoms already carry a precomputed bbox — re-export for consistency.
  if ("bbox" in geom) {
    return geom.bbox;
  }
  switch (geom.kind) {
    case "trendline":
    case "ray":
    case "extendedLine": {
      const a = geom.visible[0];
      const b = geom.visible[1];
      return {
        xMin: Math.min(a.x, b.x),
        xMax: Math.max(a.x, b.x),
        yMin: Math.min(a.y, b.y),
        yMax: Math.max(a.y, b.y),
      };
    }
    case "horizontalLine": {
      return { xMin: geom.x1, xMax: geom.x2, yMin: geom.snappedY, yMax: geom.snappedY };
    }
    case "verticalLine": {
      return { xMin: geom.snappedX, xMax: geom.snappedX, yMin: geom.y1, yMax: geom.y2 };
    }
    case "horizontalRay": {
      return { xMin: geom.x1, xMax: geom.x2, yMin: geom.snappedY, yMax: geom.snappedY };
    }
    case "rectangle": {
      return { xMin: geom.xMin, xMax: geom.xMax, yMin: geom.yMin, yMax: geom.yMax };
    }
    case "ellipse": {
      return { xMin: geom.xMin, xMax: geom.xMax, yMin: geom.yMin, yMax: geom.yMax };
    }
    case "text": {
      // Anchor + a small reach for the dot; pool emits the pill separately.
      return {
        xMin: geom.anchor.x - 4,
        xMax: geom.anchor.x + 80,
        yMin: geom.anchor.y - 16,
        yMax: geom.anchor.y + 4,
      };
    }
    case "callout": {
      const xMin = Math.min(geom.pin.x, geom.labelX);
      const xMax = Math.max(geom.pin.x, geom.labelX + Math.max(20, geom.labelW));
      const yMin = Math.min(geom.pin.y, geom.labelY);
      const yMax = Math.max(geom.pin.y, geom.labelY + Math.max(20, geom.labelH));
      return { xMin, xMax, yMin, yMax };
    }
    case "arrow": {
      const a = geom.anchors[0];
      const b = geom.anchors[1];
      return {
        xMin: Math.min(a.x, b.x),
        xMax: Math.max(a.x, b.x),
        yMin: Math.min(a.y, b.y),
        yMax: Math.max(a.y, b.y),
      };
    }
    case "dateRange":
    case "priceRange":
    case "priceDateRange": {
      return { xMin: geom.xLeft, xMax: geom.xRight, yMin: geom.yTop, yMax: geom.yBottom };
    }
    case "icon": {
      const half = geom.sizeCss / 2;
      return {
        xMin: geom.anchor.x - half,
        xMax: geom.anchor.x + half,
        yMin: geom.anchor.y - half,
        yMax: geom.anchor.y + half,
      };
    }
  }
}

function drawSelectionMarquee(
  g: Graphics,
  geom: ScreenGeom,
  theme: Theme,
  dpr: number,
  selected: SelectedKind,
): void {
  const bbox = geomBbox(geom);
  const w = bbox.xMax - bbox.xMin;
  const h = bbox.yMax - bbox.yMin;
  // Skip if the bbox collapsed to a point — there's nothing to outline.
  if (w <= 1 && h <= 1) {
    return;
  }
  const dprBucket = dpr <= 1 ? 1 : dpr <= 1.5 ? 1.5 : 2;
  const baseWidth = selected === "primary" ? 1.5 : 1;
  const stroke: ResolvedStroke = Object.freeze({
    color: theme.selection,
    alpha: 0.7,
    width: baseWidth * dprBucket,
    style: "dashed",
  });
  const x = bbox.xMin - MARQUEE_PADDING_PX;
  const y = bbox.yMin - MARQUEE_PADDING_PX;
  const ww = w + MARQUEE_PADDING_PX * 2;
  const hh = h + MARQUEE_PADDING_PX * 2;
  // Four dashed segments rather than a single rect so each side picks up the
  // dash phase reset (`drawDashedSegment` re-zeroes per-segment).
  drawSegment(g, x, y, x + ww, y, stroke);
  drawSegment(g, x + ww, y, x + ww, y + hh, stroke);
  drawSegment(g, x + ww, y + hh, x, y + hh, stroke);
  drawSegment(g, x, y + hh, x, y, stroke);
}

function drawHalo(
  g: Graphics,
  drawing: Drawing,
  geom: ScreenGeom,
  theme: Theme,
  dpr: number,
  selected: SelectedKind,
): void {
  const dprBucket = dpr <= 1 ? 1 : dpr <= 1.5 ? 1.5 : 2;
  const baseStroke = drawing.style.stroke;
  const baseWidth = (baseStroke?.width ?? 1) * dprBucket;
  const isFilled = FILLED_KINDS.has(geom.kind);
  // Filled kinds already carry visual weight — use a thinner halo so the
  // selected look is unmistakable but doesn't drown the fill.
  const widthBump = isFilled ? 2 : 4;
  const haloAlpha = isFilled ? 0.18 : 0.25;
  // Phase 13 Cycle D — halo respects the body's dash style so dashed /
  // dotted strokes don't get visually filled-in by a continuous halo. A
  // solid halo on a dashed body would mask the dash gaps and the user
  // would see what looks like a solid line.
  const halo: ResolvedStroke = Object.freeze({
    color: theme.selection,
    alpha: selected === "primary" ? haloAlpha : haloAlpha * 0.7,
    width: baseWidth + widthBump,
    style: baseStroke?.style ?? "solid",
  });
  switch (geom.kind) {
    case "trendline": {
      const v0 = geom.visible[0];
      const v1 = geom.visible[1];
      drawSegment(g, v0.x, v0.y, v1.x, v1.y, halo);
      return;
    }
    case "horizontalLine": {
      drawSegment(g, geom.x1, geom.snappedY, geom.x2, geom.snappedY, halo);
      return;
    }
    case "verticalLine": {
      drawSegment(g, geom.snappedX, geom.y1, geom.snappedX, geom.y2, halo);
      return;
    }
    case "ray":
    case "extendedLine": {
      const v0 = geom.visible[0];
      const v1 = geom.visible[1];
      drawSegment(g, v0.x, v0.y, v1.x, v1.y, halo);
      return;
    }
    case "horizontalRay": {
      drawSegment(g, geom.x1, geom.snappedY, geom.x2, geom.snappedY, halo);
      return;
    }
    case "rectangle": {
      const x = geom.xMin;
      const y = geom.yMin;
      const w = geom.xMax - geom.xMin;
      const h = geom.yMax - geom.yMin;
      g.rect(x, y, w, h).stroke({ color: halo.color, alpha: halo.alpha, width: halo.width });
      return;
    }
    case "fibRetracement": {
      // Halo each level line (not the trend connector which is already faint).
      for (const lvl of geom.levels) {
        if (!lvl.visible) {
          continue;
        }
        drawSegment(g, geom.xMin, lvl.snappedY, geom.xMax, lvl.snappedY, halo);
      }
      return;
    }
    case "parallelChannel": {
      drawSegment(g, geom.top[0].x, geom.top[0].y, geom.top[1].x, geom.top[1].y, halo);
      drawSegment(g, geom.bottom[0].x, geom.bottom[0].y, geom.bottom[1].x, geom.bottom[1].y, halo);
      return;
    }
    case "longPosition":
    case "shortPosition": {
      // Halo the entry/SL/TP lines — the band fills already read as selected.
      const xl = geom.rewardRect.xLeft;
      const xr = geom.rewardRect.xRight;
      drawSegment(g, xl, geom.entry.y, xr, geom.entry.y, halo);
      drawSegment(g, xl, geom.sl.y, xr, geom.sl.y, halo);
      drawSegment(g, xl, geom.tp.y, xr, geom.tp.y, halo);
      return;
    }
    case "text":
    case "icon": {
      // Halo is moot for these — the marquee carries the selection look.
      return;
    }
    case "callout": {
      if (geom.leaderEnd !== null) {
        drawSegment(g, geom.pin.x, geom.pin.y, geom.leaderEnd.x, geom.leaderEnd.y, halo);
      }
      return;
    }
    case "arrow": {
      const v0 = geom.shaft[0];
      const v1 = geom.shaft[1];
      drawSegment(g, v0.x, v0.y, v1.x, v1.y, halo);
      return;
    }
    case "dateRange": {
      const xL = geom.xLeft;
      const xR = geom.xRight;
      drawSegment(g, xL, geom.yTop, xL, geom.yBottom, halo);
      drawSegment(g, xR, geom.yTop, xR, geom.yBottom, halo);
      return;
    }
    case "priceRange": {
      drawSegment(g, geom.xLeft, geom.yTop, geom.xRight, geom.yTop, halo);
      drawSegment(g, geom.xLeft, geom.yBottom, geom.xRight, geom.yBottom, halo);
      return;
    }
    case "priceDateRange": {
      const x = geom.xLeft;
      const y = geom.yTop;
      const w = geom.xRight - geom.xLeft;
      const h = geom.yBottom - geom.yTop;
      g.rect(x, y, w, h).stroke({ color: halo.color, alpha: halo.alpha, width: halo.width });
      return;
    }
    case "pitchfork": {
      const c0 = geom.centerline[0];
      const c1 = geom.centerline[1];
      drawSegment(g, c0.x, c0.y, c1.x, c1.y, halo);
      drawSegment(g, geom.upperRail[0].x, geom.upperRail[0].y, geom.upperRail[1].x, geom.upperRail[1].y, halo);
      drawSegment(g, geom.lowerRail[0].x, geom.lowerRail[0].y, geom.lowerRail[1].x, geom.lowerRail[1].y, halo);
      return;
    }
    case "gannFan": {
      for (const ray of geom.rays) {
        drawSegment(g, ray.visible[0].x, ray.visible[0].y, ray.visible[1].x, ray.visible[1].y, halo);
      }
      return;
    }
    case "ellipse": {
      if (geom.rx <= 0 || geom.ry <= 0) {
        return;
      }
      g.ellipse(geom.cx, geom.cy, geom.rx, geom.ry).stroke({
        color: halo.color,
        alpha: halo.alpha,
        width: halo.width,
      });
      return;
    }
    case "fibExtension": {
      for (const lvl of geom.levels) {
        if (!lvl.visible) {
          continue;
        }
        drawSegment(g, geom.xMin, lvl.snappedY, geom.xMax, lvl.snappedY, halo);
      }
      return;
    }
    case "fibTimeZones": {
      for (const zone of geom.zones) {
        drawSegment(g, zone.snappedX, geom.y1, zone.snappedX, geom.y2, halo);
      }
      return;
    }
    case "fibFan": {
      for (const ray of geom.rays) {
        drawSegment(g, ray.visible[0].x, ray.visible[0].y, ray.visible[1].x, ray.visible[1].y, halo);
      }
      return;
    }
    case "fibArcs": {
      for (const ring of geom.rings) {
        if (!Number.isFinite(ring.r) || ring.r < 1 || ring.r > 4000) {
          continue;
        }
        g.arc(geom.cx, geom.cy, ring.r, 0, Math.PI).stroke({
          color: halo.color,
          alpha: halo.alpha,
          width: halo.width,
        });
      }
      return;
    }
    case "brush": {
      if (geom.points.length < 2) {
        return;
      }
      const flat: number[] = [];
      for (const p of geom.points) {
        flat.push(p.x, p.y);
      }
      g.poly(flat, false).stroke({
        color: halo.color,
        alpha: halo.alpha,
        width: halo.width,
      });
      return;
    }
  }
}

// ─── Handles ───────────────────────────────────────────────────────────────

/**
 * Phase 13 Cycle D — handle radii bumped from 6 → 8 CSS-px (10 for the
 * primary in multi-select), fill switched to `theme.selection` so it reads
 * against any drawing color, stroke set to `theme.background` to provide a
 * halo ring against bright accents. Closes the dark-theme contrast bug
 * (cycle C.3 carry-over) where `fill = theme.background` on a near-black
 * background made handles invisible.
 */
const HANDLE_RADIUS_SECONDARY_PX = 8;
const HANDLE_RADIUS_PRIMARY_PX = 10;

export class HandleContextCache {
  private readonly cache = new Map<string, GraphicsContext>();

  get(variant: HandleVariant, theme: Theme, dpr: number, primary: boolean): GraphicsContext {
    const baseRadius = primary ? HANDLE_RADIUS_PRIMARY_PX : HANDLE_RADIUS_SECONDARY_PX;
    const radius = baseRadius / Math.max(1, dpr);
    const fill = theme.selection;
    const stroke = theme.background;
    const strokeWidth = variant === "hover" || variant === "active" ? 2 : 1.5;
    const fillAlpha = variant === "active" ? 1 : 0.95;
    const key = `${variant}|${primary ? "p" : "s"}|${String(fill)}|${String(stroke)}|${String(strokeWidth)}|${String(radius)}|${String(fillAlpha)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const ctx = new GraphicsContext()
      .circle(0, 0, radius)
      .fill({ color: fill, alpha: fillAlpha })
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
  /**
   * Phase 13 Cycle D — `true` when the spec belongs to the primary selection
   * (single-select target or the multi-select primary). The cache returns a
   * larger handle for primaries so multi-select stays legible.
   */
  readonly primary: boolean;
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
    g.context = cache.get(spec.variant, theme, dpr, spec.primary);
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
/**
 * Phase 13 Cycle B.2 — handle key superset.
 * - `'time-end'`: position-tool right-edge puller.
 * - `'icon-size'` (Cycle D): icon resize handle at the glyph's bottom-right
 *   corner. Drag toward / away from the anchor scales `drawing.size`.
 */
export type HandleKey = number | "corner-tr" | "corner-bl" | "time-end" | "icon-size";

export function handleSpecsFor(
  geom: ScreenGeom,
  hoveredHandle: HandleKey | null,
  draggingHandle: HandleKey | null,
  plot: { readonly w: number; readonly h: number },
  primary = true,
): readonly HandleSpec[] {
  const specs: HandleSpec[] = [];
  const tol = 8;
  const inPlot = (x: number, y: number): boolean =>
    x >= -tol && x <= plot.w + tol && y >= -tol && y <= plot.h + tol;
  const variantFor = (key: HandleKey): HandleVariant =>
    draggingHandle === key ? "active" : hoveredHandle === key ? "hover" : "normal";
  const mk = (key: HandleKey, x: number, y: number): HandleSpec =>
    Object.freeze({ key, x, y, variant: variantFor(key), primary });
  switch (geom.kind) {
    case "trendline":
    case "fibRetracement":
    case "rectangle":
    case "ray":
    case "extendedLine": {
      const a0 = geom.anchors[0];
      const a1 = geom.anchors[1];
      if (inPlot(a0.x, a0.y)) {
        specs.push(mk(0, a0.x, a0.y));
      }
      if (inPlot(a1.x, a1.y)) {
        specs.push(mk(1, a1.x, a1.y));
      }
      return specs;
    }
    case "horizontalLine":
    case "verticalLine":
    case "horizontalRay": {
      const a = geom.anchor;
      if (inPlot(a.x, a.y)) {
        specs.push(mk(0, a.x, a.y));
      }
      return specs;
    }
    case "parallelChannel": {
      const a0 = geom.anchors[0];
      const a1 = geom.anchors[1];
      const a2 = geom.anchors[2];
      if (inPlot(a0.x, a0.y)) {
        specs.push(mk(0, a0.x, a0.y));
      }
      if (inPlot(a1.x, a1.y)) {
        specs.push(mk(1, a1.x, a1.y));
      }
      if (inPlot(a2.x, a2.y)) {
        specs.push(mk(2, a2.x, a2.y));
      }
      return specs;
    }
    case "longPosition":
    case "shortPosition": {
      // Entry circle at left edge (entryX, entryY); SL/TP squares at the
      // right edge (endX, sl.y) / (endX, tp.y); time-end puller midway down
      // the right edge.
      if (inPlot(geom.entry.x, geom.entry.y)) {
        specs.push(mk(0, geom.entry.x, geom.entry.y));
      }
      if (inPlot(geom.endX, geom.sl.y)) {
        specs.push(mk(1, geom.endX, geom.sl.y));
      }
      if (inPlot(geom.endX, geom.tp.y)) {
        specs.push(mk(2, geom.endX, geom.tp.y));
      }
      const timeEndY = (geom.sl.y + geom.tp.y) / 2;
      if (inPlot(geom.endX, timeEndY)) {
        specs.push(mk("time-end", geom.endX, timeEndY));
      }
      return specs;
    }
    case "text": {
      const a = geom.anchor;
      if (inPlot(a.x, a.y)) {
        specs.push(mk(0, a.x, a.y));
      }
      return specs;
    }
    case "callout": {
      if (inPlot(geom.pin.x, geom.pin.y)) {
        specs.push(mk(0, geom.pin.x, geom.pin.y));
      }
      if (inPlot(geom.labelCenter.x, geom.labelCenter.y)) {
        specs.push(mk(1, geom.labelCenter.x, geom.labelCenter.y));
      }
      return specs;
    }
    case "arrow": {
      const a0 = geom.anchors[0];
      const a1 = geom.anchors[1];
      if (inPlot(a0.x, a0.y)) {
        specs.push(mk(0, a0.x, a0.y));
      }
      if (inPlot(a1.x, a1.y)) {
        specs.push(mk(1, a1.x, a1.y));
      }
      return specs;
    }
    case "dateRange":
    case "priceRange":
    case "priceDateRange": {
      const a0 = geom.anchors[0];
      const a1 = geom.anchors[1];
      if (inPlot(a0.x, a0.y)) {
        specs.push(mk(0, a0.x, a0.y));
      }
      if (inPlot(a1.x, a1.y)) {
        specs.push(mk(1, a1.x, a1.y));
      }
      return specs;
    }
    case "pitchfork": {
      const a0 = geom.anchors[0];
      const a1 = geom.anchors[1];
      const a2 = geom.anchors[2];
      if (inPlot(a0.x, a0.y)) {
        specs.push(mk(0, a0.x, a0.y));
      }
      if (inPlot(a1.x, a1.y)) {
        specs.push(mk(1, a1.x, a1.y));
      }
      if (inPlot(a2.x, a2.y)) {
        specs.push(mk(2, a2.x, a2.y));
      }
      return specs;
    }
    case "gannFan":
    case "ellipse":
    case "fibFan":
    case "fibArcs": {
      const a0 = geom.anchors[0];
      const a1 = geom.anchors[1];
      if (inPlot(a0.x, a0.y)) {
        specs.push(mk(0, a0.x, a0.y));
      }
      if (inPlot(a1.x, a1.y)) {
        specs.push(mk(1, a1.x, a1.y));
      }
      return specs;
    }
    case "fibExtension": {
      const a0 = geom.anchors[0];
      const a1 = geom.anchors[1];
      const a2 = geom.anchors[2];
      if (inPlot(a0.x, a0.y)) {
        specs.push(mk(0, a0.x, a0.y));
      }
      if (inPlot(a1.x, a1.y)) {
        specs.push(mk(1, a1.x, a1.y));
      }
      if (inPlot(a2.x, a2.y)) {
        specs.push(mk(2, a2.x, a2.y));
      }
      return specs;
    }
    case "fibTimeZones": {
      const a = geom.anchor;
      if (inPlot(a.x, a.y)) {
        specs.push(mk(0, a.x, a.y));
      }
      return specs;
    }
    case "brush": {
      // Cycle C.3 — brush handles intentionally hidden in v1. Body-drag
      // works via `hitGeom` → `'line'` part; intermediate-point editing is
      // out of scope (delete + redraw).
      return specs;
    }
    case "icon": {
      // Phase 13 Cycle D — icons skip the center handle (it would cover
      // the glyph) but expose ONE resize handle at the bottom-right corner
      // of the glyph's bbox. Dragging the handle scales `drawing.size`.
      const half = geom.sizeCss / 2;
      const rx = geom.anchor.x + half;
      const ry = geom.anchor.y + half;
      if (inPlot(rx, ry)) {
        specs.push(mk("icon-size", rx, ry));
      }
      return specs;
    }
  }
}

export function resolveExtendMode(extend: ExtendMode | undefined): ExtendMode {
  return extend ?? "none";
}
