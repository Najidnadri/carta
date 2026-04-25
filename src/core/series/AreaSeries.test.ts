import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AreaSeries } from "./AreaSeries.js";
import { DataStore } from "../data/DataStore.js";
import { asPrice, asTime, type PointRecord } from "../../types.js";

const IV = 60_000;
const CHANNEL = "area";

function pt(t: number, v: number): PointRecord {
  return { time: asTime(t), value: asPrice(v) };
}

describe("AreaSeries.priceRangeInWindow", () => {
  let store: DataStore;
  let series: AreaSeries;

  beforeEach(() => {
    store = new DataStore();
    store.defineChannel({ id: CHANNEL, kind: "point" });
    series = new AreaSeries({ channel: CHANNEL });
    series.setQueryContext({ dataStore: store, getInterval: () => IV });
  });

  afterEach(() => {
    series.destroy();
    store.clearAll();
  });

  it("returns {min, max} of visible values", () => {
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
    const detached = new AreaSeries({ channel: CHANNEL });
    const r = detached.priceRangeInWindow(asTime(0), asTime(IV));
    expect(r).toBeNull();
    detached.destroy();
  });

  it("returns null on inverted window", () => {
    store.insertMany(CHANNEL, IV, [pt(0, 100)]);
    const r = series.priceRangeInWindow(asTime(10 * IV), asTime(0));
    expect(r).toBeNull();
  });

  it("returns null when interval is invalid", () => {
    store.insertMany(CHANNEL, IV, [pt(0, 100)]);
    series.setQueryContext({ dataStore: store, getInterval: () => 0 });
    expect(series.priceRangeInWindow(asTime(0), asTime(IV))).toBeNull();
  });

  it("respects strict [start, end] bounds", () => {
    store.insertMany(CHANNEL, IV, [
      pt(-IV, 50),
      pt(0, 100),
      pt(IV, 105),
      pt(2 * IV, 200),
    ]);
    const r = series.priceRangeInWindow(asTime(0), asTime(IV));
    expect(r).not.toBeNull();
    expect(Number(r?.min)).toBe(100);
    expect(Number(r?.max)).toBe(105);
  });
});
