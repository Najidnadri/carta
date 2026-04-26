import { describe, expect, it } from "vitest";
import { TimeScale } from "../time/TimeScale.js";
import { PriceScale } from "../price/PriceScale.js";
import { asInterval, asPrice, asTime } from "../../types.js";
import { projectDrawing, type ProjectionContext } from "./project.js";
import { hitTestDrawings } from "./hitTest.js";
import {
  MAIN_PANE_ID,
  asDrawingId,
  type DrawingAnchor,
  type EllipseDrawing,
} from "./types.js";

const anchor = (time: number, price: number): DrawingAnchor => Object.freeze({
  time: asTime(time),
  price: asPrice(price),
  paneId: MAIN_PANE_ID,
});

function makeEllipse(a: DrawingAnchor, b: DrawingAnchor): EllipseDrawing {
  return Object.freeze({
    id: asDrawingId("e1"),
    kind: "ellipse" as const,
    anchors: Object.freeze([a, b] as const),
    style: Object.freeze({ stroke: { color: 0x4488ff } }),
    locked: false,
    visible: true,
    z: 0,
    schemaVersion: 1 as const,
  });
}

function ctx(): ProjectionContext {
  const ts = new TimeScale({
    startTime: asTime(0),
    endTime: asTime(120_000),
    intervalDuration: asInterval(60_000),
    pixelWidth: 600,
  });
  const ps = new PriceScale({
    domainMin: asPrice(0),
    domainMax: asPrice(200),
    pixelHeight: 400,
    margins: { top: 0, bottom: 0 },
  });
  return Object.freeze({
    timeScale: ts,
    priceScale: ps,
    plotRect: { x: 0, y: 0, w: 600, h: 400 },
  });
}

describe("ellipse projection", () => {
  it("normalizes corners regardless of anchor order", () => {
    const e1 = makeEllipse(anchor(0, 100), anchor(60_000, 50));
    const e2 = makeEllipse(anchor(60_000, 50), anchor(0, 100));
    const g1 = projectDrawing(e1, ctx());
    const g2 = projectDrawing(e2, ctx());
    if (g1.kind !== "ellipse" || g2.kind !== "ellipse") {
      throw new Error("unreachable");
    }
    expect(g1.cx).toBeCloseTo(g2.cx, 1);
    expect(g1.cy).toBeCloseTo(g2.cy, 1);
    expect(g1.rx).toBeCloseTo(g2.rx, 1);
    expect(g1.ry).toBeCloseTo(g2.ry, 1);
  });

  it("rx and ry are non-negative half-spans", () => {
    const e = makeEllipse(anchor(0, 100), anchor(60_000, 50));
    const geom = projectDrawing(e, ctx());
    if (geom.kind !== "ellipse") {
      throw new Error("unreachable");
    }
    expect(geom.rx).toBeGreaterThanOrEqual(0);
    expect(geom.ry).toBeGreaterThanOrEqual(0);
  });

  it("degenerate (anchors coincident) → rx == 0 && ry == 0", () => {
    const e = makeEllipse(anchor(0, 100), anchor(0, 100));
    const geom = projectDrawing(e, ctx());
    if (geom.kind !== "ellipse") {
      throw new Error("unreachable");
    }
    expect(geom.rx).toBe(0);
    expect(geom.ry).toBe(0);
  });
});

describe("ellipse hit-test", () => {
  it("body hit at centre selects the drawing", () => {
    const e = makeEllipse(anchor(0, 100), anchor(60_000, 50));
    const c = ctx();
    const projected = [{ drawing: e, geom: projectDrawing(e, c) }];
    const geom = projected[0]!.geom;
    if (geom.kind !== "ellipse") {
      throw new Error("unreachable");
    }
    const hit = hitTestDrawings(geom.cx, geom.cy, projected, null, { handle: 10, body: 8 });
    expect(hit?.drawing.id).toBe("e1");
    expect(hit?.part).toBe("body");
  });

  it("border hit just inside the bbox right edge selects with part='border'", () => {
    const e = makeEllipse(anchor(0, 100), anchor(60_000, 50));
    const c = ctx();
    const projected = [{ drawing: e, geom: projectDrawing(e, c) }];
    const geom = projected[0]!.geom;
    if (geom.kind !== "ellipse") {
      throw new Error("unreachable");
    }
    // Right-vertex of the ellipse: (cx + rx, cy).
    const hit = hitTestDrawings(geom.cx + geom.rx, geom.cy, projected, null, {
      handle: 10,
      body: 8,
    });
    expect(hit?.drawing.id).toBe("e1");
    expect(hit?.part).toBe("border");
  });

  it("misses outside bbox", () => {
    const e = makeEllipse(anchor(0, 100), anchor(60_000, 50));
    const c = ctx();
    const projected = [{ drawing: e, geom: projectDrawing(e, c) }];
    const hit = hitTestDrawings(-500, -500, projected, null, { handle: 10, body: 8 });
    expect(hit).toBeNull();
  });

  it("handle hit on each of 2 anchors when selected", () => {
    const e = makeEllipse(anchor(0, 100), anchor(60_000, 50));
    const c = ctx();
    const projected = [{ drawing: e, geom: projectDrawing(e, c) }];
    const geom = projected[0]!.geom;
    if (geom.kind !== "ellipse") {
      throw new Error("unreachable");
    }
    for (const i of [0, 1] as const) {
      const a = geom.anchors[i];
      const hit = hitTestDrawings(a.x, a.y, projected, "e1", { handle: 10, body: 8 });
      expect(hit?.handle).toBe(i);
    }
  });

  it("degenerate (rx=0, ry=0) returns null hit without throw", () => {
    const e = makeEllipse(anchor(0, 100), anchor(0, 100));
    const c = ctx();
    const projected = [{ drawing: e, geom: projectDrawing(e, c) }];
    const geom = projected[0]!.geom;
    if (geom.kind !== "ellipse") {
      throw new Error("unreachable");
    }
    const hit = hitTestDrawings(geom.cx, geom.cy, projected, null, { handle: 10, body: 8 });
    expect(hit).toBeNull();
  });
});
