import type { Interval, Time } from "../../types.js";
import { asTime } from "../../types.js";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Friendly tick spacings, in ms. Each picked step from this table ensures
 * labels fall on round wall-clock times (every 5m, 15m, 1h, etc.).
 */
export const NATURAL_STEPS_MS: readonly number[] = Object.freeze([
  SEC,
  5 * SEC,
  15 * SEC,
  30 * SEC,
  MIN,
  5 * MIN,
  15 * MIN,
  30 * MIN,
  HOUR,
  4 * HOUR,
  12 * HOUR,
  DAY,
  WEEK,
  MONTH,
  YEAR,
]);

/**
 * Picks the smallest natural step whose pixel width is ≥ `minLabelPx`.
 * Guarantees the picked step is ≥ `intervalDuration` so ticks never spawn
 * faster than bars. When even the largest table entry is too small, returns
 * the largest entry (labels may collide at extreme zoom — documented).
 */
export function pickNaturalStep(
  barSpacingPx: number,
  intervalDuration: number,
  minLabelPx = 80,
): number {
  const intervalMs = Math.max(1, intervalDuration);
  if (!Number.isFinite(barSpacingPx) || barSpacingPx <= 0) {
    return NATURAL_STEPS_MS[NATURAL_STEPS_MS.length - 1] as number;
  }
  const requiredMs = (minLabelPx * intervalMs) / barSpacingPx;
  for (const step of NATURAL_STEPS_MS) {
    if (step >= requiredMs && step >= intervalMs) {
      return step;
    }
  }
  return NATURAL_STEPS_MS[NATURAL_STEPS_MS.length - 1] as number;
}

export interface TickCandidate {
  readonly time: Time;
  readonly barIndex: number;
}

/**
 * Generates tick timestamps across `[startTime, endTime]` stepping by `step`,
 * then snaps each candidate to its nearest bar slot. Returns slots as `Time`
 * alongside their bar index relative to `firstSlot`. Adjacent identical
 * snap-results (possible at exotic intervals) are deduped.
 */
export function generateTickCandidates(
  startTime: number,
  endTime: number,
  intervalDuration: number,
  step: number,
  firstSlot: number,
): readonly TickCandidate[] {
  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    !Number.isFinite(intervalDuration) ||
    !Number.isFinite(step) ||
    !Number.isFinite(firstSlot) ||
    intervalDuration <= 0 ||
    step <= 0 ||
    startTime > endTime
  ) {
    return [];
  }

  const first = Math.ceil(startTime / step) * step;
  const out: TickCandidate[] = [];
  let lastSlot = Number.NaN;

  for (let t = first; t <= endTime; t += step) {
    const barIndex = Math.round((t - firstSlot) / intervalDuration);
    const snapped = firstSlot + barIndex * intervalDuration;
    if (snapped < startTime || snapped > endTime) {
      continue;
    }
    if (snapped === lastSlot) {
      continue;
    }
    lastSlot = snapped;
    out.push({ time: asTime(snapped), barIndex });
  }

  return out;
}

// Re-exported for callers that want to interpret Time/Interval as numbers
// in tick generation; keeps the public boundary honest.
export type { Time, Interval };
