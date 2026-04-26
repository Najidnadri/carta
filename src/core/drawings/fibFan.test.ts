import { describe, expect, it } from "vitest";
import { TimeScale } from "../time/TimeScale.js";
import { PriceScale } from "../price/PriceScale.js";
import { asInterval, asPrice, asTime } from "../../types.js";
import { projectDrawing, type ProjectionContext } from "./project.js";
import { hitTestDrawings, defaultTolerancesFor } from "./hitTest.js";
import {
  asDrawingId,
  DEFAULT_FIB_FAN_LEVELS,
  MAIN_PANE_ID,
  type DrawingAnchor,
  type FibFanDrawing,
} from "./types.js";

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

const sample = (
  a: DrawingAnchor = anchor(0, 100),
  b: DrawingAnchor = anchor(60_000, 130),
  levels = DEFAULT_FIB_FAN_LEVELS,
): FibFanDrawing =>
  Object.freeze({
    id: asDrawingId("ffan1"),
    kind: "fibFan" as const,
    anchors: Object.freeze([a, b] as const),
    levels,
    style: Object.freeze({ stroke: { color: 0xff00ff } }),
    locked: false,
    visible: true,
    z: 0,
    schemaVersion: 1 as const,
  });

describe("fibFan projection", () => {
  it("emits 5 rays at default levels", () => {
    const geom = projectDrawing(sample(), ctx());
    if (geom.kind !== "fibFan") {
      throw new Error("unreachable");
    }
    expect(geom.rays.length).toBe(DEFAULT_FIB_FAN_LEVELS.length);
  });

  it("level 1.0 ray passes through B in price-time space", () => {
    const c = ctx();
    const geom = projectDrawing(sample(), c);
    if (geom.kind !== "fibFan") {
      throw new Error("unreachable");
    }
    const r1 = geom.rays.find((r) => r.level === 1);
    expect(r1).toBeDefined();
    // Ray starts at A (anchors[0]) and passes through B (anchors[1]) screen-projected.
    const a = geom.anchors[0];
    const b = geom.anchors[1];
    // Visible[0] at A; the line direction (visible[1] − a) must be parallel to (b − a).
    const dxRay = r1!.visible[1].x - a.x;
    const dyRay = r1!.visible[1].y - a.y;
    const dxAB = b.x - a.x;
    const dyAB = b.y - a.y;
    // Cross product zero ⇒ parallel.
    const cross = dxRay * dyAB - dyRay * dxAB;
    expect(Math.abs(cross)).toBeLessThan(1e-3);
  });

  it("degenerate vector (B.time == A.time) → empty rays, no throw", () => {
    const bad = sample(anchor(0, 100), anchor(0, 130));
    const geom = projectDrawing(bad, ctx());
    if (geom.kind !== "fibFan") {
      throw new Error("unreachable");
    }
    expect(geom.rays.length).toBe(0);
  });

  it("degenerate vector (ΔP < 1e-12) → empty rays, no throw", () => {
    const flat = sample(anchor(0, 100), anchor(60_000, 100));
    const geom = projectDrawing(flat, ctx());
    if (geom.kind !== "fibFan") {
      throw new Error("unreachable");
    }
    expect(geom.rays.length).toBe(0);
  });

  it("hit-test on a ray body returns 'line'", () => {
    const c = ctx();
    const geom = projectDrawing(sample(), c);
    if (geom.kind !== "fibFan") {
      throw new Error("unreachable");
    }
    const r1 = geom.rays.find((r) => r.level === 1)!;
    const tols = defaultTolerancesFor("mouse", 1);
    // Midpoint of the visible level-1 ray segment.
    const px = (r1.visible[0].x + r1.visible[1].x) / 2;
    const py = (r1.visible[0].y + r1.visible[1].y) / 2;
    const hit = hitTestDrawings(px, py, [{ drawing: sample(), geom }], null, tols);
    expect(hit).not.toBeNull();
    expect(hit!.part).toBe("line");
  });
});
