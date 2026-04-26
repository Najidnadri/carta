import { describe, expect, it } from "vitest";
import { applyMagnet, nearestBarTime } from "./magnet.js";
import { asPrice, asTime, type OhlcRecord } from "../../types.js";

const bar = (o: number, h: number, l: number, c: number): OhlcRecord => Object.freeze({
  time: asTime(0),
  open: asPrice(o),
  high: asPrice(h),
  low: asPrice(l),
  close: asPrice(c),
});

describe("nearestBarTime", () => {
  it("snaps a time inside a bar to the bar's start (centre arithmetic)", () => {
    expect(nearestBarTime(0, 60_000)).toBe(0);
    expect(nearestBarTime(29_999, 60_000)).toBe(0);
    expect(nearestBarTime(30_000, 60_000)).toBe(60_000);
    expect(nearestBarTime(120_000, 60_000)).toBe(120_000);
  });

  it("returns input untouched on non-finite or non-positive interval", () => {
    expect(nearestBarTime(NaN, 60_000)).toBeNaN();
    expect(nearestBarTime(0, 0)).toBe(0);
    expect(nearestBarTime(0, -100)).toBe(0);
    expect(nearestBarTime(0, NaN)).toBe(0);
  });
});

describe("applyMagnet", () => {
  it("returns input unchanged when mode is off", () => {
    const r = applyMagnet(123, 45.6, "off", 60_000, bar(10, 20, 5, 15));
    expect(r).toEqual({ time: 123, price: 45.6, snapped: false });
  });

  it("weak snaps price to the nearest of {high, low}", () => {
    const b = bar(10, 20, 5, 15);
    expect(applyMagnet(0, 18, "weak", 60_000, b).price).toBe(20);
    expect(applyMagnet(0, 7, "weak", 60_000, b).price).toBe(5);
    expect(applyMagnet(0, 15.1, "weak", 60_000, b).price).toBe(20);
  });

  it("strong snaps price to nearest of {O, H, L, C}", () => {
    const b = bar(10, 20, 5, 15);
    expect(applyMagnet(0, 11, "strong", 60_000, b).price).toBe(10);
    expect(applyMagnet(0, 14, "strong", 60_000, b).price).toBe(15);
    expect(applyMagnet(0, 18, "strong", 60_000, b).price).toBe(20);
    expect(applyMagnet(0, 6, "strong", 60_000, b).price).toBe(5);
  });

  it("snaps time to bar centre regardless of mode", () => {
    expect(applyMagnet(35_000, 0, "weak", 60_000, bar(0, 1, -1, 0)).time).toBe(60_000);
    expect(applyMagnet(35_000, 0, "strong", 60_000, bar(0, 1, -1, 0)).time).toBe(60_000);
  });

  it("when bar is null, snaps time only and leaves price unchanged", () => {
    const r = applyMagnet(35_000, 99, "strong", 60_000, null);
    expect(r.time).toBe(60_000);
    expect(r.price).toBe(99);
    expect(r.snapped).toBe(true);
  });

  it("non-finite price short-circuits the price snap", () => {
    const r = applyMagnet(35_000, NaN, "strong", 60_000, bar(0, 1, -1, 0));
    expect(r.time).toBe(60_000);
    expect(r.price).toBeNaN();
  });

  it("ties go to the first listed candidate (O before H before L before C)", () => {
    const b = bar(10, 20, 0, 30);
    // price 5 is equidistant between low (0) and open (10) → first listed wins (O=10)
    expect(applyMagnet(0, 5, "strong", 60_000, b).price).toBe(10);
  });
});
