import { describe, expect, it } from "vitest";
import {
  clampLongPosition,
  clampShortPosition,
  computePositionStats,
  formatPositionLine,
} from "./positionInvariant.js";

describe("clampLongPosition", () => {
  it("leaves valid input untouched (sl < entry < tp)", () => {
    const out = clampLongPosition({ entry: 100, sl: 95, tp: 110 });
    expect(out).toEqual({ entry: 100, sl: 95, tp: 110 });
  });

  it("nudges sl below entry when sl >= entry", () => {
    const out = clampLongPosition({ entry: 100, sl: 100, tp: 110 });
    expect(out.sl).toBeLessThan(out.entry);
    expect(out.entry).toBe(100);
    expect(out.tp).toBe(110);
  });

  it("nudges tp above entry when tp <= entry", () => {
    const out = clampLongPosition({ entry: 100, sl: 95, tp: 100 });
    expect(out.tp).toBeGreaterThan(out.entry);
  });

  it("clamps both when both invariants violated", () => {
    const out = clampLongPosition({ entry: 100, sl: 105, tp: 95 });
    expect(out.sl).toBeLessThan(out.entry);
    expect(out.tp).toBeGreaterThan(out.entry);
  });

  it("with pinned=sl, entry yields to sl + tp yields to entry", () => {
    const out = clampLongPosition({ entry: 95, sl: 100, tp: 90 }, "sl");
    expect(out.sl).toBe(100);
    expect(out.entry).toBeGreaterThan(100);
    expect(out.tp).toBeGreaterThan(out.entry);
  });

  it("with pinned=tp, entry yields to tp + sl yields to entry", () => {
    const out = clampLongPosition({ entry: 110, sl: 120, tp: 100 }, "tp");
    expect(out.tp).toBe(100);
    expect(out.entry).toBeLessThan(100);
    expect(out.sl).toBeLessThan(out.entry);
  });

  it("returns input unchanged when any field is non-finite", () => {
    const inp = { entry: Number.NaN, sl: 90, tp: 110 };
    const out = clampLongPosition(inp);
    expect(out).toEqual(inp);
  });
});

describe("clampShortPosition", () => {
  it("leaves valid input untouched (tp < entry < sl)", () => {
    const out = clampShortPosition({ entry: 100, sl: 105, tp: 90 });
    expect(out).toEqual({ entry: 100, sl: 105, tp: 90 });
  });

  it("nudges sl above entry", () => {
    const out = clampShortPosition({ entry: 100, sl: 100, tp: 90 });
    expect(out.sl).toBeGreaterThan(out.entry);
  });

  it("nudges tp below entry", () => {
    const out = clampShortPosition({ entry: 100, sl: 110, tp: 100 });
    expect(out.tp).toBeLessThan(out.entry);
  });

  it("with pinned=sl, entry+tp yield", () => {
    const out = clampShortPosition({ entry: 110, sl: 100, tp: 110 }, "sl");
    expect(out.sl).toBe(100);
    expect(out.entry).toBeLessThan(100);
    expect(out.tp).toBeLessThan(out.entry);
  });
});

