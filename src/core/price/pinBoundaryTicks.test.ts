import { describe, expect, it } from "vitest";
import { pinBoundaryTicks } from "./PriceAxis.js";

describe("pinBoundaryTicks (Phase 14 Cycle B fix-up F-1)", () => {
  it("inserts both boundaries when missing from the natural-step output", () => {
    // Natural step produced only `[0]` (the F-1 mobile-RSI failure mode).
    const out = pinBoundaryTicks([0], 0, 100);
    expect(out).toEqual([0, 100]);
  });

  it("inserts only the missing boundary", () => {
    expect(pinBoundaryTicks([0, 25, 50, 75], 0, 100)).toEqual([0, 25, 50, 75, 100]);
    expect(pinBoundaryTicks([25, 50, 75, 100], 0, 100)).toEqual([0, 25, 50, 75, 100]);
  });

  it("returns the natural list unchanged when both boundaries already present", () => {
    const input = [0, 25, 50, 75, 100];
    const out = pinBoundaryTicks(input, 0, 100);
    expect(out).toEqual(input);
  });

  it("preserves monotonic order after pinning", () => {
    const out = pinBoundaryTicks([20, 40, 60, 80], 0, 100);
    for (let i = 1; i < out.length; i += 1) {
      expect((out[i] ?? 0) > (out[i - 1] ?? 0)).toBe(true);
    }
  });

  it("dedupes within float tolerance", () => {
    // 0 + epsilon is treated as already-present.
    const out = pinBoundaryTicks([1e-12, 50, 100 - 1e-12], 0, 100);
    expect(out.length).toBe(3);
  });

  it("handles negative boundaries (Z-score [-3, 3])", () => {
    expect(pinBoundaryTicks([-2, 0, 2], -3, 3)).toEqual([-3, -2, 0, 2, 3]);
  });

  it("returns input unchanged on invalid bounds", () => {
    expect(pinBoundaryTicks([1, 2, 3], 5, 5)).toEqual([1, 2, 3]);
    expect(pinBoundaryTicks([1, 2, 3], 10, 0)).toEqual([1, 2, 3]);
    expect(pinBoundaryTicks([1, 2, 3], Number.NaN, 100)).toEqual([1, 2, 3]);
  });
});
