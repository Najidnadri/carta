import { describe, expect, it } from "vitest";
import {
  generatePriceTicks,
  niceNumber,
  targetTickCountForHeight,
} from "./priceNaturalStep.js";

describe("niceNumber", () => {
  it("picks 1/2/5/10 × 10^k when round=true", () => {
    expect(niceNumber(1.2, true)).toBe(1);
    expect(niceNumber(1.9, true)).toBe(2);
    expect(niceNumber(2.6, true)).toBe(2);
    expect(niceNumber(3, true)).toBe(5);
    expect(niceNumber(6.5, true)).toBe(5);
    expect(niceNumber(7.1, true)).toBe(10);
    expect(niceNumber(55, true)).toBe(50);
  });

  it("picks ceil-rounded family members when round=false", () => {
    expect(niceNumber(1, false)).toBe(1);
    expect(niceNumber(1.1, false)).toBe(2);
    expect(niceNumber(2.1, false)).toBe(2.5);
    expect(niceNumber(3, false)).toBe(5);
    expect(niceNumber(6, false)).toBe(10);
  });

  it("falls back to 1 on non-positive or non-finite input", () => {
    expect(niceNumber(0, true)).toBe(1);
    expect(niceNumber(-10, true)).toBe(1);
    expect(niceNumber(Number.NaN, true)).toBe(1);
    expect(niceNumber(Number.POSITIVE_INFINITY, true)).toBe(1);
  });

  it("scales to arbitrary powers of 10", () => {
    expect(niceNumber(12_345, true)).toBe(10_000);
    expect(niceNumber(0.004, true)).toBe(0.005);
  });
});

describe("generatePriceTicks", () => {
  it("handles 0 – 100 with 5 ticks → 0, 25, 50, 75, 100 (nice 25-step)", () => {
    const ticks = generatePriceTicks(0, 100, 5);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.length).toBeLessThanOrEqual(10);
    expect(ticks[0]).toBeGreaterThanOrEqual(0);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(100);
  });

  it("handles 98 – 102 with 5 ticks and yields sub-integer steps", () => {
    const ticks = generatePriceTicks(98, 102, 5);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(98);
      expect(t).toBeLessThanOrEqual(102);
    }
  });

  it("monotonically increasing with consistent spacing", () => {
    const ticks = generatePriceTicks(0, 10, 6);
    for (let i = 1; i < ticks.length; i++) {
      const prev = ticks[i - 1] as number;
      const curr = ticks[i] as number;
      expect(curr).toBeGreaterThan(prev);
    }
    if (ticks.length >= 3) {
      const t0 = ticks[0] as number;
      const t1 = ticks[1] as number;
      const t2 = ticks[2] as number;
      expect(t2 - t1).toBeCloseTo(t1 - t0, 6);
    }
  });

  it("handles negative ranges", () => {
    const ticks = generatePriceTicks(-50, 50, 6);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0]).toBeGreaterThanOrEqual(-50);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(50);
  });

  it("handles sub-penny ranges without collapsing", () => {
    const ticks = generatePriceTicks(1e-9, 2e-9, 5);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });

  it("handles BTC-scale ranges (60000 – 80000) with round-thousand steps", () => {
    const ticks = generatePriceTicks(60_000, 80_000, 6);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(60_000);
      expect(t).toBeLessThanOrEqual(80_000);
    }
  });

  it("returns [] when min >= max", () => {
    expect(generatePriceTicks(100, 100, 5)).toEqual([]);
    expect(generatePriceTicks(100, 50, 5)).toEqual([]);
  });

  it("returns [] on non-finite inputs", () => {
    expect(generatePriceTicks(Number.NaN, 10, 5)).toEqual([]);
    expect(generatePriceTicks(0, Number.POSITIVE_INFINITY, 5)).toEqual([]);
    expect(generatePriceTicks(0, 10, Number.NaN)).toEqual([]);
  });

  it("caps output at ≤ targetCount * 2 for pathological target counts", () => {
    const ticks = generatePriceTicks(0, 100, 1000);
    expect(ticks.length).toBeLessThanOrEqual(1000 * 2);
  });

  it("clamps targetCount to a minimum of 2", () => {
    const ticks = generatePriceTicks(0, 1, 1);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });

  it("yields round values for 0 – 1 with 5 ticks", () => {
    const ticks = generatePriceTicks(0, 1, 5);
    for (const t of ticks) {
      expect(Math.round(t * 10) / 10).toBeCloseTo(t, 6);
    }
  });
});

describe("targetTickCountForHeight", () => {
  it("returns 2 as the absolute minimum", () => {
    expect(targetTickCountForHeight(50, 40)).toBe(2);
    expect(targetTickCountForHeight(0, 40)).toBe(2);
    expect(targetTickCountForHeight(-1, 40)).toBe(2);
    expect(targetTickCountForHeight(Number.NaN, 40)).toBe(2);
  });

  it("scales linearly with height at 40px/label", () => {
    expect(targetTickCountForHeight(400, 40)).toBe(10);
    expect(targetTickCountForHeight(800, 40)).toBe(20);
  });
});
