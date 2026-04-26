/**
 * Heckbert (1990) "nice numbers" tick generator for linear price axes.
 *
 * Callers pass an *effective* domain (after margins) and a target tick count.
 * The algorithm picks a step from the 1 / 2 / 2.5 / 5 / 10 × 10^k family whose
 * resulting tick count is closest to the target.
 *
 * Output invariants:
 * - Monotonically increasing.
 * - Each value is an exact multiple of the chosen step.
 * - Always ≥ 2 ticks unless the domain is degenerate.
 * - Size is capped at `targetCount * 2` defensively.
 */

const MAX_TICKS_FACTOR = 2;
const MIN_TARGET = 2;
/**
 * Phase 14 Cycle B fix-up F-2 — defensive cap on the requested target tick
 * count. Any chart with a sane viewport will request <100 ticks; a request
 * for 1024+ means the caller passed a degenerate `pixelHeight` (e.g. an
 * unclamped `applyOptions({ height: MAX_SAFE_INTEGER })`). Without this
 * cap, the inner loop allocates an astronomical array and throws
 * `RangeError`. We cap silently because the caller's degenerate input was
 * already warned at the API boundary (`Pane.setHeight`).
 */
const MAX_TARGET = 1024;

/**
 * Returns the "nicest" number ≤ or ≥ `range` drawn from the
 * 1 / 2 / 2.5 / 5 × 10^k family. `round = true` prefers the nearest from
 * below, `round = false` always rounds up to the next nice number.
 */
export function niceNumber(range: number, round: boolean): number {
  if (!Number.isFinite(range) || range <= 0) {
    return 1;
  }
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let niceFraction: number;
  if (round) {
    if (fraction < 1.5) {
      niceFraction = 1;
    } else if (fraction < 3) {
      niceFraction = 2;
    } else if (fraction < 7) {
      niceFraction = 5;
    } else {
      niceFraction = 10;
    }
  } else {
    if (fraction <= 1) {
      niceFraction = 1;
    } else if (fraction <= 2) {
      niceFraction = 2;
    } else if (fraction <= 2.5) {
      niceFraction = 2.5;
    } else if (fraction <= 5) {
      niceFraction = 5;
    } else {
      niceFraction = 10;
    }
  }
  return niceFraction * 10 ** exponent;
}

/**
 * Generates a monotonic, evenly-spaced list of tick values in
 * `[min, max]` such that each tick is a multiple of the picked step.
 * Returns `[]` when inputs are invalid or degenerate.
 */
export function generatePriceTicks(
  min: number,
  max: number,
  targetCount: number,
): readonly number[] {
  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    !Number.isFinite(targetCount) ||
    min >= max
  ) {
    return [];
  }
  const target = Math.min(MAX_TARGET, Math.max(MIN_TARGET, Math.floor(targetCount)));
  const range = niceNumber(max - min, false);
  const step = niceNumber(range / (target - 1), true);
  if (step <= 0 || !Number.isFinite(step)) {
    return [];
  }

  const cap = target * MAX_TICKS_FACTOR;
  const first = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = first; v <= max + step * 1e-9 && out.length < cap; v += step) {
    // Snap to step multiples to avoid float drift across many iterations.
    const snapped = Math.round(v / step) * step;
    if (snapped < min - step * 1e-9 || snapped > max + step * 1e-9) {
      continue;
    }
    if (out.length > 0) {
      const previous = out[out.length - 1] as number;
      if (snapped === previous) {
        continue;
      }
    }
    out.push(snapped);
  }
  return out;
}

/**
 * Convenience: `max(MIN_TARGET, floor(pixelHeight / minLabelPx))`. Mirrors
 * the sizing heuristic in miniplan §3.1 — fewer, well-spaced labels beat
 * dense clutter.
 */
export function targetTickCountForHeight(pixelHeight: number, minLabelPx: number): number {
  if (
    !Number.isFinite(pixelHeight) ||
    !Number.isFinite(minLabelPx) ||
    pixelHeight <= 0 ||
    minLabelPx <= 0
  ) {
    return MIN_TARGET;
  }
  return Math.max(MIN_TARGET, Math.floor(pixelHeight / minLabelPx));
}
