import type { Graphics } from "pixi.js";

/**
 * Dash pattern in CSS pixels — [on-length, off-length].
 * Miniplan §3.10: dashed = 6/3, dotted = 1/3.
 */
export const DASH_PATTERNS: Readonly<Record<"dashed" | "dotted", readonly [number, number]>> =
  Object.freeze({
    dashed: [6, 3] as const,
    dotted: [1, 3] as const,
  });

export interface DashState {
  /** Pixels consumed into the current on- or off-interval. */
  readonly phase: number;
  /** `true` when the next emitted pixel falls on an `on` (inked) interval. */
  readonly inkOn: boolean;
}

export const INITIAL_DASH_STATE: DashState = Object.freeze({ phase: 0, inkOn: true });

export interface DashEmitResult {
  readonly state: DashState;
  /** Number of `lineTo` calls emitted by this segment (0 when the segment is degenerate). */
  readonly emitted: number;
  /**
   * `true` when the emit budget was exhausted before the whole segment
   * was drawn — the caller should stroke, then re-call with the returned
   * `nextX`/`nextY` as the new start and the segment's endpoint unchanged.
   */
  readonly exhausted: boolean;
  /** Starting x for the next call when `exhausted === true`. */
  readonly nextX: number;
  /** Starting y for the next call when `exhausted === true`. */
  readonly nextY: number;
}

/**
 * Emit the dashed portion of a straight segment `(x0, y0) → (x1, y1)` onto a
 * cleared `Graphics`, carrying the dash `phase` and `inkOn` across calls so
 * the pattern is continuous across polyline joints.
 *
 * `maxEmits` caps the number of emitted `lineTo` pairs. When the cap is hit
 * mid-segment, `exhausted: true` is returned along with `nextX`/`nextY` so
 * the caller can `stroke()` + resume. Skips 0-length and non-finite inputs
 * without throwing.
 */
export function emitDashedSegment(
  g: Graphics,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  pattern: readonly [number, number],
  state: DashState,
  maxEmits: number = Number.POSITIVE_INFINITY,
): DashEmitResult {
  if (
    !Number.isFinite(x0) ||
    !Number.isFinite(y0) ||
    !Number.isFinite(x1) ||
    !Number.isFinite(y1)
  ) {
    return { state, emitted: 0, exhausted: false, nextX: x0, nextY: y0 };
  }
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len <= 0) {
    return { state, emitted: 0, exhausted: false, nextX: x0, nextY: y0 };
  }
  const onLen = pattern[0];
  const offLen = pattern[1];
  if (!(onLen > 0) || !(offLen > 0)) {
    return { state, emitted: 0, exhausted: false, nextX: x0, nextY: y0 };
  }
  const ux = dx / len;
  const uy = dy / len;

  let { phase, inkOn } = state;
  let consumed = 0;
  let emitted = 0;
  while (consumed < len) {
    const segmentLen = inkOn ? onLen : offLen;
    const remainingInPhase = segmentLen - phase;
    const step = Math.min(remainingInPhase, len - consumed);
    if (step <= 0) {
      break;
    }
    if (inkOn) {
      const sx = x0 + ux * consumed;
      const sy = y0 + uy * consumed;
      const ex = x0 + ux * (consumed + step);
      const ey = y0 + uy * (consumed + step);
      g.moveTo(sx, sy).lineTo(ex, ey);
      emitted++;
    }
    consumed += step;
    phase += step;
    if (phase >= segmentLen - Number.EPSILON) {
      phase = 0;
      inkOn = !inkOn;
    }
    if (emitted >= maxEmits && consumed < len) {
      return {
        state: Object.freeze({ phase, inkOn }),
        emitted,
        exhausted: true,
        nextX: x0 + ux * consumed,
        nextY: y0 + uy * consumed,
      };
    }
  }
  return {
    state: Object.freeze({ phase, inkOn }),
    emitted,
    exhausted: false,
    nextX: x1,
    nextY: y1,
  };
}
