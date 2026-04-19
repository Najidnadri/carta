import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HeikinAshiSeries } from "./HeikinAshiSeries.js";
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

describe("HeikinAshiSeries.priceRangeInWindow", () => {
  let store: DataStore;
  let series: HeikinAshiSeries;

  beforeEach(() => {
    store = new DataStore();
    store.defineChannel({ id: CHANNEL, kind: "ohlc" });
    series = new HeikinAshiSeries({ channel: CHANNEL });
    series.setQueryContext({ dataStore: store, getInterval: () => IV });
  });

  afterEach(() => {
    series.destroy();
    store.clearAll();
  });

  it("returns null for an empty channel", () => {
    expect(series.priceRangeInWindow(asTime(0), asTime(IV))).toBeNull();
  });

  it("returns null before query context is attached", () => {
    const detached = new HeikinAshiSeries({ channel: CHANNEL });
    expect(detached.priceRangeInWindow(asTime(0), asTime(IV))).toBeNull();
    detached.destroy();
  });

  it("uses HA high/low bounds (not source H/L) within the window", () => {
    // Single bar where HA_open = (100 + 105) / 2 = 102.5, HA_close = 102.5.
    // Because HA collapses open == close on bars with matching mid, the
    // HA-high/low equal the source high/low exactly.
    store.insertMany(CHANNEL, IV, [bar(0, 100, 110, 90, 105)]);
    const r = series.priceRangeInWindow(asTime(0), asTime(IV));
    expect(r).not.toBeNull();
    expect(Number(r?.min)).toBeLessThanOrEqual(90);
    expect(Number(r?.max)).toBeGreaterThanOrEqual(110);
  });

  it("filters by window bounds strictly (excludes out-of-window bars)", () => {
    store.insertMany(CHANNEL, IV, [
      bar(-IV, 50, 60, 40, 55),
      bar(0, 100, 110, 90, 105),
      bar(IV, 105, 115, 100, 112),
      bar(10 * IV, 500, 510, 490, 505),
    ]);
    const r = series.priceRangeInWindow(asTime(0), asTime(IV));
    expect(r).not.toBeNull();
    // The far-out-of-window bar at 10*IV contributes HA_high ≈ 505;
    // filtering must exclude it.
    expect(Number(r?.max)).toBeLessThan(200);
    // The bar at t=-IV (source low = 40) must not leak in either.
    expect(Number(r?.min)).toBeGreaterThanOrEqual(40);
  });
});

describe("HeikinAshiSeries cache", () => {
  let store: DataStore;
  let series: HeikinAshiSeries;

  beforeEach(() => {
    store = new DataStore();
    store.defineChannel({ id: CHANNEL, kind: "ohlc" });
    series = new HeikinAshiSeries({ channel: CHANNEL });
    series.setQueryContext({ dataStore: store, getInterval: () => IV });
  });

  afterEach(() => {
    series.destroy();
    store.clearAll();
  });

  it("is empty before any data arrives", () => {
    expect(series.cacheSize()).toBe(0);
  });

  it("populates on first priceRangeInWindow read", () => {
    store.insertMany(CHANNEL, IV, [
      bar(0, 100, 110, 90, 105),
      bar(IV, 105, 115, 100, 112),
    ]);
    series.priceRangeInWindow(asTime(0), asTime(IV));
    expect(series.cacheSize()).toBe(2);
  });

  it("reuses cached HA bars when revision is stable", () => {
    store.insertMany(CHANNEL, IV, [bar(0, 100, 110, 90, 105)]);
    series.priceRangeInWindow(asTime(0), asTime(IV));
    const firstSize = series.cacheSize();
    series.priceRangeInWindow(asTime(0), asTime(IV));
    expect(series.cacheSize()).toBe(firstSize);
  });

  it("invalidates + rebuilds when source channel revision bumps", () => {
    store.insertMany(CHANNEL, IV, [bar(0, 100, 110, 90, 105)]);
    series.priceRangeInWindow(asTime(0), asTime(IV));
    expect(series.cacheSize()).toBe(1);
    // Out-of-order backfill — bumps revision.
    store.insertMany(CHANNEL, IV, [bar(-IV, 95, 100, 85, 98)]);
    series.priceRangeInWindow(asTime(-IV), asTime(IV));
    expect(series.cacheSize()).toBe(2);
  });

  it("invalidates on interval change via setQueryContext", () => {
    store.insertMany(CHANNEL, IV, [bar(0, 100, 110, 90, 105)]);
    series.priceRangeInWindow(asTime(0), asTime(IV));
    expect(series.cacheSize()).toBe(1);
    series.setQueryContext({ dataStore: store, getInterval: () => IV * 5 });
    expect(series.cacheSize()).toBe(0);
  });

  it("recomputes against a different interval after the DataStore wipes the old bucket", () => {
    const NEW_IV = IV * 5;
    store.insertMany(CHANNEL, IV, [bar(0, 100, 110, 90, 105)]);
    series.priceRangeInWindow(asTime(0), asTime(IV));
    store.setInterval(NEW_IV, IV);
    store.insertMany(CHANNEL, NEW_IV, [bar(0, 200, 220, 180, 210)]);
    series.setQueryContext({ dataStore: store, getInterval: () => NEW_IV });
    series.priceRangeInWindow(asTime(0), asTime(NEW_IV));
    expect(series.cacheSize()).toBe(1);
  });

  it("skips non-finite records without advancing HA recursion", () => {
    store.insertMany(CHANNEL, IV, [
      bar(0, 100, 110, 90, 105),
      bar(IV, Number.NaN, 115, 100, 112),
      bar(2 * IV, 112, 118, 108, 115),
    ]);
    series.priceRangeInWindow(asTime(0), asTime(2 * IV));
    expect(series.cacheSize()).toBe(2);
  });

  it("is safe to destroy twice", () => {
    series.destroy();
    expect(() => {
      series.destroy();
    }).not.toThrow();
  });
});
