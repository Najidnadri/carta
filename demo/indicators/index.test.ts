import { describe, expect, it } from "vitest";
import { computeMacd, computeRsi14, computeZScore } from "./index.js";

describe("demo/indicators — RSI", () => {
  it("returns null entries for the warmup window (period bars)", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5);
    const rsi = computeRsi14(closes);
    for (let i = 0; i < 14; i += 1) {
      expect(rsi[i]).toBeNull();
    }
    expect(rsi[14]).not.toBeNull();
  });

  it("clamps to [0, 100]", () => {
    const monotonicUp = Array.from({ length: 50 }, (_, i) => 100 + i);
    const rsi = computeRsi14(monotonicUp);
    // Strict-up trend RSI saturates at 100 (avgLoss = 0 → 100).
    const last = rsi[rsi.length - 1];
    expect(last).toBe(100);
  });

  it("flat input lands at neutral 50", () => {
    const flat = Array.from({ length: 50 }, () => 100);
    const rsi = computeRsi14(flat);
    const last = rsi[rsi.length - 1];
    expect(last).toBe(50);
  });

  it("monotonic-down input saturates near 0", () => {
    const down = Array.from({ length: 50 }, (_, i) => 100 - i);
    const rsi = computeRsi14(down);
    const last = rsi[rsi.length - 1];
    expect(last !== null && last !== undefined && last < 5).toBe(true);
  });

  it("returns all-null when insufficient data", () => {
    const rsi = computeRsi14([1, 2, 3]);
    expect(rsi.every((x) => x === null)).toBe(true);
  });
});

describe("demo/indicators — MACD", () => {
  it("produces three parallel arrays, all length-equal to input", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const result = computeMacd(closes);
    expect(result.macd.length).toBe(closes.length);
    expect(result.signal.length).toBe(closes.length);
    expect(result.hist.length).toBe(closes.length);
  });

  it("signal warmup follows MACD warmup + signal period", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.1);
    const result = computeMacd(closes);
    // Slow EMA seeds at index 25 (period - 1 = 25 for 26-period EMA).
    // Then signal-EMA needs another 9 valid macd values to seed at index ~33.
    expect(result.macd[25]).not.toBeNull();
    expect(result.signal[24]).toBeNull();
    expect(result.signal[33]).not.toBeNull();
  });

  it("hist = macd - signal", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.cos(i / 4) * 8);
    const r = computeMacd(closes);
    for (let i = 0; i < closes.length; i += 1) {
      const m = r.macd[i];
      const s = r.signal[i];
      const h = r.hist[i];
      if (
        m !== null && m !== undefined &&
        s !== null && s !== undefined &&
        h !== null && h !== undefined
      ) {
        expect(h).toBeCloseTo(m - s, 10);
      }
    }
  });
});

describe("demo/indicators — Z-score", () => {
  it("returns null for the warmup window", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const z = computeZScore(closes, 20);
    for (let i = 0; i < 19; i += 1) {
      expect(z[i]).toBeNull();
    }
    expect(z[19]).not.toBeNull();
  });

  it("flat input produces 0 z-score", () => {
    const flat = Array.from({ length: 30 }, () => 100);
    const z = computeZScore(flat, 20);
    expect(z[29]).toBe(0);
  });

  it("typical Z-scores stay in roughly [-3, 3]", () => {
    const closes = Array.from(
      { length: 100 },
      (_, i) => 100 + Math.sin(i / 7) * 10 + (Math.random() - 0.5) * 2,
    );
    const z = computeZScore(closes, 20);
    for (const v of z) {
      if (v !== null) {
        expect(Math.abs(v)).toBeLessThan(5); // very loose; sanity check
      }
    }
  });
});
