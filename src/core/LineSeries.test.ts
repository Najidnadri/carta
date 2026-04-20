import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LineSeries } from "./LineSeries.js";
import { DataStore } from "./DataStore.js";
import { asPrice, asTime, DEFAULT_THEME, type PointRecord } from "../types.js";
import type { SeriesRenderContext } from "./Series.js";

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

// ─── Render variant coverage ─────────────────────────────────────────────
// Build a minimal mock `SeriesRenderContext` around a stubbed Graphics that
// records every moveTo / lineTo / stroke / clear so we can assert on the
// submitted geometry without spinning up a real Pixi renderer.

interface Call { type: "moveTo" | "lineTo" | "stroke" | "clear"; x?: number; y?: number }

function buildRenderCtx(
  store: DataStore,
  opts?: { startTime?: number; endTime?: number },
): SeriesRenderContext {
  const start = opts?.startTime ?? 0;
  const end = opts?.endTime ?? 10 * IV;
  const timeScale = {
    timeToPixel: (t: number): number => t - start,
    barSpacingPx: 1,
    visibleBarSlots: (): readonly number[] => [],
  } as unknown as SeriesRenderContext["timeScale"];
  const priceScale = {
    valueToPixel: (v: number): number => 100 - v,
  } as unknown as SeriesRenderContext["priceScale"];
  return {
    startTime: asTime(start),
    endTime: asTime(end),
    intervalDuration: IV,
    plotWidth: end - start,
    plotHeight: 200,
    timeScale,
    priceScale,
    dataStore: store,
    theme: DEFAULT_THEME,
  } as unknown as SeriesRenderContext;
}

