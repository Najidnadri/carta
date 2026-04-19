import { describe, expect, it } from "vitest";
import { asInterval, asTime } from "../types.js";
import {
  computePannedWindow,
  computeShiftPannedWindow,
  computeZoomedWindow,
  normalizeWheelDelta,
  sanitizeWindow,
  type WindowSnapshot,
} from "./ViewportMath.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function snap(start: number, end: number, interval: number): WindowSnapshot {
  return {
    startTime: asTime(start),
    endTime: asTime(end),
    intervalDuration: asInterval(interval),
  };
}

describe("computePannedWindow", () => {
  const base = snap(1_700_000_000_000, 1_700_000_000_000 + DAY, MIN);

  it("drag-right shifts window to earlier times", () => {
    const out = computePannedWindow(base, 120, 1200);
    const dtPerPx = DAY / 1200;
    expect(Number(out.startTime)).toBeCloseTo(1_700_000_000_000 - 120 * dtPerPx, 3);
    expect(Number(out.endTime) - Number(out.startTime)).toBeCloseTo(DAY, 3);
  });

  it("drag-left shifts window to later times", () => {
    const out = computePannedWindow(base, -120, 1200);
    const dtPerPx = DAY / 1200;
    expect(Number(out.startTime)).toBeCloseTo(1_700_000_000_000 + 120 * dtPerPx, 3);
  });

  it("preserves width precisely", () => {
    const out = computePannedWindow(base, 37.5, 997);
    expect(Number(out.endTime) - Number(out.startTime)).toBeCloseTo(DAY, 3);
  });

  it("is identity for zero dx", () => {
    const out = computePannedWindow(base, 0, 1200);
    expect(Number(out.startTime)).toBe(Number(base.startTime));
    expect(Number(out.endTime)).toBe(Number(base.endTime));
  });

  it("bails on NaN start", () => {
    const bad = snap(Number.NaN, DAY, MIN);
    const out = computePannedWindow(bad, 100, 1200);
    expect(out.startTime).toBe(bad.startTime);
    expect(out.endTime).toBe(bad.endTime);
  });

  it("bails on non-positive interval", () => {
    const bad = snap(0, DAY, 0);
    const out = computePannedWindow(bad, 100, 1200);
    expect(out.startTime).toBe(bad.startTime);
  });

  it("bails on swapped window", () => {
    const bad = snap(DAY, 0, MIN);
    const out = computePannedWindow(bad, 100, 1200);
    expect(Number(out.startTime)).toBe(DAY);
    expect(Number(out.endTime)).toBe(0);
  });

  it("bails on zero plot width", () => {
    const out = computePannedWindow(base, 100, 0);
    expect(Number(out.startTime)).toBe(Number(base.startTime));
  });

  it("handles negative start time", () => {
    const negBase = snap(-DAY, 0, MIN);
    const out = computePannedWindow(negBase, 100, 1000);
    expect(Number(out.endTime) - Number(out.startTime)).toBe(DAY);
  });

  it("stays precise at huge epoch (~1e15)", () => {
    const huge = snap(1e15, 1e15 + DAY, MIN);
    const out = computePannedWindow(huge, 50, 1000);
    expect(Number(out.endTime) - Number(out.startTime)).toBeCloseTo(DAY, 0);
  });
});

