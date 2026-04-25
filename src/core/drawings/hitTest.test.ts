import { describe, expect, it } from "vitest";
import { defaultTolerancesFor, hitTestDrawings, pointToSegmentDistance } from "./hitTest.js";
import type { Drawing } from "./types.js";
import type { ScreenGeom } from "./project.js";

describe("pointToSegmentDistance", () => {
  it("equals point distance for degenerate (a == b) segments", () => {
    const d = pointToSegmentDistance(3, 4, 0, 0, 0, 0);
    expect(d).toBeCloseTo(5, 6);
  });

  it("clamps to nearest endpoint when projection lies outside [0,1]", () => {
    const d1 = pointToSegmentDistance(-2, 0, 0, 0, 10, 0);
    expect(d1).toBeCloseTo(2, 6);
    const d2 = pointToSegmentDistance(15, 0, 0, 0, 10, 0);
    expect(d2).toBeCloseTo(5, 6);
  });

  it("returns perpendicular distance for interior projections", () => {
    const d = pointToSegmentDistance(5, 3, 0, 0, 10, 0);
    expect(d).toBeCloseTo(3, 6);
  });
});

describe("defaultTolerancesFor", () => {
  it("returns 22/dpr handle tol on touch and 10/dpr on mouse", () => {
    expect(defaultTolerancesFor("touch", 1)).toEqual({ handle: 22, body: 12 });
    expect(defaultTolerancesFor("mouse", 1)).toEqual({ handle: 10, body: 8 });
    const dpr2 = defaultTolerancesFor("touch", 2);
    expect(dpr2.handle).toBeCloseTo(11, 6);
    expect(dpr2.body).toBeCloseTo(6, 6);
  });

  it("falls back to dpr=1 for non-finite/zero dpr", () => {
    expect(defaultTolerancesFor("mouse", 0)).toEqual({ handle: 10, body: 8 });
    expect(defaultTolerancesFor("mouse", Number.NaN)).toEqual({ handle: 10, body: 8 });
  });
});

function fakeDrawing(id: string): Drawing {
  return {
    id: id as Drawing["id"],
    kind: "trendline",
    style: {},
    locked: false,
    visible: true,
    z: 0,
    schemaVersion: 1,
    anchors: [
      { time: 0 as Drawing["anchors"][0]["time"], price: 0 as Drawing["anchors"][0]["price"], paneId: "main" as Drawing["anchors"][0]["paneId"] },
      { time: 100 as Drawing["anchors"][0]["time"], price: 100 as Drawing["anchors"][0]["price"], paneId: "main" as Drawing["anchors"][0]["paneId"] },
    ],
  } as Drawing;
}

describe("hitTestDrawings — selection precedence", () => {
  it("returns null when no drawings hit", () => {
    const d = fakeDrawing("a");
    const geom: ScreenGeom = {
      kind: "trendline",
      anchors: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
      visible: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
    };
    const r = hitTestDrawings(500, 500, [{ drawing: d, geom }], null, { handle: 10, body: 8 });
    expect(r).toBeNull();
  });

  it("returns line hit when click is on body (not selected)", () => {
    const d = fakeDrawing("a");
    const geom: ScreenGeom = {
      kind: "trendline",
      anchors: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
      visible: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
    };
    const r = hitTestDrawings(50, 50, [{ drawing: d, geom }], null, { handle: 10, body: 8 });
    expect(r).not.toBeNull();
    expect(r?.part).toBe("line");
  });

  it("returns handle when selected drawing's anchor is hit", () => {
    const d = fakeDrawing("a");
    const geom: ScreenGeom = {
      kind: "trendline",
      anchors: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
      visible: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
    };
    const r = hitTestDrawings(2, 2, [{ drawing: d, geom }], "a", { handle: 10, body: 8 });
    expect(r?.part).toBe("handle");
    expect(r?.handle).toBe(0);
  });

  it("topmost-z wins (last in array)", () => {
    const a = { ...fakeDrawing("a"), z: 0 } as Drawing;
    const b = { ...fakeDrawing("b"), z: 1 } as Drawing;
    const geom: ScreenGeom = {
      kind: "trendline",
      anchors: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
      visible: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
    };
    // b is later → higher z. We pass them in z-ascending order to mimic projector output.
    const r = hitTestDrawings(50, 50, [{ drawing: a, geom }, { drawing: b, geom }], null, { handle: 10, body: 8 });
    expect(r?.drawing.id).toBe("b");
  });
});

describe("hitTestDrawings — rectangle border vs body", () => {
  it("returns 'border' near edge, 'body' deep inside (filled rect)", () => {
    const d: Drawing = {
      id: "r" as Drawing["id"],
      kind: "rectangle",
      style: { fill: { color: 0xffffff, alpha: 0.5 } },
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [
        { time: 0 as Drawing["anchors"][0]["time"], price: 0 as Drawing["anchors"][0]["price"], paneId: "main" as Drawing["anchors"][0]["paneId"] },
        { time: 100 as Drawing["anchors"][0]["time"], price: 100 as Drawing["anchors"][0]["price"], paneId: "main" as Drawing["anchors"][0]["paneId"] },
      ],
    } as Drawing;
    const geom: ScreenGeom = {
      kind: "rectangle",
      anchors: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
      corners: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      xMin: 0, xMax: 100, yMin: 0, yMax: 100,
    };
    const inside = hitTestDrawings(50, 50, [{ drawing: d, geom }], null, { handle: 10, body: 8 });
    expect(inside?.part).toBe("body");
    const onBorder = hitTestDrawings(2, 50, [{ drawing: d, geom }], null, { handle: 10, body: 8 });
    expect(onBorder?.part).toBe("border");
    const outside = hitTestDrawings(150, 50, [{ drawing: d, geom }], null, { handle: 10, body: 8 });
    expect(outside).toBeNull();
  });
});

describe("hitTestDrawings — fib bbox prefilter", () => {
  it("rejects clicks outside the bbox cheaply", () => {
    const d: Drawing = {
      id: "f" as Drawing["id"],
      kind: "fibRetracement",
      style: {},
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [
        { time: 0 as Drawing["anchors"][0]["time"], price: 0 as Drawing["anchors"][0]["price"], paneId: "main" as Drawing["anchors"][0]["paneId"] },
        { time: 100 as Drawing["anchors"][0]["time"], price: 100 as Drawing["anchors"][0]["price"], paneId: "main" as Drawing["anchors"][0]["paneId"] },
      ],
      levels: [{ value: 0 }, { value: 1 }],
      showPrices: true,
      showPercents: true,
    } as Drawing;
    const geom: ScreenGeom = {
      kind: "fibRetracement",
      anchors: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
      xMin: 0, xMax: 100,
      levels: [
        { value: 0, y: 0, snappedY: 0.5, price: 0, visible: true, color: undefined, alpha: undefined },
        { value: 1, y: 100, snappedY: 100.5, price: 100, visible: true, color: undefined, alpha: undefined },
      ],
      bbox: { xMin: 0, xMax: 100, yMin: 0, yMax: 100 },
    };
    const outside = hitTestDrawings(500, 500, [{ drawing: d, geom }], null, { handle: 10, body: 8 });
    expect(outside).toBeNull();
    const onLevel = hitTestDrawings(50, 0, [{ drawing: d, geom }], null, { handle: 10, body: 8 });
    expect(onLevel?.part).toBe("line");
  });
});
