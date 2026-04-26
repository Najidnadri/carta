/**
 * Pure magnet-snap helpers for drawing creation + edit. Time → bar centre
 * (via `alignDown(t + interval/2, interval)`); price → nearest of `{H, L}`
 * (weak) or `{O, H, L, C}` (strong). When `mode === 'off'` or the supplied
 * `bar` is `null` (no cached bar at the snapped time), the input is returned
 * unchanged. Renderer-free; ported into `DrawingsController.continueDrag` +
 * `acceptCreatePoint` per drag-frame for live snapping.
 */

import type { MagnetMode, OhlcRecord } from "../../types.js";
import { alignDown } from "../time/TimeScale.js";

export interface MagnetSnapResult {
  readonly time: number;
  readonly price: number;
  /** `true` when the input was modified by the magnet. */
  readonly snapped: boolean;
}

/**
 * Snap `time` to the centre of the bar at `intervalDuration`. Returns `time`
 * unchanged for non-finite inputs or non-positive intervals.
 */
export function nearestBarTime(time: number, intervalDuration: number): number {
  if (!Number.isFinite(time) || !Number.isFinite(intervalDuration) || intervalDuration <= 0) {
    return time;
  }
  return alignDown(time + intervalDuration / 2, intervalDuration);
}

/**
 * Apply magnet snap. Time is always snapped to bar centre when `mode !== 'off'`
 * (matches the crosshair's existing X-snap discipline). Price is snapped to
 * the nearest of `{H, L}` (weak) or `{O, H, L, C}` (strong). Ties resolve to
 * the first listed channel (open → high → low → close). When `bar === null`
 * we still snap the time but leave the price live — never drift the price to
 * a stale neighbouring bar.
 */
export function applyMagnet(
  time: number,
  price: number,
  mode: MagnetMode,
  intervalDuration: number,
  bar: OhlcRecord | null,
): MagnetSnapResult {
  if (mode === "off") {
    return { time, price, snapped: false };
  }
  const snappedTime = nearestBarTime(time, intervalDuration);
  if (bar === null) {
    return { time: snappedTime, price, snapped: snappedTime !== time };
  }
  const candidates = mode === "strong"
    ? ([
        ["O", Number(bar.open)],
        ["H", Number(bar.high)],
        ["L", Number(bar.low)],
        ["C", Number(bar.close)],
      ] as const)
    : ([
        ["H", Number(bar.high)],
        ["L", Number(bar.low)],
      ] as const);
  if (!Number.isFinite(price)) {
    return { time: snappedTime, price, snapped: snappedTime !== time };
  }
  let bestPrice = price;
  let bestDist = Infinity;
  for (const [, candidate] of candidates) {
    if (!Number.isFinite(candidate)) {
      continue;
    }
    const dist = Math.abs(candidate - price);
    if (dist < bestDist) {
      bestDist = dist;
      bestPrice = candidate;
    }
  }
  const snapped = snappedTime !== time || bestPrice !== price;
  return { time: snappedTime, price: bestPrice, snapped };
}
