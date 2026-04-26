/**
 * Phase 13 Cycle C.3 — brush parser + normalize + snapshot round-trip tests.
 *
 * The pointer-stream capture FSM lives inside `DrawingsController` and is
 * exercised by the e2e Playwright pass; this spec covers the deterministic
 * boundaries: parse, normalize, round-trip.
 */

import { describe, expect, it } from "vitest";
import { asPrice, asTime } from "../../types.js";
import {
  asDrawingId,
  MAIN_PANE_ID,
  type BrushDrawing,
  type DrawingAnchor,
} from "./types.js";
import { normalizeDrawingDefaults } from "./normalize.js";
import { parseDrawing, parseSnapshot } from "./parsers.js";

function anchor(time: number, price: number): DrawingAnchor {
  return Object.freeze({
    time: asTime(time),
    price: asPrice(price),
    paneId: MAIN_PANE_ID,
  });
}

function makeBrush(points: readonly DrawingAnchor[]): BrushDrawing {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return Object.freeze({
    id: asDrawingId("brush-test"),
    kind: "brush",
    anchors: Object.freeze([first, last] as const),
    points: Object.freeze(points.slice()),
    style: Object.freeze({}),
    locked: false,
    visible: true,
    z: 1,
    schemaVersion: 1,
  });
}

describe("brush parsing", () => {
  it("parses a valid brush JSON shape", () => {
    const json = {
      id: "b-1",
      kind: "brush",
      anchors: [
        { time: 0, price: 100, paneId: "main" },
        { time: 5, price: 110, paneId: "main" },
      ],
      points: [
        { time: 0, price: 100, paneId: "main" },
        { time: 1, price: 102, paneId: "main" },
        { time: 5, price: 110, paneId: "main" },
      ],
      style: {},
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
    };
    const parsed = parseDrawing(json);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("brush");
    if (parsed?.kind === "brush") {
      expect(parsed.points.length).toBe(3);
      expect(Number(parsed.points[1]?.price ?? 0)).toBe(102);
    }
  });

  it("rejects a brush with fewer than 2 points", () => {
    const json = {
      id: "b-1",
      kind: "brush",
      anchors: [
        { time: 0, price: 100, paneId: "main" },
        { time: 0, price: 100, paneId: "main" },
      ],
      points: [{ time: 0, price: 100, paneId: "main" }],
      style: {},
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
    };
    expect(parseDrawing(json)).toBeNull();
  });

  it("rejects a brush with a non-finite point", () => {
    const json = {
      id: "b-1",
      kind: "brush",
      anchors: [
        { time: 0, price: 100, paneId: "main" },
        { time: 5, price: 110, paneId: "main" },
      ],
      points: [
        { time: 0, price: 100, paneId: "main" },
        { time: NaN, price: 102, paneId: "main" },
        { time: 5, price: 110, paneId: "main" },
      ],
      style: {},
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
    };
    expect(parseDrawing(json)).toBeNull();
  });
});

describe("brush normalize", () => {
  it("accepts a well-formed brush", () => {
    const b = makeBrush([anchor(0, 100), anchor(5, 110), anchor(10, 105)]);
    const result = normalizeDrawingDefaults(b, 60_000);
    expect(result.drawing).not.toBeNull();
    expect(result.warn).toBeNull();
  });

  it("drops a brush with NaN waypoint", () => {
    const b: BrushDrawing = Object.freeze({
      id: asDrawingId("b-2"),
      kind: "brush",
      anchors: Object.freeze([anchor(0, 100), anchor(10, 110)] as const),
      points: Object.freeze([anchor(0, 100), { time: asTime(NaN), price: asPrice(105), paneId: MAIN_PANE_ID }, anchor(10, 110)]),
      style: Object.freeze({}),
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
    });
    const result = normalizeDrawingDefaults(b, 60_000);
    expect(result.drawing).toBeNull();
    expect(result.warn).not.toBeNull();
  });

  it("drops a brush with fewer than 2 points", () => {
    const b: BrushDrawing = Object.freeze({
      id: asDrawingId("b-3"),
      kind: "brush",
      anchors: Object.freeze([anchor(0, 100), anchor(10, 110)] as const),
      points: Object.freeze([anchor(0, 100)]),
      style: Object.freeze({}),
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
    });
    const result = normalizeDrawingDefaults(b, 60_000);
    expect(result.drawing).toBeNull();
    expect(result.warn).not.toBeNull();
  });
});

describe("brush snapshot round-trip", () => {
  it("survives parseSnapshot → drawings", () => {
    const points = [anchor(0, 100), anchor(1, 101), anchor(2, 102)];
    const original: BrushDrawing = makeBrush(points);
    const snapshot = {
      schemaVersion: 1,
      drawings: [original],
    };
    const result = parseSnapshot(snapshot);
    expect(result.droppedCount).toBe(0);
    expect(result.snapshot.drawings.length).toBe(1);
    const round = result.snapshot.drawings[0];
    expect(round?.kind).toBe("brush");
    if (round?.kind === "brush") {
      expect(round.points.length).toBe(3);
      expect(Number(round.points[2]?.price ?? 0)).toBe(102);
      expect(Number(round.anchors[0].time)).toBe(0);
      expect(Number(round.anchors[1].time)).toBe(2);
    }
  });
});
