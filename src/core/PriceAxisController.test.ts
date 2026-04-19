import { describe, expect, it } from "vitest";
import { asPrice } from "../types.js";
import {
  computeStretchedDomain,
  recognizeDoubleTap,
} from "./PriceAxisController.js";

const D = (min: number, max: number): { min: ReturnType<typeof asPrice>; max: ReturnType<typeof asPrice> } => ({
  min: asPrice(min),
  max: asPrice(max),
});

const DBL_OPTS = { doubleTapWindowMs: 300, doubleTapRadiusPx: 6 };

describe("computeStretchedDomain", () => {
  it("returns the start domain unchanged when Δy is zero", () => {
    const d = computeStretchedDomain(D(100, 200), 0, 400);
    expect(Number(d.min)).toBeCloseTo(100);
    expect(Number(d.max)).toBeCloseTo(200);
  });

  it("compresses around center when dragging up (negative Δy)", () => {
    const start = D(100, 200);
    const d = computeStretchedDomain(start, -400, 400);
    const center = (Number(d.min) + Number(d.max)) / 2;
    expect(center).toBeCloseTo(150, 6);
    expect(Number(d.max) - Number(d.min)).toBeLessThan(Number(start.max) - Number(start.min));
  });

  it("stretches around center when dragging down (positive Δy)", () => {
    const start = D(100, 200);
    const d = computeStretchedDomain(start, 400, 400);
    const center = (Number(d.min) + Number(d.max)) / 2;
    expect(center).toBeCloseTo(150, 6);
    expect(Number(d.max) - Number(d.min)).toBeGreaterThan(Number(start.max) - Number(start.min));
  });

  it("is symmetric: Δy then -Δy returns to the start domain", () => {
    const start = D(100, 200);
    const up = computeStretchedDomain(start, -123, 400);
    const back = computeStretchedDomain(up, 123, 400);
    expect(Number(back.min)).toBeCloseTo(100, 5);
    expect(Number(back.max)).toBeCloseTo(200, 5);
  });

  it("clamps the factor above the minimum bound", () => {
    const d = computeStretchedDomain(D(100, 200), -100_000, 400);
    const span = Number(d.max) - Number(d.min);
    expect(span).toBeGreaterThanOrEqual((200 - 100) * 0.05 - 1e-9);
  });

  it("clamps the factor below the maximum bound", () => {
    const d = computeStretchedDomain(D(100, 200), 100_000, 400);
    const span = Number(d.max) - Number(d.min);
    expect(span).toBeLessThanOrEqual((200 - 100) * 20 + 1e-9);
  });

  it("returns the start domain on non-finite Δy", () => {
    const start = D(100, 200);
    expect(computeStretchedDomain(start, Number.NaN, 400)).toEqual(start);
    expect(computeStretchedDomain(start, Number.POSITIVE_INFINITY, 400)).toEqual(start);
  });

  it("returns the start domain on zero / negative plotH", () => {
    const start = D(100, 200);
    expect(computeStretchedDomain(start, -50, 0)).toEqual(start);
    expect(computeStretchedDomain(start, -50, -5)).toEqual(start);
  });

  it("returns the start domain on inverted input", () => {
    const start = D(200, 100);
    expect(computeStretchedDomain(start, -50, 400)).toEqual(start);
  });

  it("returns the start domain on NaN domain bounds", () => {
    const start = D(Number.NaN, 100);
    expect(computeStretchedDomain(start, -50, 400)).toEqual(start);
  });

  it("preserves a flat domain (min === max)", () => {
    const start = D(42, 42);
    const d = computeStretchedDomain(start, -50, 400);
    expect(Number(d.min)).toBe(42);
    expect(Number(d.max)).toBe(42);
  });
});

describe("recognizeDoubleTap", () => {
  it("rejects when there is no previous tap", () => {
    expect(recognizeDoubleTap(null, null, 100, 50, DBL_OPTS)).toBe(false);
  });

  it("accepts within window and radius", () => {
    expect(recognizeDoubleTap(100, 50, 250, 52, DBL_OPTS)).toBe(true);
  });

  it("rejects when time delta exceeds the window", () => {
    expect(recognizeDoubleTap(100, 50, 500, 50, DBL_OPTS)).toBe(false);
  });

  it("rejects when Y delta exceeds the radius", () => {
    expect(recognizeDoubleTap(100, 50, 200, 70, DBL_OPTS)).toBe(false);
  });

  it("rejects when nowT precedes lastTapT (clock skew guard)", () => {
    expect(recognizeDoubleTap(200, 50, 100, 50, DBL_OPTS)).toBe(false);
  });

  it("rejects on non-finite coordinates", () => {
    expect(recognizeDoubleTap(100, 50, Number.NaN, 50, DBL_OPTS)).toBe(false);
    expect(recognizeDoubleTap(100, 50, 200, Number.POSITIVE_INFINITY, DBL_OPTS)).toBe(false);
  });

  it("honors a radius of zero", () => {
    const tight = { doubleTapWindowMs: 300, doubleTapRadiusPx: 0 };
    expect(recognizeDoubleTap(100, 50, 200, 50, tight)).toBe(true);
    expect(recognizeDoubleTap(100, 50, 200, 51, tight)).toBe(false);
  });
});
