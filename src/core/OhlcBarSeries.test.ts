import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OhlcBarSeries } from "./OhlcBarSeries.js";
import { DataStore } from "./DataStore.js";
import { asPrice, asTime, type OhlcRecord } from "../types.js";

const IV = 60_000;
const CHANNEL = "primary";

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

describe("OhlcBarSeries.priceRangeInWindow", () => {
  let store: DataStore;
  let series: OhlcBarSeries;

  beforeEach(() => {
    store = new DataStore();
    store.defineChannel({ id: CHANNEL, kind: "ohlc" });
    series = new OhlcBarSeries({ channel: CHANNEL });
    series.setQueryContext({ dataStore: store, getInterval: () => IV });
  });

  afterEach(() => {
    series.destroy();
    store.clearAll();
  });

  it("returns {min(low), max(high)} across visible records", () => {
    store.insertMany(CHANNEL, IV, [
      bar(0, 100, 110, 95, 105),
      bar(IV, 105, 120, 100, 115),
      bar(2 * IV, 115, 130, 108, 118),
    ]);
    const r = series.priceRangeInWindow(asTime(0), asTime(2 * IV));
    expect(r).not.toBeNull();
    expect(Number(r?.min)).toBe(95);
    expect(Number(r?.max)).toBe(130);
  });

  it("returns null when window is empty", () => {
    const r = series.priceRangeInWindow(asTime(0), asTime(IV));
    expect(r).toBeNull();
  });

  it("returns null before query context is attached", () => {
    const detached = new OhlcBarSeries({ channel: CHANNEL });
    const r = detached.priceRangeInWindow(asTime(0), asTime(IV));
    expect(r).toBeNull();
    detached.destroy();
  });

  it("skips records with non-finite OHLC fields", () => {
    store.insertMany(CHANNEL, IV, [
      bar(0, 100, 110, 95, 105),
      bar(IV, 105, Number.POSITIVE_INFINITY, 100, 115),
      bar(2 * IV, 115, 125, 108, 118),
    ]);
    const r = series.priceRangeInWindow(asTime(0), asTime(2 * IV));
    expect(r).not.toBeNull();
    expect(Number(r?.min)).toBe(95);
    expect(Number(r?.max)).toBe(125);
  });

  it("returns null when every record in window is non-finite", () => {
    store.insertMany(CHANNEL, IV, [
      bar(0, Number.NaN, 110, 95, 105),
      bar(IV, 105, Number.POSITIVE_INFINITY, 100, 115),
    ]);
    const r = series.priceRangeInWindow(asTime(0), asTime(2 * IV));
    expect(r).toBeNull();
  });

  it("returns null on inverted window", () => {
    store.insertMany(CHANNEL, IV, [bar(0, 100, 110, 95, 105)]);
    const r = series.priceRangeInWindow(asTime(10 * IV), asTime(0));
    expect(r).toBeNull();
  });

  it("returns null when interval is invalid", () => {
    store.insertMany(CHANNEL, IV, [bar(0, 100, 110, 95, 105)]);
    series.setQueryContext({ dataStore: store, getInterval: () => 0 });
    expect(series.priceRangeInWindow(asTime(0), asTime(IV))).toBeNull();
  });

  it("respects strict [start, end] bounds (no ±1 expansion)", () => {
    store.insertMany(CHANNEL, IV, [
      bar(-IV, 50, 60, 40, 55),
      bar(0, 100, 110, 95, 105),
      bar(IV, 105, 120, 100, 115),
      bar(2 * IV, 200, 210, 190, 205),
    ]);
    const r = series.priceRangeInWindow(asTime(0), asTime(IV));
    expect(r).not.toBeNull();
    expect(Number(r?.min)).toBe(95);
    expect(Number(r?.max)).toBe(120);
  });
});

describe("OhlcBarSeries pool lifecycle", () => {
  it("starts with a zero-size pool and zero active bars", () => {
    const series = new OhlcBarSeries({ channel: CHANNEL });
    expect(series.activePoolSize()).toBe(0);
    expect(series.totalPoolSize()).toBe(0);
    series.destroy();
  });

  it("is safe to destroy twice", () => {
    const series = new OhlcBarSeries({ channel: CHANNEL });
    series.destroy();
    expect(() => {
      series.destroy();
    }).not.toThrow();
  });
});
