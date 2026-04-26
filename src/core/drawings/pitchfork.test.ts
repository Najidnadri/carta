import { describe, expect, it } from "vitest";
import { TimeScale } from "../time/TimeScale.js";
import { PriceScale } from "../price/PriceScale.js";
import { asInterval, asPrice, asTime } from "../../types.js";
import { projectDrawing, type ProjectionContext } from "./project.js";
import { hitTestDrawings } from "./hitTest.js";
import { computePitchforkCenterlineBase } from "./pitchfork.js";
import {
  MAIN_PANE_ID,
  asDrawingId,
  type DrawingAnchor,
  type PitchforkDrawing,
  type PitchforkVariant,
} from "./types.js";

const anchor = (time: number, price: number): DrawingAnchor => Object.freeze({
  time: asTime(time),
  price: asPrice(price),
  paneId: MAIN_PANE_ID,
});

function makePitchfork(
  variant: PitchforkVariant,
  pivot: DrawingAnchor,
  r1: DrawingAnchor,
  r2: DrawingAnchor,
): PitchforkDrawing {
  return Object.freeze({
    id: asDrawingId(`pf-${variant}`),
    kind: "pitchfork" as const,
    anchors: Object.freeze([pivot, r1, r2] as const),
    style: Object.freeze({ stroke: { color: 0xff8800 } }),
    locked: false,
    visible: true,
    z: 0,
    schemaVersion: 1 as const,
    variant,
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

describe("computePitchforkCenterlineBase — variant math", () => {
  const pivot = { time: 0, price: 100 };
  const r1 = { time: 30_000, price: 120 };
  const r2 = { time: 30_000, price: 80 };

  it("andrews → midpoint of (r1, r2)", () => {
    const base = computePitchforkCenterlineBase("andrews", pivot, r1, r2);
    expect(base.time).toBe(30_000);
    expect(base.price).toBe(100);
  });

  it("schiff → (pivot.time, midpoint of reaction prices)", () => {
    const base = computePitchforkCenterlineBase("schiff", pivot, r1, r2);
    expect(base.time).toBe(0);
    expect(base.price).toBe(100);
  });

  it("modifiedSchiff → (midpoint(pivot.time, midpoint reaction times), midpoint reaction prices)", () => {
    const base = computePitchforkCenterlineBase("modifiedSchiff", pivot, r1, r2);
    // reactionMidTime = 30_000; modSchiffTime = (0 + 30_000) / 2 = 15_000
    expect(base.time).toBe(15_000);
    expect(base.price).toBe(100);
  });

  it("anchor-order symmetric for andrews", () => {
    const a = computePitchforkCenterlineBase("andrews", pivot, r1, r2);
    const b = computePitchforkCenterlineBase("andrews", pivot, r2, r1);
    expect(a.time).toBe(b.time);
    expect(a.price).toBe(b.price);
  });
});

describe("pitchfork projection", () => {
  it("projects 3 anchors and emits centerline + upper + lower rails", () => {
    const pf = makePitchfork(
      "andrews",
      anchor(0, 100),
      anchor(30_000, 120),
      anchor(30_000, 80),
    );
    const geom = projectDrawing(pf, ctx());
    expect(geom.kind).toBe("pitchfork");
    if (geom.kind !== "pitchfork") {
      throw new Error("unreachable");
    }
    expect(geom.anchors.length).toBe(3);
    expect(geom.centerline.length).toBe(2);
    expect(geom.upperRail.length).toBe(2);
    expect(geom.lowerRail.length).toBe(2);
  });

  it("upper + lower rails are parallel to centerline (same slope vector)", () => {
    const pf = makePitchfork(
      "andrews",
      anchor(0, 100),
      anchor(30_000, 120),
      anchor(30_000, 80),
    );
    const geom = projectDrawing(pf, ctx());
    if (geom.kind !== "pitchfork") {
      throw new Error("unreachable");
    }
    const dxC = geom.centerline[1].x - geom.centerline[0].x;
    const dyC = geom.centerline[1].y - geom.centerline[0].y;
    const dxU = geom.upperRail[1].x - geom.upperRail[0].x;
    const dyU = geom.upperRail[1].y - geom.upperRail[0].y;
    const dxL = geom.lowerRail[1].x - geom.lowerRail[0].x;
    const dyL = geom.lowerRail[1].y - geom.lowerRail[0].y;
    // Cross-product of direction vectors ≈ 0 → parallel.
    expect(Math.abs(dxC * dyU - dyC * dxU)).toBeLessThan(0.5);
    expect(Math.abs(dxC * dyL - dyC * dxL)).toBeLessThan(0.5);
  });

  it("Schiff variant centerline anchored at pivot time", () => {
    const pf = makePitchfork(
      "schiff",
      anchor(0, 100),
      anchor(30_000, 120),
      anchor(30_000, 80),
    );
    const geom = projectDrawing(pf, ctx());
    if (geom.kind !== "pitchfork") {
      throw new Error("unreachable");
    }
    // Centerline runs from pivot horizontally (since base.price == pivot.price == 100
    // and base.time == pivot.time → degenerate; extendSegment returns [a, b]).
    expect(geom.centerline[0].x).toBeCloseTo(geom.anchors[0].x, 1);
  });

  it("default style.extend = 'right' extends rays toward plot's right edge", () => {
    const pf = makePitchfork(
      "andrews",
      anchor(0, 100),
      anchor(30_000, 120),
      anchor(30_000, 80),
    );
    const geom = projectDrawing(pf, ctx());
    if (geom.kind !== "pitchfork") {
      throw new Error("unreachable");
    }
    // Centerline ends at or beyond the original base point's x.
    expect(geom.centerline[1].x).toBeGreaterThanOrEqual(geom.anchors[0].x - 0.5);
  });

  it("style.extend = 'none' keeps centerline within (pivot, base) span", () => {
    const pf: PitchforkDrawing = Object.freeze({
      ...makePitchfork(
        "andrews",
        anchor(0, 100),
        anchor(30_000, 120),
        anchor(30_000, 80),
      ),
      style: Object.freeze({ stroke: { color: 0xff8800 }, extend: "none" as const }),
    });
    const geom = projectDrawing(pf, ctx());
    if (geom.kind !== "pitchfork") {
      throw new Error("unreachable");
    }
    // Without extension, centerline runs pivot → base; base.time = 30_000.
    const base = computePitchforkCenterlineBase(
      "andrews",
      { time: 0, price: 100 },
      { time: 30_000, price: 120 },
      { time: 30_000, price: 80 },
    );
    const expectedBaseX = (base.time / 120_000) * 600;
    expect(geom.centerline[1].x).toBeCloseTo(expectedBaseX, 0);
  });

  it("degenerate (pivot == reaction1 == reaction2) does not throw", () => {
    const pf = makePitchfork(
      "andrews",
      anchor(0, 100),
      anchor(0, 100),
      anchor(0, 100),
    );
    expect(() => projectDrawing(pf, ctx())).not.toThrow();
  });
});

describe("pitchfork hit-test", () => {
  it("body hit on centerline", () => {
    const pf = makePitchfork(
      "andrews",
      anchor(0, 100),
      anchor(30_000, 120),
      anchor(30_000, 80),
    );
    const c = ctx();
    const projected = [{ drawing: pf, geom: projectDrawing(pf, c) }];
    const geom = projected[0]!.geom;
    if (geom.kind !== "pitchfork") {
      throw new Error("unreachable");
    }
    const mx = (geom.centerline[0].x + geom.centerline[1].x) / 2;
    const my = (geom.centerline[0].y + geom.centerline[1].y) / 2;
    const hit = hitTestDrawings(mx, my, projected, null, { handle: 10, body: 8 });
    expect(hit?.drawing.id).toBe("pf-andrews");
    expect(hit?.part).toBe("line");
  });

  it("handle hit on each of 3 anchors when selected", () => {
    const pf = makePitchfork(
      "andrews",
      anchor(0, 100),
      anchor(30_000, 120),
      anchor(30_000, 80),
    );
    const c = ctx();
    const projected = [{ drawing: pf, geom: projectDrawing(pf, c) }];
    const geom = projected[0]!.geom;
    if (geom.kind !== "pitchfork") {
      throw new Error("unreachable");
    }
    for (let i = 0 as 0 | 1 | 2; i < 3; i++) {
      const a = geom.anchors[i];
      const hit = hitTestDrawings(a.x, a.y, projected, "pf-andrews", { handle: 10, body: 8 });
      expect(hit?.handle).toBe(i);
    }
  });

  it("misses outside bbox", () => {
    const pf = makePitchfork(
      "andrews",
      anchor(0, 100),
      anchor(30_000, 120),
      anchor(30_000, 80),
    );
    const c = ctx();
    const projected = [{ drawing: pf, geom: projectDrawing(pf, c) }];
    const hit = hitTestDrawings(-500, -500, projected, null, { handle: 10, body: 8 });
    expect(hit).toBeNull();
  });
});
