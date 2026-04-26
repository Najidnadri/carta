/**
 * Phase 13 Cycle D — live ghost preview.
 *
 * While the user is in create-mode (`creating !== null` on
 * `DrawingsController`), we want a faded "ghost" of the in-progress drawing
 * to follow the cursor between clicks so the user can see what they're
 * drawing before the final commit. This module:
 *
 *  1. Decides whether a given creating-state should produce a preview
 *     (`shouldPreview`). Brush is exempt — it has its own pointer-stream
 *     capture that already streams visible points.
 *  2. Pads the placed-anchor list with cursor copies up to the kind's
 *     required arity so the existing `materializeDrawing` switch can
 *     consume it without a per-kind preview duplicate (`padPreviewAnchors`).
 *
 * The preview drawing reuses a stable `PREVIEW_DRAWING_ID` so the controller
 * pools a single Graphics, never grows. `g.alpha = 0.55` is set by
 * `redrawDrawing` when called with `{ ghost: true }`; per-stroke alpha is
 * floor-clamped to 0.7 by `resolveStroke` so even faint fib connectors stay
 * readable through the compound fade.
 */

import type { DrawingAnchor, DrawingKind } from "./types.js";
import { asDrawingId } from "./types.js";

/** Stable id for the preview drawing — used for pooled Graphics keying. */
export const PREVIEW_DRAWING_ID = asDrawingId("__carta_preview__");

/** Returns true when the kind should produce a synthetic preview drawing. */
export function shouldPreview(kind: DrawingKind, cursor: DrawingAnchor | null): boolean {
  if (cursor === null) {
    return false;
  }
  // Brush is captured via the pointer-stream FSM in `DrawingsController` —
  // its `continueBrushCapture` already streams visible points into the
  // committed drawing, so a synthetic ghost would double-render.
  if (kind === "brush") {
    return false;
  }
  // Cursor outside finite numeric space (NaN, ±Infinity from a viewport
  // that hasn't had data yet) — skip rather than feed a degenerate anchor
  // through the projector.
  const t = Number(cursor.time);
  const p = Number(cursor.price);
  return Number.isFinite(t) && Number.isFinite(p);
}

/**
 * Number of anchors expected by the kind's geometry. Used to pad the
 * placed-anchor list with cursor copies so the existing
 * `buildDrawingFromCreating` switch can consume the synthetic state.
 *
 * Mirrors `requiredAnchorsFor` in `DrawingsController.ts` — kept inline so
 * `preview.ts` can stay self-contained for testability.
 */
function requiredAnchorsForPreview(kind: DrawingKind): number {
  switch (kind) {
    case "trendline":
    case "rectangle":
    case "fibRetracement":
    case "ray":
    case "extendedLine":
    case "longPosition":
    case "shortPosition":
    case "callout":
    case "arrow":
    case "dateRange":
    case "priceRange":
    case "priceDateRange":
    case "gannFan":
    case "ellipse":
    case "fibFan":
    case "fibArcs":
      return 2;
    case "horizontalLine":
    case "verticalLine":
    case "horizontalRay":
    case "text":
    case "fibTimeZones":
    case "icon":
      return 1;
    case "parallelChannel":
    case "pitchfork":
    case "fibExtension":
      return 3;
    case "brush":
      // Brush is special — never previews via this path.
      return 0;
  }
}

/**
 * Pad `placed` with copies of `cursor` up to the kind's required arity.
 * - 0 placed: returns `[cursor, cursor, ...]` so single-anchor tools render
 *   at the cursor and multi-anchor tools render a degenerate seed.
 * - 1 placed (multi-anchor): `[placed[0], cursor, cursor?]` — cursor drives
 *   the floating end-point.
 * - 2 placed (3-anchor): `[placed[0], placed[1], cursor]` — cursor drives
 *   the third anchor (e.g. parallel channel's Δprice anchor).
 *
 * For long/short position the cursor.time is clamped forward so that the
 * `endTime > entryTime` invariant in `materializeDrawing` always holds —
 * without this, moving the cursor straight up from the entry click (same
 * X) would kill the preview because the production path returns null.
 *
 * Returns `null` when the kind doesn't preview (brush) or when the
 * resulting array would be empty.
 */
export function padPreviewAnchors(
  kind: DrawingKind,
  placed: readonly DrawingAnchor[],
  cursor: DrawingAnchor,
  intervalMs?: number,
): readonly DrawingAnchor[] | null {
  if (kind === "brush") {
    return null;
  }
  const required = requiredAnchorsForPreview(kind);
  if (required === 0) {
    return null;
  }
  const out: DrawingAnchor[] = [];
  for (let i = 0; i < required; i++) {
    const placedAnchor = placed[i];
    out.push(placedAnchor ?? cursor);
  }
  // Phase 13 Cycle D — long/short position need cursor.time strictly > entry
  // for the materializer to produce a drawing. When the user moves the
  // cursor straight up/down from the entry click (or behind it in time),
  // bump cursor.time forward to a sensible default so the preview stays
  // vertically reactive rather than vanishing.
  if ((kind === "longPosition" || kind === "shortPosition") && placed[0] !== undefined && intervalMs !== undefined) {
    const entryTime = Number(placed[0].time);
    const cursorTime = Number(cursor.time);
    const minEnd = entryTime + Math.max(intervalMs, 1) * 12;
    if (Number.isFinite(entryTime) && (!Number.isFinite(cursorTime) || cursorTime <= entryTime)) {
      const lastIdx = out.length - 1;
      const lastAnchor = out[lastIdx];
      if (lastAnchor !== undefined) {
        out[lastIdx] = Object.freeze({
          time: minEnd as DrawingAnchor["time"],
          price: lastAnchor.price,
          paneId: lastAnchor.paneId,
        });
      }
    }
  }
  return Object.freeze(out);
}
