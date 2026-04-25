import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BaselineSeries, splitAtBaseline, type BaselinePoint } from "./BaselineSeries.js";
import { DataStore } from "../data/DataStore.js";
import { asPrice, asTime, type PointRecord } from "../../types.js";

const IV = 60_000;
const CHANNEL = "baseline";

function pt(t: number, v: number): PointRecord {
  return { time: asTime(t), value: asPrice(v) };
}

describe("BaselineSeries.priceRangeInWindow", () => {
  let store: DataStore;
  let series: BaselineSeries;

  beforeEach(() => {
    store = new DataStore();
    store.defineChannel({ id: CHANNEL, kind: "point" });
    series = new BaselineSeries({ channel: CHANNEL, baseline: 100 });
    series.setQueryContext({ dataStore: store, getInterval: () => IV });
  });

  afterEach(() => {
    series.destroy();
    store.clearAll();
  });

  it("returns {min, max} over visible values", () => {
    store.insertMany(CHANNEL, IV, [pt(0, 95), pt(IV, 110), pt(2 * IV, 120)]);
    const r = series.priceRangeInWindow(asTime(0), asTime(2 * IV));
    expect(r).not.toBeNull();
    expect(Number(r?.min)).toBe(95);
    expect(Number(r?.max)).toBe(120);
  });

  it("skips non-finite values", () => {
    store.insertMany(CHANNEL, IV, [pt(0, 95), pt(IV, Number.NaN), pt(2 * IV, 110)]);
    const r = series.priceRangeInWindow(asTime(0), asTime(2 * IV));
    expect(r).not.toBeNull();
    expect(Number(r?.min)).toBe(95);
    expect(Number(r?.max)).toBe(110);
  });

  it("returns null on empty window", () => {
    expect(series.priceRangeInWindow(asTime(0), asTime(IV))).toBeNull();
  });

  it("returns null before query context is attached", () => {
    const detached = new BaselineSeries({ channel: CHANNEL });
    expect(detached.priceRangeInWindow(asTime(0), asTime(IV))).toBeNull();
    detached.destroy();
  });

  it("returns null on inverted window", () => {
    store.insertMany(CHANNEL, IV, [pt(0, 100)]);
    expect(series.priceRangeInWindow(asTime(10 * IV), asTime(0))).toBeNull();
  });

  it("returns null when interval is invalid", () => {
    store.insertMany(CHANNEL, IV, [pt(0, 100)]);
    series.setQueryContext({ dataStore: store, getInterval: () => 0 });
    expect(series.priceRangeInWindow(asTime(0), asTime(IV))).toBeNull();
  });
});

function pts(coords: readonly (readonly [number, number])[]): BaselinePoint[] {
  return coords.map(([x, y]) => ({ x, y }));
}

describe("splitAtBaseline", () => {
  it("returns empty groups for empty input", () => {
    const r = splitAtBaseline([], 100);
    expect(r.above).toHaveLength(0);
    expect(r.below).toHaveLength(0);
  });

  it("emits a zero-area (collinear) polygon for a single off-baseline point", () => {
    // Single-point input seeds + closes at the same x, yielding a
    // degenerate 3-vertex polygon that renders no visible area.
    const r = splitAtBaseline(pts([[0, 50]]), 100);
    expect(r.above).toHaveLength(1);
    expect(r.below).toHaveLength(0);
    expect(r.above[0]).toEqual([
      { x: 0, y: 100 },
      { x: 0, y: 50 },
      { x: 0, y: 100 },
    ]);
  });

  it("all points above baseline → one above polygon, no below polygons", () => {
    const r = splitAtBaseline(pts([[0, 50], [10, 40], [20, 30]]), 100);
    expect(r.below).toHaveLength(0);
    expect(r.above).toHaveLength(1);
    expect(r.above[0]).toEqual([
      { x: 0, y: 100 },
      { x: 0, y: 50 },
      { x: 10, y: 40 },
      { x: 20, y: 30 },
      { x: 20, y: 100 },
    ]);
  });

  it("all points below baseline → one below polygon, no above polygons", () => {
    const r = splitAtBaseline(pts([[0, 150], [10, 160], [20, 170]]), 100);
    expect(r.above).toHaveLength(0);
    expect(r.below).toHaveLength(1);
    expect(r.below[0]).toEqual([
      { x: 0, y: 100 },
      { x: 0, y: 150 },
      { x: 10, y: 160 },
      { x: 20, y: 170 },
      { x: 20, y: 100 },
    ]);
  });

  it("single crossing (above → below) splits into two polygons at the exact x", () => {
    const r = splitAtBaseline(pts([[0, 50], [10, 150]]), 100);
    expect(r.above).toHaveLength(1);
    expect(r.below).toHaveLength(1);
    expect(r.above[0]).toEqual([
      { x: 0, y: 100 },
      { x: 0, y: 50 },
      { x: 5, y: 100 },
    ]);
    expect(r.below[0]).toEqual([
      { x: 5, y: 100 },
      { x: 10, y: 150 },
      { x: 10, y: 100 },
    ]);
  });

  it("single crossing (below → above)", () => {
    const r = splitAtBaseline(pts([[0, 150], [10, 50]]), 100);
    expect(r.below).toHaveLength(1);
    expect(r.above).toHaveLength(1);
    expect(r.below[0]).toEqual([
      { x: 0, y: 100 },
      { x: 0, y: 150 },
      { x: 5, y: 100 },
    ]);
    expect(r.above[0]).toEqual([
      { x: 5, y: 100 },
      { x: 10, y: 50 },
      { x: 10, y: 100 },
    ]);
  });

  it("two crossings produce two above and one below polygon", () => {
    const r = splitAtBaseline(
      pts([[0, 50], [10, 150], [20, 50]]),
      100,
    );
    expect(r.above).toHaveLength(2);
    expect(r.below).toHaveLength(1);
  });

  it("point exactly on baseline inherits previous-side (no double-emission)", () => {
    const r = splitAtBaseline(
      pts([[0, 50], [10, 100], [20, 80]]),
      100,
    );
    expect(r.above).toHaveLength(1);
    expect(r.below).toHaveLength(0);
    expect(r.above[0]).toEqual([
      { x: 0, y: 100 },
      { x: 0, y: 50 },
      { x: 10, y: 100 },
      { x: 20, y: 80 },
      { x: 20, y: 100 },
    ]);
  });

  it("first point on baseline seeds from the first non-baseline follower", () => {
    const r = splitAtBaseline(
      pts([[0, 100], [10, 50]]),
      100,
    );
    expect(r.above).toHaveLength(1);
    expect(r.below).toHaveLength(0);
    expect(r.above[0]?.[0]).toEqual({ x: 0, y: 100 });
  });

  it("returns empty when baselineY is non-finite", () => {
    const r = splitAtBaseline(pts([[0, 50], [10, 150]]), Number.NaN);
    expect(r.above).toHaveLength(0);
    expect(r.below).toHaveLength(0);
  });
});
