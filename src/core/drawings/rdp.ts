/**
 * Phase 13 Cycle C.3 — Ramer–Douglas–Peucker polyline simplifier.
 *
 * Iterative (stack-based) so 1000-point inputs don't blow the call stack on
 * V8. Returns a new array of the kept points; never mutates the input.
 *
 * Epsilon is in the same coordinate space as the input — controllers pass
 * CSS-px epsilons of `1.5 / dprBucket` (commit) or `0.75 / dprBucket`
 * (mid-stroke) so the visual deviation stays equal across DPRs.
 */

export interface SimplePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Perpendicular distance from `p` to the segment `[a, b]`, treating it as
 * an infinite line for the deviation test. `len2 === 0` collapses to the
 * point-to-point distance from `p` to `a`.
 */
function perpDistance(p: SimplePoint, a: SimplePoint, b: SimplePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  // Cross product magnitude / segment length = perpendicular distance to the line.
  const cross = Math.abs(dx * (a.y - p.y) - dy * (a.x - p.x));
  return cross / Math.sqrt(len2);
}

/**
 * Run RDP on `pts`. Returns a frozen array of the kept points.
 *
 * - `pts.length < 3` is a no-op identity (still returns a frozen copy).
 * - Non-finite epsilon or `epsilon <= 0` → identity.
 * - Non-finite x/y in any point → that point is dropped before simplification.
 */
export function simplifyRdp(
  pts: readonly SimplePoint[],
  epsilon: number,
): readonly SimplePoint[] {
  // Filter non-finite first so RDP arithmetic stays well-defined.
  const safe: SimplePoint[] = [];
  for (const p of pts) {
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
      safe.push(p);
    }
  }
  if (safe.length < 3 || !Number.isFinite(epsilon) || epsilon <= 0) {
    return Object.freeze(safe);
  }
  const lastIdx = safe.length - 1;
  const keep = new Uint8Array(safe.length);
  keep[0] = 1;
  keep[lastIdx] = 1;
  const stack: number[] = [0, lastIdx];
  while (stack.length > 0) {
    const e = stack.pop();
    const s = stack.pop();
    if (s === undefined || e === undefined || e - s < 2) {
      continue;
    }
    const a = safe[s];
    const b = safe[e];
    if (a === undefined || b === undefined) {
      continue;
    }
    let maxD = 0;
    let maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const p = safe[i];
      if (p === undefined) {
        continue;
      }
      const d = perpDistance(p, a, b);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > epsilon && maxI !== -1) {
      keep[maxI] = 1;
      stack.push(s, maxI, maxI, e);
    }
  }
  const out: SimplePoint[] = [];
  for (let i = 0; i < safe.length; i++) {
    if (keep[i] === 1) {
      const p = safe[i];
      if (p !== undefined) {
        out.push(p);
      }
    }
  }
  return Object.freeze(out);
}
