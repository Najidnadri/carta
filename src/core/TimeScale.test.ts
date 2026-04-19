import { describe, expect, it } from "vitest";
import { asInterval, asTime } from "../types.js";
import { TimeScale, alignDown } from "./TimeScale.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("alignDown", () => {
  it("floors to the nearest multiple of interval", () => {
    expect(alignDown(100, 60)).toBe(60);
    expect(alignDown(120, 60)).toBe(120);
    expect(alignDown(119, 60)).toBe(60);
  });

  it("handles negative timestamps", () => {
    expect(alignDown(-100, 60)).toBe(-120);
  });
});

describe("TimeScale — valid", () => {
  const scale = new TimeScale({
    startTime: asTime(1_700_000_000_000),
    endTime: asTime(1_700_000_000_000 + DAY),
    intervalDuration: asInterval(MIN),
    pixelWidth: 1200,
  });

  it("projects start → 0 and end → pixelWidth within float tolerance", () => {
    expect(Number(scale.timeToPixel(scale.startTime))).toBeCloseTo(0, 6);
    expect(Number(scale.timeToPixel(scale.endTime))).toBeCloseTo(1200, 6);
  });

  it("pixel ↔ time roundtrips", () => {
    for (const t of [0, 300, 600, 900, 1200]) {
      const asPixelVal = Number(scale.timeToPixel(scale.pixelToTime(t as unknown as never)));
      expect(asPixelVal).toBeCloseTo(t, 4);
    }
  });

  it("visibleBarSlots is monotonic with interval-sized diffs", () => {
    const slots = scale.visibleBarSlots();
    expect(slots.length).toBeGreaterThan(0);
    for (let i = 1; i < slots.length; i++) {
      expect(Number(slots[i]) - Number(slots[i - 1])).toBe(MIN);
    }
  });

  it("slotCount matches floor((end-start)/interval) + 1 at aligned boundaries", () => {
    const slots = scale.visibleBarSlots();
    expect(slots.length).toBe(DAY / MIN + 1);
  });

  it("barSpacingPx equals pixelWidth / bars", () => {
    const bars = DAY / MIN;
    expect(scale.barSpacingPx).toBeCloseTo(1200 / bars, 6);
  });

  it("barIndexAtTime(timeOfBarIndex(i)) === i", () => {
    for (const i of [0, 1, 5, 100, 1000]) {
      expect(scale.barIndexAtTime(scale.timeOfBarIndex(i))).toBe(i);
    }
  });
});

describe("TimeScale — boundaries", () => {
  it("startTime === endTime collapses to one slot", () => {
    const t = 1_700_000_000_000;
    const scale = new TimeScale({
      startTime: asTime(t),
      endTime: asTime(t),
      intervalDuration: asInterval(MIN),
      pixelWidth: 800,
    });
    expect(scale.slotCount).toBe(1);
    expect(scale.barSpacingPx).toBe(0);
  });

  it("pixelWidth === 0 keeps slots but barSpacingPx === 0", () => {
    const scale = new TimeScale({
      startTime: asTime(0),
      endTime: asTime(HOUR),
      intervalDuration: asInterval(MIN),
      pixelWidth: 0,
    });
    expect(scale.slotCount).toBe(61);
    expect(scale.barSpacingPx).toBe(0);
  });

  it("unaligned startTime aligns down to previous slot", () => {
    const scale = new TimeScale({
      startTime: asTime(MIN + 17_000),
      endTime: asTime(2 * MIN + 3_000),
      intervalDuration: asInterval(MIN),
      pixelWidth: 300,
    });
    const slots = scale.visibleBarSlots();
    expect(slots.length).toBe(2);
    expect(Number(slots[0])).toBe(MIN);
    expect(Number(slots[1])).toBe(2 * MIN);
  });
});

describe("TimeScale — degenerate input (graceful)", () => {
  it("intervalDuration <= 0 yields slotCount 0 and valid false", () => {
    const scale = new TimeScale({
      startTime: asTime(0),
      endTime: asTime(HOUR),
      intervalDuration: asInterval(0),
      pixelWidth: 800,
    });
    expect(scale.valid).toBe(false);
    expect(scale.slotCount).toBe(0);
    expect(scale.visibleBarSlots()).toEqual([]);
  });

  it("NaN start/end yields invalid scale", () => {
    const scale = new TimeScale({
      startTime: asTime(Number.NaN),
      endTime: asTime(HOUR),
      intervalDuration: asInterval(MIN),
      pixelWidth: 800,
    });
    expect(scale.valid).toBe(false);
    expect(scale.slotCount).toBe(0);
  });

  it("startTime > endTime yields invalid scale (no auto-swap)", () => {
    const scale = new TimeScale({
      startTime: asTime(HOUR),
      endTime: asTime(0),
      intervalDuration: asInterval(MIN),
      pixelWidth: 800,
    });
    expect(scale.valid).toBe(false);
  });

  it("timeToPixel on invalid returns 0 without crashing", () => {
    const scale = new TimeScale({
      startTime: asTime(Number.NaN),
      endTime: asTime(Number.NaN),
      intervalDuration: asInterval(MIN),
      pixelWidth: 800,
    });
    expect(Number(scale.timeToPixel(asTime(123)))).toBe(0);
  });
});
