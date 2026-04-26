import { describe, expect, it } from "vitest";
import { TimeScale } from "../time/TimeScale.js";
import { PriceScale } from "../price/PriceScale.js";
import { asInterval, asPrice, asTime } from "../../types.js";
import { projectDrawing, type ProjectionContext } from "./project.js";
import { hitTestDrawings, defaultTolerancesFor } from "./hitTest.js";
import {
  asDrawingId,
  DEFAULT_FIB_TIME_ZONE_OFFSETS,
  MAIN_PANE_ID,
  type DrawingAnchor,
  type FibTimeZonesDrawing,
} from "./types.js";
import { parseDrawing } from "./parsers.js";
import { normalizeDrawingDefaults } from "./normalize.js";

const anchor = (time: number, price: number): DrawingAnchor =>
  Object.freeze({ time: asTime(time), price: asPrice(price), paneId: MAIN_PANE_ID });

function ctx(intervalMs = 60_000): ProjectionContext {
  return Object.freeze({
    timeScale: new TimeScale({
      startTime: asTime(0),
      endTime: asTime(intervalMs > 0 ? intervalMs * 100 : 1),
      intervalDuration: asInterval(intervalMs > 0 ? intervalMs : 60_000),
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

const sample = (offsets = DEFAULT_FIB_TIME_ZONE_OFFSETS): FibTimeZonesDrawing =>
  Object.freeze({
    id: asDrawingId("ftz1"),
    kind: "fibTimeZones" as const,
    anchors: Object.freeze([anchor(0, 100)] as const),
    offsets,
    style: Object.freeze({ stroke: { color: 0x00ff00 } }),
    locked: false,
    visible: true,
    z: 0,
    schemaVersion: 1 as const,
  });

describe("fibTimeZones projection", () => {
  it("default offset count = 10 (Fibonacci sequence starting at 1)", () => {
    expect(DEFAULT_FIB_TIME_ZONE_OFFSETS.length).toBe(10);
    expect(DEFAULT_FIB_TIME_ZONE_OFFSETS[0]).toBe(1);
    expect(DEFAULT_FIB_TIME_ZONE_OFFSETS).not.toContain(0);
  });

  it("zone n projects to time = origin.time + n * intervalMs", () => {
    const geom = projectDrawing(sample(), ctx(60_000));
    if (geom.kind !== "fibTimeZones") {
      throw new Error("unreachable");
    }
    const zone1 = geom.zones.find((z) => z.offset === 1);
    const zone3 = geom.zones.find((z) => z.offset === 3);
    expect(zone1?.time).toBe(60_000);
    expect(zone3?.time).toBe(180_000);
  });

  it("interval hot-swap re-projects zones to the new bar grid", () => {
    const geom1m = projectDrawing(sample(), ctx(60_000));
    const geom5m = projectDrawing(sample(), ctx(300_000));
    if (geom1m.kind !== "fibTimeZones" || geom5m.kind !== "fibTimeZones") {
      throw new Error("unreachable");
    }
    const z1at1m = geom1m.zones.find((z) => z.offset === 1);
    const z1at5m = geom5m.zones.find((z) => z.offset === 1);
    expect(z1at1m?.time).toBe(60_000);
    expect(z1at5m?.time).toBe(300_000);
  });

  it("intervalMs == 0 sets intervalMissing=true and emits no zones", () => {
    const c = ctx(60_000);
    // Force-zero intervalDuration by replacing the TimeScale's `intervalDuration`
    // property (TimeScale class methods stay attached via the prototype chain).
    const ts = Object.create(
      Object.getPrototypeOf(c.timeScale) as object,
      Object.getOwnPropertyDescriptors(c.timeScale),
    ) as ProjectionContext["timeScale"];
    Object.defineProperty(ts, "intervalDuration", { value: 0, writable: false });
    const ctxBad: ProjectionContext = Object.freeze({
      timeScale: ts,
      priceScale: c.priceScale,
      plotRect: c.plotRect,
    });
    const geom = projectDrawing(sample(), ctxBad);
    if (geom.kind !== "fibTimeZones") {
      throw new Error("unreachable");
    }
    expect(geom.intervalMissing).toBe(true);
    expect(geom.zones.length).toBe(0);
  });

  it("non-integer / non-positive offsets are filtered at parse time", () => {
    const json = {
      id: "x",
      kind: "fibTimeZones",
      anchors: [{ time: 0, price: 100, paneId: "main" }],
      offsets: [1, 2.5, 0, -3, 5, 8],
      style: {},
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
    };
    const parsed = parseDrawing(json);
    expect(parsed).not.toBeNull();
    if (parsed!.kind !== "fibTimeZones") {
      throw new Error("unreachable");
    }
    expect([...parsed.offsets].sort((a, b) => a - b)).toEqual([1, 5, 8]);
  });

  it("hit-test on a zone returns 'line'", () => {
    const c = ctx();
    const geom = projectDrawing(sample(), c);
    if (geom.kind !== "fibTimeZones") {
      throw new Error("unreachable");
    }
    const tols = defaultTolerancesFor("mouse", 1);
    const z1 = geom.zones[0]!;
    const hit = hitTestDrawings(z1.snappedX, 100, [{ drawing: sample(), geom }], null, tols);
    expect(hit).not.toBeNull();
    expect(hit!.part).toBe("line");
  });

  it("normalize fills DEFAULT_FIB_TIME_ZONE_OFFSETS when offsets missing", () => {
    const partial = {
      ...sample(),
      offsets: undefined,
    } as unknown as FibTimeZonesDrawing;
    const result = normalizeDrawingDefaults(partial, 60_000);
    expect(result.drawing).not.toBeNull();
    if (result.drawing!.kind === "fibTimeZones") {
      expect(result.drawing.offsets.length).toBe(DEFAULT_FIB_TIME_ZONE_OFFSETS.length);
    }
  });
});
