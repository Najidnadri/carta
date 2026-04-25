import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HistogramSeries, __internals__ } from "./HistogramSeries.js";
import { DataStore } from "./DataStore.js";
import {
  asPrice,
  asTime,
  type PointRecord,
  type Theme,
} from "../types.js";
import { DarkTheme } from "./themes.js";

const IV = 60_000;
const CHANNEL = "volume";

function pt(t: number, v: number, color?: number): PointRecord {
  return color === undefined
    ? { time: asTime(t), value: asPrice(v) }
    : { time: asTime(t), value: asPrice(v), color };
}

describe("HistogramSeries.priceRangeInWindow", () => {
  let store: DataStore;
  let series: HistogramSeries;

  beforeEach(() => {
    store = new DataStore();
    store.defineChannel({ id: CHANNEL, kind: "point" });
    series = new HistogramSeries({ channel: CHANNEL });
    series.setQueryContext({ dataStore: store, getInterval: () => IV });
  });

  afterEach(() => {
    series.destroy();
    store.clearAll();
  });

  it("includes the base in the reported range", () => {
    store.insertMany(CHANNEL, IV, [pt(0, 100), pt(IV, 150), pt(2 * IV, 120)]);
    const r = series.priceRangeInWindow(asTime(0), asTime(2 * IV));
    expect(r).not.toBeNull();
    expect(Number(r?.min)).toBe(0);
    expect(Number(r?.max)).toBe(150);
  });

  it("handles negative values below base=0", () => {
    store.insertMany(CHANNEL, IV, [pt(0, -10), pt(IV, 20), pt(2 * IV, -5)]);
    const r = series.priceRangeInWindow(asTime(0), asTime(2 * IV));
    expect(r).not.toBeNull();
    expect(Number(r?.min)).toBe(-10);
    expect(Number(r?.max)).toBe(20);
  });

  it("respects a custom base", () => {
    store.insertMany(CHANNEL, IV, [pt(0, 100), pt(IV, 120)]);
    const custom = new HistogramSeries({ channel: CHANNEL, base: 50 });
    custom.setQueryContext({ dataStore: store, getInterval: () => IV });
    const r = custom.priceRangeInWindow(asTime(0), asTime(IV));
    expect(r).not.toBeNull();
    expect(Number(r?.min)).toBe(50);
    expect(Number(r?.max)).toBe(120);
    custom.destroy();
  });

  it("returns null when every value is non-finite", () => {
    store.insertMany(CHANNEL, IV, [
      pt(0, Number.NaN),
      pt(IV, Number.POSITIVE_INFINITY),
    ]);
    const r = series.priceRangeInWindow(asTime(0), asTime(IV));
    expect(r).toBeNull();
  });

  it("returns null on empty window", () => {
    expect(series.priceRangeInWindow(asTime(0), asTime(IV))).toBeNull();
  });

  it("returns null before query context is attached", () => {
    const detached = new HistogramSeries({ channel: CHANNEL });
    expect(detached.priceRangeInWindow(asTime(0), asTime(IV))).toBeNull();
    detached.destroy();
  });

  it("returns null on inverted window", () => {
    store.insertMany(CHANNEL, IV, [pt(0, 100)]);
    expect(series.priceRangeInWindow(asTime(10 * IV), asTime(0))).toBeNull();
  });

  it("returns null when participatesInAutoScale is false", () => {
    store.insertMany(CHANNEL, IV, [pt(0, 100), pt(IV, 110)]);
    const overlay = new HistogramSeries({ channel: CHANNEL, participatesInAutoScale: false });
    overlay.setQueryContext({ dataStore: store, getInterval: () => IV });
    expect(overlay.priceRangeInWindow(asTime(0), asTime(IV))).toBeNull();
    overlay.destroy();
  });
});

describe("HistogramSeries.resolveBarColor", () => {
  const theme: Theme = DarkTheme;

  it("prefers record.color when finite and non-negative", () => {
    const color = __internals__.resolveBarColor(
      pt(0, 100, 0x26a69a),
      0xef5350,
      theme,
    );
    expect(color).toBe(0x26a69a);
  });

  it("falls back to series default when record.color is missing", () => {
    const color = __internals__.resolveBarColor(pt(0, 100), 0xef5350, theme);
    expect(color).toBe(0xef5350);
  });

  it("falls back to theme when record.color is NaN", () => {
    const color = __internals__.resolveBarColor(
      pt(0, 100, Number.NaN),
      0xef5350,
      theme,
    );
    expect(color).toBe(0xef5350);
  });

  it("falls back to theme when series default is also invalid", () => {
    const color = __internals__.resolveBarColor(
      pt(0, 100, Number.NaN),
      Number.NEGATIVE_INFINITY,
      theme,
    );
    expect(color).toBe(theme.line);
  });

  it("accepts 0 (black) as a valid record color", () => {
    expect(__internals__.resolveBarColor(pt(0, 100, 0), 0xef5350, theme)).toBe(0);
  });
});
