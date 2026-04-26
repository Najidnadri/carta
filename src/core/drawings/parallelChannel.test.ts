import { describe, expect, it } from "vitest";
import { TimeScale } from "../time/TimeScale.js";
import { PriceScale } from "../price/PriceScale.js";
import { asInterval, asPrice, asTime } from "../../types.js";
import { projectDrawing, type ProjectionContext } from "./project.js";
import { hitTestDrawings } from "./hitTest.js";
import { MAIN_PANE_ID, asDrawingId, type DrawingAnchor, type ParallelChannelDrawing } from "./types.js";

const anchor = (time: number, price: number): DrawingAnchor => Object.freeze({
  time: asTime(time),
  price: asPrice(price),
  paneId: MAIN_PANE_ID,
});

const sample: ParallelChannelDrawing = Object.freeze({
  id: asDrawingId("pc1"),
  kind: "parallelChannel" as const,
  anchors: Object.freeze([anchor(0, 100), anchor(60_000, 110), anchor(0, 90)] as const),
  style: Object.freeze({ stroke: { color: 0xff0000 } }),
  locked: false,
  visible: true,
  z: 0,
  schemaVersion: 1 as const,
});

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

describe("parallelChannel projection", () => {
  it("projects three anchors and emits a 4-vertex clockwise polygon", () => {
    const geom = projectDrawing(sample, ctx());
    expect(geom.kind).toBe("parallelChannel");
    if (geom.kind !== "parallelChannel") {
      throw new Error("unreachable");
    }
    expect(geom.anchors.length).toBe(3);
    expect(geom.polygon.length).toBe(4);
    // Polygon: top-a → top-b → bottom-b → bottom-a (clockwise on screen).
    expect(geom.polygon[0]).toBe(geom.top[0]);
    expect(geom.polygon[1]).toBe(geom.top[1]);
    expect(geom.polygon[2]).toBe(geom.bottom[1]);
    expect(geom.polygon[3]).toBe(geom.bottom[0]);
  });

  it("Δprice equals (c.price - priceOnLineAtTime(c.time))", () => {
    // For c at time=0 (== aTime), priceOnLineAtTime should equal aPrice (100).
    // c.price = 90 → Δprice = -10. The bottom line should be 10 lower than top in price-space.
    const geom = projectDrawing(sample, ctx());
    if (geom.kind !== "parallelChannel") {
      throw new Error("unreachable");
    }
    // Top runs along price 100 (constant since aPrice=100, bPrice=110 — actually slope!)
    // priceOnLineAtTime(0) = 100; bottom should be price 90 at t=0.
    // PriceScale with domain [0,200] over height 400 → 1 unit price = 2 px.
    // top y at price 100 = 200 px from top (PriceScale flips y). Let's just check
    // bottom is BELOW top by |Δprice * (h/domainSpan)| = |(-10)*(400/200)| = 20px lower (higher y).
    const dyAtT0 = geom.bottom[0].y - geom.top[0].y;
    const dyAtT1 = geom.bottom[1].y - geom.top[1].y;
    // Both equal a constant offset (parallel lines).
    expect(Math.abs(dyAtT0 - dyAtT1)).toBeLessThan(0.01);
    // Δprice = -10 → bottom price is 10 below top → since y increases downward
    // and a smaller price renders LOWER on screen → larger y. Expect dy ≈ +20.
    expect(dyAtT0).toBeCloseTo(20, 1);
  });

  it("degenerate c-on-line case produces overlapping top + bottom strokes", () => {
    const onLineSample: ParallelChannelDrawing = Object.freeze({
      ...sample,
      anchors: Object.freeze([
        anchor(0, 100),
        anchor(60_000, 110),
        anchor(30_000, 105), // exactly on the line a→b
      ] as const),
    });
    const geom = projectDrawing(onLineSample, ctx());
    if (geom.kind !== "parallelChannel") {
      throw new Error("unreachable");
    }
    // Δprice ≈ 0 → top and bottom overlap.
    expect(Math.abs(geom.bottom[0].y - geom.top[0].y)).toBeLessThan(0.01);
    expect(Math.abs(geom.bottom[1].y - geom.top[1].y)).toBeLessThan(0.01);
  });
});

describe("parallelChannel hit-test", () => {
  it("hits all three handles on the selected drawing", () => {
    const c = ctx();
    const projected = [{ drawing: sample, geom: projectDrawing(sample, c) }];
    const tols = { handle: 8, body: 8 };
    const geom = projected[0]!.geom;
    if (geom.kind !== "parallelChannel") {
      throw new Error("unreachable");
    }
    for (let i = 0 as 0 | 1 | 2; i < 3; i++) {
      const a = geom.anchors[i];
      const hit = hitTestDrawings(a.x, a.y, projected, "pc1", tols);
      expect(hit?.handle).toBe(i);
    }
  });

  it("hits the body interior", () => {
    const c = ctx();
    const projected = [{ drawing: sample, geom: projectDrawing(sample, c) }];
    const geom = projected[0]!.geom;
    if (geom.kind !== "parallelChannel") {
      throw new Error("unreachable");
    }
    const cx = (geom.bbox.xMin + geom.bbox.xMax) / 2;
    const cy = (geom.bbox.yMin + geom.bbox.yMax) / 2;
    const hit = hitTestDrawings(cx, cy, projected, null, { handle: 8, body: 8 });
    expect(hit?.drawing.id).toBe("pc1");
  });

  it("misses far outside the bbox", () => {
    const c = ctx();
    const projected = [{ drawing: sample, geom: projectDrawing(sample, c) }];
    const hit = hitTestDrawings(-500, -500, projected, null, { handle: 8, body: 8 });
    expect(hit).toBeNull();
  });
});

describe("ray + extendedLine + horizontalRay projection", () => {
  it("projects ray with extend=right semantics", () => {
    const c = ctx();
    const ray = {
      ...sample,
      kind: "ray" as const,
      anchors: Object.freeze([anchor(0, 100), anchor(60_000, 110)] as const),
    };
    const geom = projectDrawing(ray, c);
    expect(geom.kind).toBe("ray");
    if (geom.kind !== "ray") {
      return;
    }
    expect(geom.visible[0].x).toBeCloseTo(geom.anchors[0].x, 1);
    expect(geom.visible[1].x).toBeGreaterThanOrEqual(geom.anchors[1].x);
  });

  it("projects horizontalRay with direction=right starts at anchor and runs right", () => {
    const hr = {
      ...sample,
      kind: "horizontalRay" as const,
      anchors: Object.freeze([anchor(30_000, 100)] as const),
      direction: "right" as const,
    };
    const geom = projectDrawing(hr, ctx());
    expect(geom.kind).toBe("horizontalRay");
    if (geom.kind !== "horizontalRay") {
      return;
    }
    expect(geom.x1).toBeCloseTo(geom.anchor.x, 1);
    expect(geom.x2).toBeCloseTo(600, 1);
  });

  it("projects horizontalRay with direction=left ends at anchor and starts at left edge", () => {
    const hr = {
      ...sample,
      kind: "horizontalRay" as const,
      anchors: Object.freeze([anchor(30_000, 100)] as const),
      direction: "left" as const,
    };
    const geom = projectDrawing(hr, ctx());
    if (geom.kind !== "horizontalRay") {
      return;
    }
    expect(geom.x1).toBeCloseTo(0, 1);
    expect(geom.x2).toBeCloseTo(geom.anchor.x, 1);
  });
});
