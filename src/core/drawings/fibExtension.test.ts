import { describe, expect, it } from "vitest";
import { TimeScale } from "../time/TimeScale.js";
import { PriceScale } from "../price/PriceScale.js";
import { asInterval, asPrice, asTime } from "../../types.js";
import { projectDrawing, type ProjectionContext } from "./project.js";
import { hitTestDrawings, defaultTolerancesFor } from "./hitTest.js";
import {
  asDrawingId,
  DEFAULT_FIB_EXTENSION_LEVELS,
  MAIN_PANE_ID,
  type DrawingAnchor,
  type FibExtensionDrawing,
} from "./types.js";
import { parseDrawing } from "./parsers.js";
import { normalizeDrawingDefaults } from "./normalize.js";

const anchor = (time: number, price: number): DrawingAnchor =>
  Object.freeze({ time: asTime(time), price: asPrice(price), paneId: MAIN_PANE_ID });

function ctx(): ProjectionContext {
  return Object.freeze({
    timeScale: new TimeScale({
      startTime: asTime(0),
      endTime: asTime(120_000),
      intervalDuration: asInterval(60_000),
      pixelWidth: 600,
    }),
    priceScale: new PriceScale({
      domainMin: asPrice(0),
      domainMax: asPrice(200),
      pixelHeight: 400,
      margins: { top: 0, bottom: 0 },
    }),
    plotRect: { x: 0, y: 0, w: 600, h: 400 },
  });
}

const sample = (levels = DEFAULT_FIB_EXTENSION_LEVELS): FibExtensionDrawing =>
  Object.freeze({
    id: asDrawingId("fe1"),
    kind: "fibExtension" as const,
    anchors: Object.freeze([anchor(0, 100), anchor(60_000, 120), anchor(30_000, 110)] as const),
    levels,
    showPrices: true,
    showPercents: true,
    style: Object.freeze({ stroke: { color: 0xff0000 } }),
    locked: false,
    visible: true,
    z: 0,
    schemaVersion: 1 as const,
  });

describe("fibExtension projection", () => {
  it("level 0 lands on C.price; level 1 lands on C.price + (B.price - A.price)", () => {
    const geom = projectDrawing(sample(), ctx());
    if (geom.kind !== "fibExtension") {
      throw new Error("unreachable");
    }
    const level0 = geom.levels.find((l) => l.value === 0);
    const level1 = geom.levels.find((l) => l.value === 1);
    expect(level0).toBeDefined();
    expect(level1).toBeDefined();
    // C.price = 110; level0 = 110, level1 = 110 + (120 - 100) = 130.
    expect(level0!.price).toBeCloseTo(110, 6);
    expect(level1!.price).toBeCloseTo(130, 6);
  });

  it("default level set has 7 entries", () => {
    expect(DEFAULT_FIB_EXTENSION_LEVELS.length).toBe(7);
  });

  it("xMin / xMax span the 3 anchor screen times", () => {
    const geom = projectDrawing(sample(), ctx());
    if (geom.kind !== "fibExtension") {
      throw new Error("unreachable");
    }
    expect(geom.xMin).toBeLessThan(geom.xMax);
  });

  it("hit-test on a level line returns 'line'", () => {
    const c = ctx();
    const geom = projectDrawing(sample(), c);
    if (geom.kind !== "fibExtension") {
      throw new Error("unreachable");
    }
    const level1 = geom.levels.find((l) => l.value === 1);
    const tols = defaultTolerancesFor("mouse", 1);
    // Click in middle of level-1 line.
    const px = (geom.xMin + geom.xMax) / 2;
    const py = level1!.snappedY;
    const hit = hitTestDrawings(px, py, [{ drawing: sample(), geom }], null, tols);
    expect(hit).not.toBeNull();
    expect(hit!.part).toBe("line");
  });

  it("snapshot round-trip via parseDrawing", () => {
    const json = JSON.parse(JSON.stringify(sample())) as unknown;
    const parsed = parseDrawing(json);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("fibExtension");
  });

  it("normalize fills DEFAULT_FIB_EXTENSION_LEVELS when levels missing", () => {
    const partial = {
      ...sample(),
      levels: undefined,
    } as unknown as FibExtensionDrawing;
    const result = normalizeDrawingDefaults(partial, 60_000);
    expect(result.drawing).not.toBeNull();
    expect(result.drawing!.kind).toBe("fibExtension");
    if (result.drawing!.kind === "fibExtension") {
      expect(result.drawing.levels.length).toBe(DEFAULT_FIB_EXTENSION_LEVELS.length);
    }
  });

  it("normalize drops drawings with NaN anchor at the boundary", () => {
    const bad = {
      ...sample(),
      anchors: Object.freeze([anchor(0, NaN), anchor(60_000, 120), anchor(30_000, 110)] as const),
    };
    const result = normalizeDrawingDefaults(bad as FibExtensionDrawing, 60_000);
    expect(result.drawing).toBeNull();
    expect(result.warn).toContain("non-finite");
  });
});
