import { describe, expect, it } from "vitest";
import { TimeScale } from "../time/TimeScale.js";
import { PriceScale } from "../price/PriceScale.js";
import { asInterval, asPrice, asTime } from "../../types.js";
import { projectDrawing, type ProjectionContext } from "./project.js";
import { hitTestDrawings } from "./hitTest.js";
import { GANN_FAN_SLOPES } from "./pitchfork.js";
import {
  MAIN_PANE_ID,
  asDrawingId,
  type DrawingAnchor,
  type GannFanDrawing,
} from "./types.js";

const anchor = (time: number, price: number): DrawingAnchor => Object.freeze({
  time: asTime(time),
  price: asPrice(price),
  paneId: MAIN_PANE_ID,
});

function makeFan(pivot: DrawingAnchor, dir: DrawingAnchor): GannFanDrawing {
  return Object.freeze({
    id: asDrawingId("g1"),
    kind: "gannFan" as const,
    anchors: Object.freeze([pivot, dir] as const),
    style: Object.freeze({ stroke: { color: 0x00aa00 } }),
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

describe("gannFan projection", () => {
  it("emits 9 rays at the configured slopes", () => {
    const fan = makeFan(anchor(0, 100), anchor(60_000, 110));
    const geom = projectDrawing(fan, ctx());
    expect(geom.kind).toBe("gannFan");
    if (geom.kind !== "gannFan") {
      throw new Error("unreachable");
    }
    expect(geom.rays.length).toBe(9);
    expect(geom.rays.map((r) => r.slope)).toEqual(Array.from(GANN_FAN_SLOPES));
  });

  it("1×1 ray passes through (or near) the direction anchor", () => {
    const fan = makeFan(anchor(0, 100), anchor(60_000, 110));
    const geom = projectDrawing(fan, ctx());
    if (geom.kind !== "gannFan") {
      throw new Error("unreachable");
    }
    const unity = geom.rays.find((r) => r.slope === 1);
    expect(unity).toBeDefined();
    if (unity === undefined) {
      throw new Error("unreachable");
    }
    // Pivot at (x=0, price=100 → y=200). Direction at (x=300, price=110 → y=180).
    // The unity ray runs from pivot through direction, extended to plot edge.
    const px = geom.anchors[0].x;
    const py = geom.anchors[0].y;
    const dx = geom.anchors[1].x - px;
    const dy = geom.anchors[1].y - py;
    // Compare slope of unity-ray to (dy/dx).
    const rayDx = unity.visible[1].x - unity.visible[0].x;
    const rayDy = unity.visible[1].y - unity.visible[0].y;
    expect(Math.abs(rayDx * dy - rayDy * dx)).toBeLessThan(1);
  });

  it("steeper slopes emit rays with proportionally larger dy", () => {
    const fan = makeFan(anchor(0, 100), anchor(60_000, 110));
    const geom = projectDrawing(fan, ctx());
    if (geom.kind !== "gannFan") {
      throw new Error("unreachable");
    }
    const r1 = geom.rays.find((r) => r.slope === 1);
    const r2 = geom.rays.find((r) => r.slope === 2);
    if (r1 === undefined || r2 === undefined) {
      throw new Error("missing slopes");
    }
    const px = geom.anchors[0].x;
    const py = geom.anchors[0].y;
    // Project a far-x point on each ray; the steeper one should have larger |dy|.
    const t = 200;
    const dy1 = ((r1.visible[1].y - py) / (r1.visible[1].x - px)) * t;
    const dy2 = ((r2.visible[1].y - py) / (r2.visible[1].x - px)) * t;
    expect(Math.abs(dy2)).toBeGreaterThan(Math.abs(dy1));
  });

  it("degenerate zero-vector (dt=0) emits empty rays without throw", () => {
    const fan = makeFan(anchor(0, 100), anchor(0, 110));
    const geom = projectDrawing(fan, ctx());
    if (geom.kind !== "gannFan") {
      throw new Error("unreachable");
    }
    expect(geom.rays.length).toBe(0);
  });

  it("degenerate zero-vector (dp=0) emits empty rays without throw", () => {
    const fan = makeFan(anchor(0, 100), anchor(60_000, 100));
    const geom = projectDrawing(fan, ctx());
    if (geom.kind !== "gannFan") {
      throw new Error("unreachable");
    }
    expect(geom.rays.length).toBe(0);
  });

  it("style.extend = 'none' keeps each ray's right end near the direction-target", () => {
    const fan: GannFanDrawing = Object.freeze({
      ...makeFan(anchor(0, 100), anchor(60_000, 110)),
      style: Object.freeze({ stroke: { color: 0x00aa00 }, extend: "none" as const }),
    });
    const geom = projectDrawing(fan, ctx());
    if (geom.kind !== "gannFan") {
      throw new Error("unreachable");
    }
    const unity = geom.rays.find((r) => r.slope === 1);
    if (unity === undefined) {
      throw new Error("unreachable");
    }
    expect(unity.visible[1].x).toBeCloseTo(geom.anchors[1].x, 0);
  });
});

describe("gannFan hit-test", () => {
  it("body hits the unity ray near its midpoint", () => {
    const fan = makeFan(anchor(0, 100), anchor(60_000, 110));
    const c = ctx();
    const projected = [{ drawing: fan, geom: projectDrawing(fan, c) }];
    const geom = projected[0]!.geom;
    if (geom.kind !== "gannFan") {
      throw new Error("unreachable");
    }
    const unity = geom.rays.find((r) => r.slope === 1)!;
    const mx = (unity.visible[0].x + unity.visible[1].x) / 2;
    const my = (unity.visible[0].y + unity.visible[1].y) / 2;
    const hit = hitTestDrawings(mx, my, projected, null, { handle: 10, body: 8 });
    expect(hit?.drawing.id).toBe("g1");
  });

  it("handle hit on each anchor when selected", () => {
    const fan = makeFan(anchor(0, 100), anchor(60_000, 110));
    const c = ctx();
    const projected = [{ drawing: fan, geom: projectDrawing(fan, c) }];
    const geom = projected[0]!.geom;
    if (geom.kind !== "gannFan") {
      throw new Error("unreachable");
    }
    for (const i of [0, 1] as const) {
      const a = geom.anchors[i];
      const hit = hitTestDrawings(a.x, a.y, projected, "g1", { handle: 10, body: 8 });
      expect(hit?.handle).toBe(i);
    }
  });

  it("misses outside bbox", () => {
    const fan = makeFan(anchor(0, 100), anchor(60_000, 110));
    const c = ctx();
    const projected = [{ drawing: fan, geom: projectDrawing(fan, c) }];
    const hit = hitTestDrawings(-500, -500, projected, null, { handle: 10, body: 8 });
    expect(hit).toBeNull();
  });
});
