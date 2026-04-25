import { describe, it, expect } from "vitest";
import {
  MIN_MARKER_OFFSET_PX,
  applyMarkerOffsetPx,
  markerOffsetPx,
  resolveMarkerPrice,
  snapBack,
} from "./markerGeometry.js";
import { asPrice, asTime, type OhlcRecord, type PointRecord } from "../../types.js";

function ohlc(time: number, o: number, h: number, l: number, c: number): OhlcRecord {
  return {
    time: asTime(time),
    open: asPrice(o),
    high: asPrice(h),
    low: asPrice(l),
    close: asPrice(c),
  };
}

function point(time: number, v: number): PointRecord {
  return { time: asTime(time), value: asPrice(v) };
}

describe("markerOffsetPx", () => {
  it("clamps to MIN_MARKER_OFFSET_PX for small sizes", () => {
    expect(markerOffsetPx(4)).toBe(MIN_MARKER_OFFSET_PX);
    expect(markerOffsetPx(0)).toBe(MIN_MARKER_OFFSET_PX);
    expect(markerOffsetPx(Number.NaN)).toBe(MIN_MARKER_OFFSET_PX);
  });
  it("scales linearly above the clamp", () => {
    expect(markerOffsetPx(12)).toBe(6);
    expect(markerOffsetPx(20)).toBe(10);
  });
});

describe("snapBack", () => {
  const records = [
    ohlc(100, 1, 1, 1, 1),
    ohlc(200, 2, 2, 2, 2),
    ohlc(300, 3, 3, 3, 3),
  ];

  it("finds the largest time <= target", () => {
    expect(snapBack(records, 250)).toBe(1);
    expect(snapBack(records, 300)).toBe(2);
    expect(snapBack(records, 99)).toBe(-1);
  });

  it("returns -1 on empty input", () => {
    expect(snapBack([], 100)).toBe(-1);
  });

  it("returns -1 on non-finite target (NaN, +/-Infinity all fall into the same branch)", () => {
    expect(snapBack(records, Number.NaN)).toBe(-1);
    expect(snapBack(records, Number.POSITIVE_INFINITY)).toBe(-1);
    expect(snapBack(records, Number.NEGATIVE_INFINITY)).toBe(-1);
  });

  it("handles duplicate times by returning the last matching index", () => {
    const dup = [ohlc(100, 1, 1, 1, 1), ohlc(100, 2, 2, 2, 2), ohlc(200, 3, 3, 3, 3)];
    expect(snapBack(dup, 100)).toBe(1);
  });

  it("works on point records too", () => {
    const pts = [point(100, 10), point(200, 20), point(300, 30)];
    expect(snapBack(pts, 250)).toBe(1);
  });
});

describe("resolveMarkerPrice — OHLC", () => {
  const bar = ohlc(100, 50, 60, 40, 55);

  it("inBar returns (open + close) / 2", () => {
    expect(resolveMarkerPrice("inBar", bar, undefined)).toBe(52.5);
  });

  it("inBar ignores field", () => {
    expect(resolveMarkerPrice("inBar", bar, "high")).toBe(52.5);
  });

  it("above with field 'high' returns high", () => {
    expect(resolveMarkerPrice("above", bar, "high")).toBe(60);
  });

  it("below with field 'low' returns low", () => {
    expect(resolveMarkerPrice("below", bar, "low")).toBe(40);
  });

  it("above without field defaults to 'high'", () => {
    expect(resolveMarkerPrice("above", bar, undefined)).toBe(60);
  });

  it("below without field defaults to 'low'", () => {
    expect(resolveMarkerPrice("below", bar, undefined)).toBe(40);
  });

  it("above with field 'close' honors the explicit close", () => {
    expect(resolveMarkerPrice("above", bar, "close")).toBe(55);
  });

  it("above with field 'value' (not applicable to OHLC) falls back to 'high'", () => {
    expect(resolveMarkerPrice("above", bar, "value")).toBe(60);
  });

  it("returns null when open/close are NaN on inBar", () => {
    const bad = ohlc(100, Number.NaN, 60, 40, 55);
    expect(resolveMarkerPrice("inBar", bad, undefined)).toBeNull();
  });

  it("returns null when resolved field is NaN", () => {
    const bad = ohlc(100, 50, Number.NaN, 40, 55);
    expect(resolveMarkerPrice("above", bad, "high")).toBeNull();
  });
});

describe("resolveMarkerPrice — Point", () => {
  const p = point(100, 42);

  it("inBar returns value", () => {
    expect(resolveMarkerPrice("inBar", p, undefined)).toBe(42);
  });

  it("above / below return value (field ignored)", () => {
    expect(resolveMarkerPrice("above", p, "high")).toBe(42);
    expect(resolveMarkerPrice("below", p, "close")).toBe(42);
  });

  it("returns null on NaN value", () => {
    expect(resolveMarkerPrice("above", point(100, Number.NaN), undefined)).toBeNull();
  });
});

describe("applyMarkerOffsetPx", () => {
  it("inBar returns y unchanged", () => {
    expect(applyMarkerOffsetPx("inBar", 100, 12)).toBe(100);
  });
  it("above pulls upward (smaller y)", () => {
    expect(applyMarkerOffsetPx("above", 100, 12)).toBe(94);
  });
  it("below pushes downward (larger y)", () => {
    expect(applyMarkerOffsetPx("below", 100, 12)).toBe(106);
  });
  it("clamps small sizes to MIN_MARKER_OFFSET_PX", () => {
    expect(applyMarkerOffsetPx("above", 100, 4)).toBe(100 - MIN_MARKER_OFFSET_PX);
  });
});
