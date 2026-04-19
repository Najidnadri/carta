import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LineSeries } from "./LineSeries.js";
import { DataStore } from "./DataStore.js";
import { asPrice, asTime, type PointRecord } from "../types.js";

const IV = 60_000;
const CHANNEL = "sma20";

function pt(t: number, v: number): PointRecord {
  return { time: asTime(t), value: asPrice(v) };
}

describe("LineSeries.priceRangeInWindow", () => {
  let store: DataStore;
  let series: LineSeries;

  beforeEach(() => {
    store = new DataStore();
    store.defineChannel({ id: CHANNEL, kind: "point" });
    series = new LineSeries({ channel: CHANNEL });
    series.setQueryContext({ dataStore: store, getInterval: () => IV });
  });

  afterEach(() => {
    series.destroy();
    store.clearAll();
  });

  it("returns {min, max} of value across visible points", () => {
    store.insertMany(CHANNEL, IV, [pt(0, 100), pt(IV, 110), pt(2 * IV, 95)]);
    const r = series.priceRangeInWindow(asTime(0), asTime(2 * IV));
    expect(r).not.toBeNull();
    expect(Number(r?.min)).toBe(95);
    expect(Number(r?.max)).toBe(110);
  });

  it("returns null when window is empty", () => {
    const r = series.priceRangeInWindow(asTime(0), asTime(IV));
    expect(r).toBeNull();
  });

  it("skips non-finite values", () => {
    store.insertMany(CHANNEL, IV, [
      pt(0, 100),
      pt(IV, Number.NaN),
      pt(2 * IV, 105),
    ]);
    const r = series.priceRangeInWindow(asTime(0), asTime(2 * IV));
    expect(r).not.toBeNull();
    expect(Number(r?.min)).toBe(100);
    expect(Number(r?.max)).toBe(105);
  });

  it("returns null before query context is attached", () => {
    const detached = new LineSeries({ channel: CHANNEL });
    const r = detached.priceRangeInWindow(asTime(0), asTime(IV));
    expect(r).toBeNull();
    detached.destroy();
  });

  it("returns null when every point is non-finite", () => {
    store.insertMany(CHANNEL, IV, [
      pt(0, Number.NaN),
      pt(IV, Number.POSITIVE_INFINITY),
    ]);
    const r = series.priceRangeInWindow(asTime(0), asTime(2 * IV));
    expect(r).toBeNull();
  });

  it("returns null on inverted window", () => {
    store.insertMany(CHANNEL, IV, [pt(0, 100)]);
    const r = series.priceRangeInWindow(asTime(10 * IV), asTime(0));
    expect(r).toBeNull();
  });
});
