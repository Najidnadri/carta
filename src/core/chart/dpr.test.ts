import { describe, expect, it } from "vitest";
import { resolveDpr } from "./TimeSeriesChart.js";

describe("resolveDpr — clamp + snap", () => {
  it("returns 1 for non-finite inputs", () => {
    expect(resolveDpr(Number.NaN)).toBe(1);
    expect(resolveDpr(Number.POSITIVE_INFINITY)).toBe(1);
    expect(resolveDpr(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  it("returns 1 for zero or negative inputs", () => {
    expect(resolveDpr(0)).toBe(1);
    expect(resolveDpr(-1)).toBe(1);
    expect(resolveDpr(-0.5)).toBe(1);
  });

  it("snaps fractional DPRs to {1, 1.5, 2}", () => {
    expect(resolveDpr(1)).toBe(1);
    expect(resolveDpr(1.25)).toBe(1.5);
    expect(resolveDpr(1.5)).toBe(1.5);
    expect(resolveDpr(1.75)).toBe(2);
    expect(resolveDpr(2)).toBe(2);
  });

  it("caps DPR at 2", () => {
    expect(resolveDpr(2.5)).toBe(2);
    expect(resolveDpr(3)).toBe(2);
    expect(resolveDpr(4)).toBe(2);
  });

  it("clamps subnormal positive DPR to 1", () => {
    expect(resolveDpr(0.5)).toBe(1);
    expect(resolveDpr(0.75)).toBe(1);
  });
});