describe("computeZoomedWindow", () => {
  const base = snap(1_000_000_000_000, 1_000_000_000_000 + DAY, MIN);

  it("zoom in (factor < 1) shrinks window", () => {
    const out = computeZoomedWindow(base, asTime(1_000_000_000_000 + DAY / 2), 0.5);
    expect(Number(out.endTime) - Number(out.startTime)).toBeCloseTo(DAY / 2, 3);
  });

  it("zoom out (factor > 1) expands window", () => {
    const out = computeZoomedWindow(base, asTime(1_000_000_000_000 + DAY / 2), 2);
    expect(Number(out.endTime) - Number(out.startTime)).toBeCloseTo(2 * DAY, 3);
  });

  it("anchor time stays proportionally under cursor when zooming in", () => {
    const anchor = 1_000_000_000_000 + DAY / 4;
    const out = computeZoomedWindow(base, asTime(anchor), 0.5);
    const origProp = (anchor - Number(base.startTime)) / DAY;
    const newProp = (anchor - Number(out.startTime)) / (Number(out.endTime) - Number(out.startTime));
    expect(newProp).toBeCloseTo(origProp, 6);
  });

  it("clamps when zoomed width would drop below intervalDuration", () => {
    const out = computeZoomedWindow(base, asTime(1_000_000_000_000), 1e-12);
    expect(Number(out.endTime) - Number(out.startTime)).toBe(MIN);
  });

  it("clamps when zoomed width would exceed maxWindowDuration", () => {
    const out = computeZoomedWindow(base, asTime(1_000_000_000_000 + DAY / 2), 1000, {
      maxWindowDuration: 2 * DAY,
    });
    expect(Number(out.endTime) - Number(out.startTime)).toBe(2 * DAY);
  });

  it("bails on non-finite anchor", () => {
    const out = computeZoomedWindow(base, asTime(Number.NaN), 0.5);
    expect(out.startTime).toBe(base.startTime);
  });

  it("bails on non-positive factor", () => {
    const out = computeZoomedWindow(base, asTime(1_000_000_000_000), 0);
    expect(out.startTime).toBe(base.startTime);
  });

  it("bails on degenerate snapshot", () => {
    const bad = snap(Number.NaN, DAY, MIN);
    const out = computeZoomedWindow(bad, asTime(0), 0.5);
    expect(out.startTime).toBe(bad.startTime);
  });

  it("handles anchor outside window by clamping proportionally", () => {
    const outBefore = computeZoomedWindow(base, asTime(1_000_000_000_000 - DAY), 0.5);
    expect(Number(outBefore.startTime)).toBe(Number(base.startTime));
    expect(Number(outBefore.endTime) - Number(outBefore.startTime)).toBeCloseTo(DAY / 2, 3);
  });

  it("stays precise at huge epoch", () => {
    const huge = snap(1e15, 1e15 + DAY, MIN);
    const out = computeZoomedWindow(huge, asTime(1e15 + DAY / 2), 0.5);
    expect(Number(out.endTime) - Number(out.startTime)).toBeCloseTo(DAY / 2, 0);
  });
});

describe("computeShiftPannedWindow", () => {
  const base = snap(0, DAY, MIN);

  it("positive direction shifts to later times", () => {
    const out = computeShiftPannedWindow(base, 1, 0.1);
    expect(Number(out.startTime)).toBeCloseTo(DAY * 0.1, 3);
    expect(Number(out.endTime)).toBeCloseTo(DAY * 1.1, 3);
  });

  it("negative direction shifts to earlier times", () => {
    const out = computeShiftPannedWindow(base, -1, 0.1);
    expect(Number(out.startTime)).toBeCloseTo(-DAY * 0.1, 3);
  });

  it("preserves width", () => {
    const out = computeShiftPannedWindow(base, 1, 0.25);
    expect(Number(out.endTime) - Number(out.startTime)).toBeCloseTo(DAY, 3);
  });

  it("bails on degenerate snapshot", () => {
    const bad = snap(DAY, 0, MIN);
    const out = computeShiftPannedWindow(bad, 1, 0.1);
    expect(Number(out.startTime)).toBe(DAY);
  });
});

describe("normalizeWheelDelta", () => {
  it("returns pixel delta unchanged for deltaMode 0", () => {
    expect(normalizeWheelDelta(100, 0)).toBe(100);
  });

  it("multiplies by line height for deltaMode 1", () => {
    expect(normalizeWheelDelta(3, 1)).toBe(48);
  });

  it("multiplies by page height for deltaMode 2", () => {
    expect(normalizeWheelDelta(1, 2)).toBe(800);
  });

  it("returns 0 on NaN", () => {
    expect(normalizeWheelDelta(Number.NaN, 0)).toBe(0);
  });
});

describe("sanitizeWindow", () => {
  const base = snap(0, DAY, MIN);

  it("accepts finite values", () => {
    const out = sanitizeWindow({ startTime: asTime(100), endTime: asTime(200) }, base);
    expect(Number(out.startTime)).toBe(100);
    expect(Number(out.endTime)).toBe(200);
  });

  it("falls back on NaN", () => {
    const out = sanitizeWindow(
      { startTime: asTime(Number.NaN), endTime: asTime(200) },
      base,
    );
    expect(out.startTime).toBe(base.startTime);
  });
});
