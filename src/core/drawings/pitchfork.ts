/**
 * Phase 13 Cycle C.1 — pure pitchfork helpers.
 *
 * Three variants share anchor count (3) and render topology (centreline +
 * upper rail + lower rail) but differ in how the centreline base is
 * computed. This file owns the variant math so the projector + tests can
 * share one source of truth.
 */

import type { PitchforkVariant } from "./types.js";

/**
 * Compute the centreline base point in **data space** for a given variant.
 * The centreline is then `pivot → base`, optionally extended to plot edge.
 *
 * `pivot.time` lies before both reactions in canonical use; mathematically
 * the midpoint formulas are symmetric under swap, so the function tolerates
 * any anchor order.
 */
export function computePitchforkCenterlineBase(
  variant: PitchforkVariant,
  pivot: { readonly time: number; readonly price: number },
  reaction1: { readonly time: number; readonly price: number },
  reaction2: { readonly time: number; readonly price: number },
): { readonly time: number; readonly price: number } {
  const midPrice = (reaction1.price + reaction2.price) / 2;
  switch (variant) {
    case "andrews":
      return Object.freeze({
        time: (reaction1.time + reaction2.time) / 2,
        price: midPrice,
      });
    case "schiff":
      return Object.freeze({
        time: pivot.time,
        price: midPrice,
      });
    case "modifiedSchiff": {
      const reactionMidTime = (reaction1.time + reaction2.time) / 2;
      return Object.freeze({
        time: (pivot.time + reactionMidTime) / 2,
        price: midPrice,
      });
    }
  }
}

/** Gann fan slopes used by the renderer. The 1×1 line passes through the direction anchor. */
export const GANN_FAN_SLOPES: readonly number[] = Object.freeze([
  1 / 8,
  1 / 4,
  1 / 3,
  1 / 2,
  1,
  2,
  3,
  4,
  8,
]);
