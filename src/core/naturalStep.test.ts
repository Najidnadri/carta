import { describe, expect, it } from "vitest";
import {
  NATURAL_STEPS_MS,
  generateTickCandidates,
  pickNaturalStep,
} from "./naturalStep.js";

const SEC = 1_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("pickNaturalStep", () => {
  it("1s bars @ 200 px wide (≈ 200 bars, 1 px/bar) picks coarse step", () => {
    const step = pickNaturalStep(1, SEC);
    expect(step).toBeGreaterThanOrEqual(SEC);
    expect(NATURAL_STEPS_MS).toContain(step);
  });

  it("1s bars @ 3000 px (≈ 30 px/bar) picks fine step", () => {
    const step = pickNaturalStep(30, SEC);
    expect(step).toBeGreaterThanOrEqual(SEC);
    expect(step).toBeLessThanOrEqual(30 * SEC);
  });

  it("1m bars @ 1200 px picks a minute-scale step", () => {
    const step = pickNaturalStep(8, MIN);
    expect(step).toBeGreaterThanOrEqual(MIN);
  });

  it("1h bars @ 600 px picks an hour-scale step", () => {
    const step = pickNaturalStep(20, HOUR);
    expect(step).toBeGreaterThanOrEqual(HOUR);
  });

  it("1d bars @ 400 px picks a day-or-week step", () => {
    const step = pickNaturalStep(10, DAY);
    expect(step).toBeGreaterThanOrEqual(DAY);
  });

  it("exotic interval (17s) returns a valid table entry", () => {
    const step = pickNaturalStep(5, 17 * SEC);
    expect(NATURAL_STEPS_MS).toContain(step);
    expect(step).toBeGreaterThanOrEqual(17 * SEC);
  });

  it("picked step satisfies the collision constraint", () => {
    const barSpacingPx = 8;
    const interval = MIN;
    const minLabelPx = 80;
    const step = pickNaturalStep(barSpacingPx, interval, minLabelPx);
    const labelSpacingPx = (step / interval) * barSpacingPx;
    expect(labelSpacingPx).toBeGreaterThanOrEqual(minLabelPx - 1e-6);
  });

  it("returns largest entry when barSpacingPx is 0 or negative", () => {
    expect(pickNaturalStep(0, MIN)).toBe(NATURAL_STEPS_MS[NATURAL_STEPS_MS.length - 1]);
    expect(pickNaturalStep(-1, MIN)).toBe(NATURAL_STEPS_MS[NATURAL_STEPS_MS.length - 1]);
    expect(pickNaturalStep(Number.NaN, MIN)).toBe(NATURAL_STEPS_MS[NATURAL_STEPS_MS.length - 1]);
  });
});

describe("generateTickCandidates", () => {
  it("emits ticks at the chosen natural step, inside the window", () => {
    const firstSlot = 0;
    const ticks = generateTickCandidates(0, 10 * MIN, MIN, 5 * MIN, firstSlot);
    expect(ticks.map((t) => Number(t.time))).toEqual([0, 5 * MIN, 10 * MIN]);
  });

  it("snaps exotic-interval ticks to the nearest bar slot", () => {
    const interval = 17 * SEC;
    const firstSlot = 0;
    const step = MIN;
    const ticks = generateTickCandidates(0, 5 * MIN, interval, step, firstSlot);
    for (const tick of ticks) {
      const offset = Number(tick.time) - firstSlot;
      expect(offset % interval).toBe(0);
    }
  });

  it("dedupes adjacent identical snap results", () => {
    const interval = 3 * MIN;
    const firstSlot = 0;
    const step = MIN;
    const ticks = generateTickCandidates(0, 10 * MIN, interval, step, firstSlot);
    const times = ticks.map((t) => Number(t.time));
    expect(new Set(times).size).toBe(times.length);
  });

  it("returns empty on invalid input (graceful)", () => {
    expect(generateTickCandidates(Number.NaN, 10, MIN, MIN, 0)).toEqual([]);
    expect(generateTickCandidates(0, 10, 0, MIN, 0)).toEqual([]);
    expect(generateTickCandidates(100, 0, MIN, MIN, 0)).toEqual([]);
  });

  it("ticks are monotonically increasing", () => {
    const ticks = generateTickCandidates(0, DAY, MIN, HOUR, 0);
    for (let i = 1; i < ticks.length; i++) {
      const prev = ticks[i - 1];
      const curr = ticks[i];
      if (prev === undefined || curr === undefined) {
        throw new Error("unexpected undefined tick");
      }
      expect(Number(curr.time)).toBeGreaterThan(Number(prev.time));
    }
  });
});
