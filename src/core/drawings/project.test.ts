import { describe, expect, it } from "vitest";
import { extendSegment, projectDrawing } from "./project.js";
import { TimeScale } from "../time/TimeScale.js";
import { PriceScale } from "../price/PriceScale.js";
import { asInterval, asPrice, asTime } from "../../types.js";
import type { Drawing } from "./types.js";

const PLOT = { x: 0, y: 0, w: 1000, h: 500 };

function makeScales(): { timeScale: TimeScale; priceScale: PriceScale } {
  return {
    timeScale: new TimeScale({
      startTime: asTime(0),
      endTime: asTime(1000),
      intervalDuration: asInterval(10),
      pixelWidth: 1000,
    }),
    priceScale: new PriceScale({
      domainMin: asPrice(0),
      domainMax: asPrice(100),
      pixelHeight: 500,
      margins: { top: 0, bottom: 0 },
    }),
  };
}

function trendline(t1: number, p1: number, t2: number, p2: number): Drawing {
  return {
    id: "t" as Drawing["id"],
    kind: "trendline",
    style: {},
    locked: false,
    visible: true,
    z: 0,
    schemaVersion: 1,
    anchors: [
      { time: asTime(t1), price: asPrice(p1), paneId: "main" as Drawing["anchors"][0]["paneId"] },
      { time: asTime(t2), price: asPrice(p2), paneId: "main" as Drawing["anchors"][0]["paneId"] },
    ],
  } as Drawing;
}

describe("projectDrawing trendline", () => {
  it("projects to expected screen coords", () => {
    const ctx = { ...makeScales(), plotRect: PLOT };
    const geom = projectDrawing(trendline(0, 100, 1000, 0), ctx);
    if (geom.kind !== "trendline") {
      throw new Error("expected trendline");
    }
    expect(geom.anchors[0].x).toBeCloseTo(0, 4);
    expect(geom.anchors[0].y).toBeCloseTo(0, 4); // price 100 → top
    expect(geom.anchors[1].x).toBeCloseTo(1000, 4);
    expect(geom.anchors[1].y).toBeCloseTo(500, 4);
  });

  it("does not crash on coincident anchors", () => {
    const ctx = { ...makeScales(), plotRect: PLOT };
    const geom = projectDrawing(trendline(500, 50, 500, 50), ctx);
    expect(geom.kind).toBe("trendline");
  });
});

describe("extendSegment", () => {
  it("returns input when extend === 'none'", () => {
    const r = extendSegment({ x: 100, y: 100 }, { x: 200, y: 200 }, "none", PLOT);
    expect(r[0]).toEqual({ x: 100, y: 100 });
    expect(r[1]).toEqual({ x: 200, y: 200 });
  });

  it("extends right to plot edge", () => {
    const r = extendSegment({ x: 100, y: 0 }, { x: 200, y: 0 }, "right", PLOT);
    expect(r[0].x).toBe(100);
    expect(r[1].x).toBe(1000);
  });

  it("extends both directions to plot edges", () => {
    const r = extendSegment({ x: 100, y: 0 }, { x: 200, y: 0 }, "both", PLOT);
    expect(r[0].x).toBe(0);
    expect(r[1].x).toBe(1000);
  });
});

describe("projectDrawing horizontal/vertical", () => {
  const ctx = { ...makeScales(), plotRect: PLOT };

  it("horizontalLine snaps Y to half-pixel", () => {
    const d: Drawing = {
      id: "h" as Drawing["id"],
      kind: "horizontalLine",
      style: {},
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [{ time: asTime(0), price: asPrice(50), paneId: "main" as Drawing["anchors"][0]["paneId"] }],
    } as Drawing;
    const geom = projectDrawing(d, ctx);
    if (geom.kind !== "horizontalLine") {
      throw new Error("expected horizontalLine");
    }
    expect(geom.snappedY % 1).toBeCloseTo(0.5, 6);
    expect(geom.x1).toBe(0);
    expect(geom.x2).toBe(1000);
  });

  it("verticalLine snaps X to half-pixel", () => {
    const d: Drawing = {
      id: "v" as Drawing["id"],
      kind: "verticalLine",
      style: {},
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [{ time: asTime(500), price: asPrice(0), paneId: "main" as Drawing["anchors"][0]["paneId"] }],
    } as Drawing;
    const geom = projectDrawing(d, ctx);
    if (geom.kind !== "verticalLine") {
      throw new Error("expected verticalLine");
    }
    expect(geom.snappedX % 1).toBeCloseTo(0.5, 6);
  });
});

describe("projectDrawing fibRetracement", () => {
  it("emits one geom level per input level with monotonically increasing y on a falling segment", () => {
    const d: Drawing = {
      id: "f" as Drawing["id"],
      kind: "fibRetracement",
      style: {},
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [
        { time: asTime(0), price: asPrice(100), paneId: "main" as Drawing["anchors"][0]["paneId"] },
        { time: asTime(500), price: asPrice(0), paneId: "main" as Drawing["anchors"][0]["paneId"] },
      ],
      levels: [{ value: 0 }, { value: 0.5 }, { value: 1 }],
      showPrices: true,
      showPercents: true,
    } as Drawing;
    const ctx = { ...makeScales(), plotRect: PLOT };
    const geom = projectDrawing(d, ctx);
    if (geom.kind !== "fibRetracement") {
      throw new Error("expected fibRetracement");
    }
    expect(geom.levels.length).toBe(3);
    // anchor[0] is at price 100 → y=0; anchor[1] at price 0 → y=500.
    // level 0 (value=0) → price 100 → y=0; level 1 (value=1) → price 0 → y=500.
    const ys = geom.levels.map((l) => l.y);
    expect(ys[0]).toBeCloseTo(0, 4);
    expect(ys[2]).toBeCloseTo(500, 4);
  });

  it("zero-height fib does not crash and yields levels at a single y", () => {
    const d: Drawing = {
      id: "f" as Drawing["id"],
      kind: "fibRetracement",
      style: {},
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [
        { time: asTime(0), price: asPrice(50), paneId: "main" as Drawing["anchors"][0]["paneId"] },
        { time: asTime(500), price: asPrice(50), paneId: "main" as Drawing["anchors"][0]["paneId"] },
      ],
      levels: [{ value: 0 }, { value: 0.618 }, { value: 1 }],
      showPrices: true,
      showPercents: true,
    } as Drawing;
    const ctx = { ...makeScales(), plotRect: PLOT };
    const geom = projectDrawing(d, ctx);
    expect(geom.kind).toBe("fibRetracement");
  });
});
