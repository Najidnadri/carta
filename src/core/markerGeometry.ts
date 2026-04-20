import type {
  MarkerPosition,
  MarkerPriceField,
  OhlcRecord,
  PointRecord,
} from "../types.js";

export const MIN_MARKER_OFFSET_PX = 3;

/**
 * Pixel offset between the referenced bar's price and the marker glyph's
 * nearest edge for `above` / `below` positions. Scales with glyph size so
 * larger markers get proportionally more breathing room.
 */
export function markerOffsetPx(sizePx: number): number {
  const safe = Number.isFinite(sizePx) && sizePx > 0 ? sizePx : 0;
  return Math.max(MIN_MARKER_OFFSET_PX, safe * 0.5);
}

/**
 * Backward-snap: returns the index of the largest `records[i].time` that is
 * `<= targetTime`. Returns `-1` when no such record exists (target is before
 * the first record, or the array is empty). Records are assumed ascending
 * by `time`; ties resolve to the last matching index.
 */
export function snapBack(
  records: readonly (OhlcRecord | PointRecord)[],
  targetTime: number,
): number {
  if (records.length === 0) {
    return -1;
  }
  if (!Number.isFinite(targetTime)) {
    return -1;
  }
  let lo = 0;
  let hi = records.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = records[mid];
    if (r === undefined) {
      break;
    }
    const t = Number(r.time);
    if (t <= targetTime) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Resolve the Y-anchor (in price units — converted to pixels by the caller)
 * for a marker given its `position`, its reference record, and the
 * configured field. Rules:
 *
 * - `inBar` ignores `field`. OHLC → midpoint of `open`/`close`; point →
 *   the point's `value`.
 * - `above` / `below`: OHLC uses `field` (defaults to `high` above, `low`
 *   below when `field` is `value` or unset). Point channels always use
 *   `value`.
 *
 * Returns `null` when the resolved price is non-finite.
 */
export function resolveMarkerPrice(
  position: MarkerPosition,
  refRecord: OhlcRecord | PointRecord,
  field: MarkerPriceField | undefined,
): number | null {
  const isPoint = "value" in refRecord;
  if (position === "inBar") {
    if (isPoint) {
      const v = Number(refRecord.value);
      return Number.isFinite(v) ? v : null;
    }
    const o = Number(refRecord.open);
    const c = Number(refRecord.close);
    if (!Number.isFinite(o) || !Number.isFinite(c)) {
      return null;
    }
    return (o + c) / 2;
  }
  if (isPoint) {
    const v = Number(refRecord.value);
    return Number.isFinite(v) ? v : null;
  }
  const ohlc = refRecord;
  const effectiveField: MarkerPriceField =
    field === "high" || field === "low" || field === "close"
      ? field
      : position === "above"
        ? "high"
        : "low";
  const raw = Number(
    effectiveField === "high"
      ? ohlc.high
      : effectiveField === "low"
        ? ohlc.low
        : ohlc.close,
  );
  return Number.isFinite(raw) ? raw : null;
}

/**
 * Apply the `above` / `below` pixel offset to a resolved y-pixel. `inBar`
 * returns the y unchanged. Offset sign: `above` pulls upward (smaller y),
 * `below` pushes downward (larger y).
 */
export function applyMarkerOffsetPx(
  position: MarkerPosition,
  yPx: number,
  sizePx: number,
): number {
  if (position === "inBar") {
    return yPx;
  }
  const offset = markerOffsetPx(sizePx);
  return position === "above" ? yPx - offset : yPx + offset;
}
