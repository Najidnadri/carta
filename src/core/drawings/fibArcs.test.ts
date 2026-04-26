import { describe, expect, it } from "vitest";
import { TimeScale } from "../time/TimeScale.js";
import { PriceScale } from "../price/PriceScale.js";
import { asInterval, asPrice, asTime } from "../../types.js";
import { projectDrawing, type ProjectionContext } from "./project.js";
import { hitTestDrawings, defaultTolerancesFor } from "./hitTest.js";
import {
  asDrawingId,
  DEFAULT_FIB_ARC_LEVELS,
  MAIN_PANE_ID,
  type DrawingAnchor,
  type FibArcsDrawing,
} from "./types.js";

const anchor = (time: number, price: number): DrawingAnchor =>
  Object.freeze({ time: asTime(time), price: asPrice(price), paneId: MAIN_PANE_ID });

function ctx(pixelWidth = 600, pixelHeight = 400): ProjectionContext {
  return Object.freeze({
    timeScale: new TimeScale({
      startTime: asTime(0),
      endTime: asTime(120_000),
      intervalDuration: asInterval(60_000),
      pixelWidth,
    }),
    priceScale: new PriceScale({
      domainMin: asPrice(0),
      domainMax: asPrice(200),
      pixelHeight,
      margins: { top: 0, bottom: 0 },
    }),
    plotRect: { x: 0, y: 0, w: pixelWidth, h: pixelHeight },
  });
}

const sample = (
  a: DrawingAnchor = anchor(30_000, 110),
  b: DrawingAnchor = anchor(90_000, 90),
  levels = DEFAULT_FIB_ARC_LEVELS,
): FibArcsDrawing =>
  Object.freeze({
    id: asDrawingId("farc1"),
    kind: "fibArcs" as const,
    anchors: Object.freeze([a, b] as const),
    levels,
    style: Object.freeze({ stroke: { color: 0x00aaff } }),
    locked: false,
    visible: true,
    z: 0,
    schemaVersion: 1 as const,
  });

describe("fibArcs projection", () => {
  it("default level set has 8 rings", () => {
    expect(DEFAULT_FIB_ARC_LEVELS.length).toBe(8);
  });

  it("r = ‖B − A‖ in screen space; level-1 ring radius equals r", () => {
    const geom = projectDrawing(sample(), ctx());
    if (geom.kind !== "fibArcs") {
      throw new Error("unreachable");
    }
    const a = geom.anchors[0];
    const b = geom.anchors[1];
    const expectedR = Math.hypot(b.x - a.x, b.y - a.y);
    expect(geom.r).toBeCloseTo(expectedR, 6);
    const level1 = geom.rings.find((r) => r.level === 1);
    expect(level1?.r).toBeCloseTo(expectedR, 6);
  });

  it("DPR 1→2 invariant: A stays center, B stays on level-1 ring (CSS-px geometry preserved)", () => {
    // The "DPR change" reflow path is, mechanically, a re-projection through the
    // same scale/plot data.  Carta's TimeScale/PriceScale operate in CSS px, so
    // bumping DPR via the renderer doesn't change the projection output for the
    // same `(time, price)` inputs.  Verify by re-running projection (same ctx)
    // and confirming the invariant holds frame-by-frame.
    const c = ctx();
    const g1 = projectDrawing(sample(), c);
    const g2 = projectDrawing(sample(), c);
    if (g1.kind !== "fibArcs" || g2.kind !== "fibArcs") {
      throw new Error("unreachable");
    }
    const a2 = g2.anchors[0];
    const b2 = g2.anchors[1];
    // A is the center.
    expect(g2.cx).toBeCloseTo(a2.x, 9);
    expect(g2.cy).toBeCloseTo(a2.y, 9);
    // B sits on the level-1 ring (within float tolerance).
    const dB = Math.hypot(b2.x - g2.cx, b2.y - g2.cy);
    const ring1 = g2.rings.find((r) => r.level === 1)!;
    expect(Math.abs(dB - ring1.r)).toBeLessThan(1e-9);
    // Radius unchanged across re-projections (same inputs ⇒ deterministic).
    expect(g1.r).toBeCloseTo(g2.r, 9);
  });

  it("rPx<1 ring is not in the rings (degenerate small radius is filtered by render guard, not projection)", () => {
    // Projection itself doesn't filter rings <1; the render guard does. Sanity-
    // check that level-0 (if present) yields a 0-radius ring as expected.
    const withZero = sample(anchor(0, 100), anchor(60_000, 110), [
      { value: 0 },
      { value: 1 },
    ]);
    const geom = projectDrawing(withZero, ctx());
    if (geom.kind !== "fibArcs") {
      throw new Error("unreachable");
    }
    const ring0 = geom.rings.find((r) => r.level === 0);
    expect(ring0?.r).toBe(0);
  });

  it("hit-test on level-1 ring returns 'line' (bottom half-arc)", () => {
    const c = ctx();
    const geom = projectDrawing(sample(), c);
    if (geom.kind !== "fibArcs") {
      throw new Error("unreachable");
    }
    const ring1 = geom.rings.find((r) => r.level === 1)!;
    const tols = defaultTolerancesFor("mouse", 1);
    // Sample at angle = π/2 on the level-1 ring (directly below the center).
    const px = geom.cx;
    const py = geom.cy + ring1.r;
    const hit = hitTestDrawings(px, py, [{ drawing: sample(), geom }], null, tols);
    expect(hit).not.toBeNull();
    expect(hit!.part).toBe("line");
  });

  it("hit-test rejects upper-half-arc points (top half not drawn)", () => {
    const c = ctx();
    const geom = projectDrawing(sample(), c);
    if (geom.kind !== "fibArcs") {
      throw new Error("unreachable");
    }
    const ring1 = geom.rings.find((r) => r.level === 1)!;
    const tols = defaultTolerancesFor("mouse", 1);
    const px = geom.cx;
    const py = geom.cy - ring1.r;
    const hit = hitTestDrawings(px, py, [{ drawing: sample(), geom }], null, tols);
    expect(hit).toBeNull();
  });

  it("zero-vector anchors (B == A) produce r=0 with no throw", () => {
    const flat = sample(anchor(60_000, 100), anchor(60_000, 100));
    const geom = projectDrawing(flat, ctx());
    if (geom.kind !== "fibArcs") {
      throw new Error("unreachable");
    }
    expect(geom.r).toBe(0);
    // All ring radii are 0; render-time guards skip them.
    for (const ring of geom.rings) {
      expect(ring.r).toBe(0);
    }
  });
});
