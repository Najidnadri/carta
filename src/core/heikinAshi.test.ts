import { describe, it, expect } from "vitest";
import { computeHeikinAshi } from "./heikinAshi.js";
import { asPrice, asTime, type OhlcRecord } from "../types.js";

const IV = 60_000;

function bar(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
): OhlcRecord {
  return {
    time: asTime(t),
    open: asPrice(o),
    high: asPrice(h),
    low: asPrice(l),
    close: asPrice(c),
  };
}

describe("computeHeikinAshi", () => {
  it("returns an empty array for an empty input", () => {
    expect(computeHeikinAshi([])).toEqual([]);
  });

  it("seeds HA_open[0] = (O[0] + C[0]) / 2 on a single bar", () => {
    const ha = computeHeikinAshi([bar(0, 100, 110, 90, 105)]);
    expect(ha).toHaveLength(1);
    const h0 = ha[0];
    if (h0 === undefined) {
      throw new Error("missing ha[0]");
    }
    expect(Number(h0.open)).toBe((100 + 105) / 2);
    expect(Number(h0.close)).toBe((100 + 110 + 90 + 105) / 4);
    expect(Number(h0.high)).toBe(Math.max(110, Number(h0.open), Number(h0.close)));
    expect(Number(h0.low)).toBe(Math.min(90, Number(h0.open), Number(h0.close)));
  });

  it("applies the recursive formula across multiple bars", () => {
    const records = [
      bar(0, 100, 110, 90, 105),
      bar(IV, 105, 115, 100, 112),
      bar(2 * IV, 112, 118, 108, 115),
    ];
    const ha = computeHeikinAshi(records);
    expect(ha).toHaveLength(3);
    const h0 = ha[0];
    const h1 = ha[1];
    const h2 = ha[2];
    if (h0 === undefined || h1 === undefined || h2 === undefined) {
      throw new Error("missing ha entries");
    }
    // HA_open[1] = (HA_open[0] + HA_close[0]) / 2
    expect(Number(h1.open)).toBeCloseTo((Number(h0.open) + Number(h0.close)) / 2, 10);
    expect(Number(h1.close)).toBeCloseTo((105 + 115 + 100 + 112) / 4, 10);
    expect(Number(h2.open)).toBeCloseTo((Number(h1.open) + Number(h1.close)) / 2, 10);
  });

  it("preserves per-bar high/low via max/min against source H/L", () => {
    const ha = computeHeikinAshi([bar(0, 100, 200, 50, 150)]);
    const h0 = ha[0];
    if (h0 === undefined) {
      throw new Error();
    }
    expect(Number(h0.high)).toBeGreaterThanOrEqual(Number(h0.open));
    expect(Number(h0.high)).toBeGreaterThanOrEqual(Number(h0.close));
    expect(Number(h0.low)).toBeLessThanOrEqual(Number(h0.open));
    expect(Number(h0.low)).toBeLessThanOrEqual(Number(h0.close));
  });

  it("skips non-finite records without advancing state", () => {
    const records = [
      bar(0, 100, 110, 90, 105),
      bar(IV, Number.NaN, 115, 100, 112),
      bar(2 * IV, 112, 118, 108, 115),
    ];
    const ha = computeHeikinAshi(records);
    expect(ha).toHaveLength(2);
    const [h0, h1] = ha;
    if (h0 === undefined || h1 === undefined) {
      throw new Error();
    }
    // h1 should use h0 (not the skipped bar) as the recursion source.
    expect(Number(h1.open)).toBeCloseTo((Number(h0.open) + Number(h0.close)) / 2, 10);
  });

  it("accepts a seed to resume recursion from a cached tail", () => {
    const seed = { prevHaOpen: 100, prevHaClose: 110 };
    const ha = computeHeikinAshi([bar(0, 108, 115, 105, 112)], seed);
    expect(ha).toHaveLength(1);
    const h0 = ha[0];
    if (h0 === undefined) {
      throw new Error();
    }
    expect(Number(h0.open)).toBeCloseTo((100 + 110) / 2, 10);
  });

  it("drops out-of-order entries (non-monotonic time)", () => {
    const records = [
      bar(0, 100, 110, 90, 105),
      bar(IV, 105, 115, 100, 112),
      bar(IV / 2, 200, 300, 150, 250),
      bar(2 * IV, 112, 118, 108, 115),
    ];
    const ha = computeHeikinAshi(records);
    expect(ha).toHaveLength(3);
    expect(ha.map((b) => Number(b.time))).toEqual([0, IV, 2 * IV]);
  });

  it("drops duplicate-time entries (non-strictly-increasing)", () => {
    const records = [
      bar(0, 100, 110, 90, 105),
      bar(0, 200, 210, 190, 205),
    ];
    const ha = computeHeikinAshi(records);
    expect(ha).toHaveLength(1);
    expect(Number(ha[0]?.time)).toBe(0);
  });

  it("handles internally inconsistent OHLC (high < low) by reusing max/min", () => {
    // Source is garbage but HA output still has high >= open/close and low <= open/close.
    const ha = computeHeikinAshi([bar(0, 100, 50, 120, 110)]);
    const h0 = ha[0];
    if (h0 === undefined) {
      throw new Error();
    }
    expect(Number(h0.high)).toBeGreaterThanOrEqual(Number(h0.open));
    expect(Number(h0.high)).toBeGreaterThanOrEqual(Number(h0.close));
    expect(Number(h0.low)).toBeLessThanOrEqual(Number(h0.open));
    expect(Number(h0.low)).toBeLessThanOrEqual(Number(h0.close));
  });
});