describe("computePositionStats", () => {
  it("computes long-side R:R, percents, deltas", () => {
    const out = computePositionStats({
      entry: 100,
      sl: 90,
      tp: 130,
      qty: 1,
      side: "long",
      displayMode: "rr",
    });
    expect(out.rewardDelta).toBe(30);
    expect(out.riskDelta).toBe(10);
    expect(out.riskReward).toBe(3);
    expect(out.rewardPct).toBe(30);
    expect(out.riskPct).toBe(10);
    expect(out.rewardTicks).toBeNull();
    expect(out.riskTicks).toBeNull();
  });

  it("computes short-side stats with mirrored signs", () => {
    const out = computePositionStats({
      entry: 100,
      sl: 110,
      tp: 70,
      qty: 1,
      side: "short",
      displayMode: "rr",
    });
    expect(out.rewardDelta).toBe(30);
    expect(out.riskDelta).toBe(10);
    expect(out.riskReward).toBe(3);
  });

  it("returns Infinity R:R when risk == 0 but reward != 0", () => {
    const out = computePositionStats({
      entry: 100,
      sl: 100,
      tp: 110,
      qty: 1,
      side: "long",
      displayMode: "rr",
    });
    expect(out.riskReward).toBe(Number.POSITIVE_INFINITY);
  });

  it("returns null R:R when both legs are zero", () => {
    const out = computePositionStats({
      entry: 100,
      sl: 100,
      tp: 100,
      qty: 1,
      side: "long",
      displayMode: "rr",
    });
    expect(out.riskReward).toBeNull();
  });

  it("computes ticks when tickSize > 0", () => {
    const out = computePositionStats({
      entry: 100,
      sl: 99.75,
      tp: 100.5,
      qty: 1,
      side: "long",
      displayMode: "ticks",
      tickSize: 0.25,
    });
    expect(out.rewardTicks).toBe(2);
    expect(out.riskTicks).toBe(1);
  });

  it("returns null ticks when tickSize is non-positive or NaN", () => {
    const out = computePositionStats({
      entry: 100,
      sl: 99,
      tp: 101,
      qty: 1,
      side: "long",
      displayMode: "ticks",
      tickSize: 0,
    });
    expect(out.rewardTicks).toBeNull();
    expect(out.riskTicks).toBeNull();
  });

  it("returns null percents when entry is 0", () => {
    const out = computePositionStats({
      entry: 0,
      sl: -1,
      tp: 1,
      qty: 1,
      side: "long",
      displayMode: "percent",
    });
    expect(out.rewardPct).toBeNull();
    expect(out.riskPct).toBeNull();
  });

  it("returns NaN/null bundle when any input is non-finite", () => {
    const out = computePositionStats({
      entry: Number.NaN,
      sl: 90,
      tp: 110,
      qty: 1,
      side: "long",
      displayMode: "rr",
    });
    expect(out.riskReward).toBeNull();
    expect(Number.isNaN(out.rewardDelta)).toBe(true);
  });
});

describe("formatPositionLine", () => {
  const fmt = (v: number): string => v.toFixed(2);

  it("formats R:R for reward zone", () => {
    const stats = computePositionStats({
      entry: 100, sl: 90, tp: 130, qty: 1, side: "long", displayMode: "rr",
    });
    expect(formatPositionLine(stats, "rr", "reward", fmt)).toBe("R:R 3.00");
  });

  it("formats infinity R:R", () => {
    const stats = computePositionStats({
      entry: 100, sl: 100, tp: 110, qty: 1, side: "long", displayMode: "rr",
    });
    expect(formatPositionLine(stats, "rr", "reward", fmt)).toBe("R:R ∞");
  });

  it("formats price delta on risk side in 'rr' mode", () => {
    const stats = computePositionStats({
      entry: 100, sl: 90, tp: 130, qty: 1, side: "long", displayMode: "rr",
    });
    expect(formatPositionLine(stats, "rr", "risk", fmt)).toBe("+10.00");
  });

  it("formats percent mode", () => {
    const stats = computePositionStats({
      entry: 100, sl: 90, tp: 130, qty: 1, side: "long", displayMode: "percent",
    });
    expect(formatPositionLine(stats, "percent", "reward", fmt)).toBe("+30.00%");
  });

  it("formats ticks mode", () => {
    const stats = computePositionStats({
      entry: 100, sl: 99.75, tp: 100.5, qty: 1, side: "long", displayMode: "ticks", tickSize: 0.25,
    });
    expect(formatPositionLine(stats, "ticks", "reward", fmt)).toBe("+2t");
  });

  it("returns em-dash when value is non-finite", () => {
    const stats = computePositionStats({
      entry: Number.NaN, sl: 90, tp: 110, qty: 1, side: "long", displayMode: "rr",
    });
    expect(formatPositionLine(stats, "rr", "reward", fmt)).toBe("—");
  });
});
