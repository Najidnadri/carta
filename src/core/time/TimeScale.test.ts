import { describe, expect, it } from "vitest";
import { asInterval, asTime } from "../../types.js";
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

describe("TimeScale.snapToBarTime", () => {
  // Minute-aligned start (1_700_000_000_000 % 60_000 = 20_000, so add 40_000
  // to land on a minute boundary). 60 one-minute slots across 1200 px →
  // 20 px per bar. slotCount = 61 because both endpoints align to a slot.
  const startTime = asTime(1_700_000_040_000);
  const endTime = asTime(1_700_000_040_000 + HOUR);
  const scale = new TimeScale({
    startTime,
    endTime,
    intervalDuration: asInterval(MIN),
    pixelWidth: 1200,
  });

  it("snaps to bar centre: mid-plot x → the matching slot time", () => {
    // x=300 → 15 bars in → slot at startTime + 15min
    const snapped = scale.snapToBarTime(300 as unknown as never, 1200);
    expect(snapped).not.toBeNull();
    expect(Number(snapped)).toBe(Number(startTime) + 15 * MIN);
  });

  it("snaps left of midpoint to the lower slot", () => {
    // 20 px per bar; x = 309 is 0.45 bars past slot 15 → rounds to 15.
    const snapped = scale.snapToBarTime(309 as unknown as never, 1200);
    expect(Number(snapped)).toBe(Number(startTime) + 15 * MIN);
  });

  it("snaps right of midpoint to the higher slot", () => {
    // x = 311 is 0.55 bars past slot 15 → rounds up to 16.
    const snapped = scale.snapToBarTime(311 as unknown as never, 1200);
    expect(Number(snapped)).toBe(Number(startTime) + 16 * MIN);
  });

  it("left edge (x=0) snaps to the first slot", () => {
    const snapped = scale.snapToBarTime(0 as unknown as never, 1200);
    expect(Number(snapped)).toBe(Number(startTime));
  });

  it("right edge (x=plotWidth) snaps to the last slot (both endpoints align → 61 slots)", () => {
    const snapped = scale.snapToBarTime(1200 as unknown as never, 1200);
    expect(Number(snapped)).toBe(Number(startTime) + 60 * MIN);
  });

  it("returns null for x < 0", () => {
    expect(scale.snapToBarTime(-1 as unknown as never, 1200)).toBeNull();
  });

  it("returns null for x > plotWidth", () => {
    expect(scale.snapToBarTime(1201 as unknown as never, 1200)).toBeNull();
  });

  it("returns null for non-finite pixelX", () => {
    expect(scale.snapToBarTime(Number.NaN as unknown as never, 1200)).toBeNull();
    expect(scale.snapToBarTime(Number.POSITIVE_INFINITY as unknown as never, 1200)).toBeNull();
  });

  it("returns null when scale is invalid", () => {
    const bad = new TimeScale({
      startTime: asTime(Number.NaN),
      endTime: asTime(Number.NaN),
      intervalDuration: asInterval(MIN),
      pixelWidth: 800,
    });
    expect(bad.snapToBarTime(400 as unknown as never, 800)).toBeNull();
  });

  it("returns null when plotWidth is non-positive or non-finite", () => {
    expect(scale.snapToBarTime(100 as unknown as never, 0)).toBeNull();
    expect(scale.snapToBarTime(100 as unknown as never, -1)).toBeNull();
    expect(scale.snapToBarTime(100 as unknown as never, Number.NaN)).toBeNull();
  });

  it("snapToBarPixel returns { time, x } at the bar centre", () => {
    const result = scale.snapToBarPixel(305 as unknown as never, 1200);
    expect(result).not.toBeNull();
    if (result === null) {return;}
    expect(Number(result.time)).toBe(Number(startTime) + 15 * MIN);
    // slot 15 → 15 × 20 px = 300
    expect(Number(result.x)).toBeCloseTo(300, 6);
  });

  it("snapToBarPixel mirrors snapToBarTime null cases", () => {
    expect(scale.snapToBarPixel(-1 as unknown as never, 1200)).toBeNull();
    expect(scale.snapToBarPixel(1201 as unknown as never, 1200)).toBeNull();
  });
});