describe("LineSeries.render variants", () => {
  let store: DataStore;

  beforeEach(() => {
    store = new DataStore();
    store.defineChannel({ id: CHANNEL, kind: "point" });
  });

  afterEach(() => {
    store.clearAll();
  });

  function spy(series: LineSeries): Call[] {
    const calls: Call[] = [];
    // Access the private graphics via a test-only cast — matches the candleGlyph
    // test approach.
    const g = (series as unknown as { graphics: {
      moveTo: (x: number, y: number) => unknown;
      lineTo: (x: number, y: number) => unknown;
      stroke: (style: unknown) => unknown;
      clear: () => unknown;
    } }).graphics;
    vi.spyOn(g, "moveTo").mockImplementation((x: number, y: number) => { calls.push({ type: "moveTo", x, y }); return g; });
    vi.spyOn(g, "lineTo").mockImplementation((x: number, y: number) => { calls.push({ type: "lineTo", x, y }); return g; });
    vi.spyOn(g, "stroke").mockImplementation(() => { calls.push({ type: "stroke" }); return g; });
    vi.spyOn(g, "clear").mockImplementation(() => { calls.push({ type: "clear" }); return g; });
    return calls;
  }

  it("solid simple: one moveTo + N lineTo + one stroke for a short run", () => {
    const series = new LineSeries({ channel: CHANNEL });
    series.setQueryContext({ dataStore: store, getInterval: () => IV });
    store.insertMany(CHANNEL, IV, [pt(0, 10), pt(IV, 20), pt(2 * IV, 15)]);
    const calls = spy(series);
    series.render(buildRenderCtx(store));
    const moveTos = calls.filter((c) => c.type === "moveTo");
    const lineTos = calls.filter((c) => c.type === "lineTo");
    const strokes = calls.filter((c) => c.type === "stroke");
    expect(moveTos).toHaveLength(1);
    expect(lineTos).toHaveLength(2);
    expect(strokes).toHaveLength(1);
    series.destroy();
  });

  it("stepped: emits 2 lineTo per input segment (horizontal then vertical)", () => {
    const series = new LineSeries({ channel: CHANNEL, lineType: "stepped" });
    series.setQueryContext({ dataStore: store, getInterval: () => IV });
    store.insertMany(CHANNEL, IV, [pt(0, 10), pt(IV, 20), pt(2 * IV, 15)]);
    const calls = spy(series);
    series.render(buildRenderCtx(store));
    const lineTos = calls.filter((c) => c.type === "lineTo");
    // 2 input segments × 2 lineTos each = 4.
    expect(lineTos).toHaveLength(4);
    // First step: horizontal @ prev.y (=90), vertical to curr.y (=80).
    expect(lineTos[0]).toMatchObject({ type: "lineTo", x: IV, y: 90 });
    expect(lineTos[1]).toMatchObject({ type: "lineTo", x: IV, y: 80 });
    series.destroy();
  });

  it("dashed: emits multiple moveTo/lineTo pairs along a visible segment", () => {
    const series = new LineSeries({ channel: CHANNEL, lineStyle: "dashed" });
    series.setQueryContext({ dataStore: store, getInterval: () => IV });
    // buildRenderCtx maps timeToPixel(t) = t - start. Two points 60000 px apart.
    store.insertMany(CHANNEL, IV, [pt(0, 10), pt(IV, 10)]);
    const calls = spy(series);
    series.render(buildRenderCtx(store, { startTime: 0, endTime: IV }));
    const moveTos = calls.filter((c) => c.type === "moveTo");
    const lineTos = calls.filter((c) => c.type === "lineTo");
    const strokes = calls.filter((c) => c.type === "stroke");
    // Path length = 60000 px. At dashed 6/3 cycle (9 px), expect ~60000/9 dashes = ~6666.
    expect(moveTos.length).toBeGreaterThan(100);
    expect(lineTos.length).toBe(moveTos.length);
    // Multiple chunked strokes (chunk size 64 → ~100+ stroke calls).
    expect(strokes.length).toBeGreaterThan(1);
    series.destroy();
  });

  it("dotted: emits dot pairs along a short segment", () => {
    const series = new LineSeries({ channel: CHANNEL, lineStyle: "dotted" });
    series.setQueryContext({ dataStore: store, getInterval: () => IV });
    // Short horizontal span: two points 4 px apart. 1 on / 3 off cycle = 4; expect 1 dot pair.
    const timeScaleOverride = {
      timeToPixel: (t: number): number => (t / IV) * 4,
      barSpacingPx: 1,
      visibleBarSlots: (): readonly number[] => [],
    };
    const priceScale = {
      valueToPixel: (v: number): number => 100 - v,
    };
    const ctx = {
      startTime: asTime(0),
      endTime: asTime(IV),
      intervalDuration: IV,
      plotWidth: 4,
      plotHeight: 200,
      timeScale: timeScaleOverride as unknown,
      priceScale: priceScale as unknown,
      dataStore: store,
      theme: DEFAULT_THEME,
    } as unknown as SeriesRenderContext;
    store.insertMany(CHANNEL, IV, [pt(0, 10), pt(IV, 10)]);
    const calls = spy(series);
    series.render(ctx);
    const moveTos = calls.filter((c) => c.type === "moveTo");
    expect(moveTos).toHaveLength(1);
    series.destroy();
  });

  it("lineWidth <= 0: renders nothing (early-return)", () => {
    const series = new LineSeries({ channel: CHANNEL, lineWidth: 0 });
    series.setQueryContext({ dataStore: store, getInterval: () => IV });
    store.insertMany(CHANNEL, IV, [pt(0, 10), pt(IV, 20)]);
    const calls = spy(series);
    series.render(buildRenderCtx(store));
    expect(calls.filter((c) => c.type === "stroke")).toHaveLength(0);
    expect(calls.filter((c) => c.type === "lineTo")).toHaveLength(0);
    series.destroy();
  });

  it("single point: emits nothing (no segments)", () => {
    const series = new LineSeries({ channel: CHANNEL });
    series.setQueryContext({ dataStore: store, getInterval: () => IV });
    store.insertMany(CHANNEL, IV, [pt(0, 10)]);
    const calls = spy(series);
    series.render(buildRenderCtx(store));
    expect(calls.filter((c) => c.type === "stroke")).toHaveLength(0);
    series.destroy();
  });

  it("stepped + dashed combine (dashes along both horizontal and vertical legs)", () => {
    const series = new LineSeries({
      channel: CHANNEL,
      lineType: "stepped",
      lineStyle: "dashed",
    });
    series.setQueryContext({ dataStore: store, getInterval: () => IV });
    store.insertMany(CHANNEL, IV, [pt(0, 10), pt(IV, 20)]);
    const calls = spy(series);
    series.render(buildRenderCtx(store));
    // Two sub-segments feed into the dashed emitter; we should see many dashes.
    const moveTos = calls.filter((c) => c.type === "moveTo");
    const strokes = calls.filter((c) => c.type === "stroke");
    expect(moveTos.length).toBeGreaterThan(1);
    expect(strokes.length).toBeGreaterThan(0);
    series.destroy();
  });
});
