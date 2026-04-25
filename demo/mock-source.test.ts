import { describe, expect, it } from "vitest";
import { MockSource, computePivotMarkers } from "./mock-source.js";
import { asPrice, asTime, type OhlcRecord } from "../src/index.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ANCHOR = Date.UTC(2026, 3, 19, 12, 0, 0);

describe("MockSource.fetchOhlc", () => {
  it("is deterministic across calls for the same (interval, start, end)", () => {
    const src = new MockSource();
    const a = src.fetchOhlc(MIN, ANCHOR, ANCHOR + 10 * MIN);
    const b = src.fetchOhlc(MIN, ANCHOR, ANCHOR + 10 * MIN);
    expect(a).toEqual(b);
    expect(a.length).toBe(11);
  });

  it("returns bars sorted ascending and aligned to intervalDuration", () => {
    const src = new MockSource();
    const bars = src.fetchOhlc(5 * MIN, ANCHOR, ANCHOR + HOUR);
    for (let i = 1; i < bars.length; i++) {
      const prev = bars[i - 1];
      const curr = bars[i];
      if (prev === undefined || curr === undefined) {
        throw new Error("hole");
      }
      expect(Number(curr.time)).toBeGreaterThan(Number(prev.time));
      expect(Number(curr.time) % (5 * MIN)).toBe(0);
    }
  });

  it("aggregates 1m bars into 1h with first.open / max(high) / min(low) / last.close / sum(volume)", () => {
    const src = new MockSource();
    const oneMin = src.fetchOhlc(MIN, ANCHOR, ANCHOR + 59 * MIN);
    const oneHour = src.fetchOhlc(HOUR, ANCHOR, ANCHOR);
    expect(oneHour.length).toBe(1);
    const hourBar = oneHour[0];
    if (hourBar === undefined || oneMin.length !== 60) {
      throw new Error("setup");
    }
    let highMax = -Infinity;
    let lowMin = Infinity;
    let volSum = 0;
    for (const b of oneMin) {
      const h = Number(b.high);
      const l = Number(b.low);
      if (h > highMax) {
        highMax = h;
      }
      if (l < lowMin) {
        lowMin = l;
      }
      volSum += b.volume ?? 0;
    }
    const first = oneMin[0];
    const last = oneMin[oneMin.length - 1];
    if (first === undefined || last === undefined) {
      throw new Error("setup-2");
    }
    expect(Number(hourBar.open)).toBeCloseTo(Number(first.open), 6);
    expect(Number(hourBar.close)).toBeCloseTo(Number(last.close), 6);
    expect(Number(hourBar.high)).toBeCloseTo(highMax, 6);
    expect(Number(hourBar.low)).toBeCloseTo(lowMin, 6);
    expect(hourBar.volume).toBe(volSum);
  });

  it("returns [] for non-minute-aligned intervals", () => {
    const src = new MockSource();
    expect(src.fetchOhlc(7_000, ANCHOR, ANCHOR + 100_000)).toEqual([]);
  });

  it("returns [] when start > end", () => {
    const src = new MockSource();
    expect(src.fetchOhlc(MIN, ANCHOR + MIN, ANCHOR)).toEqual([]);
  });
});

describe("MockSource.fetchVolume", () => {
  it("emits a point per bar with up/down color", () => {
    const src = new MockSource();
    const bars = src.fetchOhlc(MIN, ANCHOR, ANCHOR + 5 * MIN);
    const pts = src.fetchVolume(MIN, ANCHOR, ANCHOR + 5 * MIN);
    expect(pts.length).toBe(bars.length);
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const p = pts[i];
      if (b === undefined || p === undefined) {
        continue;
      }
      const expectedColor = Number(b.close) >= Number(b.open) ? 0x00e676 : 0xff1744;
      expect(p.color).toBe(expectedColor);
      expect(Number(p.time)).toBe(Number(b.time));
    }
  });
});

describe("MockSource.fetchSma", () => {
  it("returns at most one record when the requested range covers a single bar", () => {
    const src = new MockSource();
    const out = src.fetchSma(MIN, ANCHOR, ANCHOR, 20);
    // Fetch range covers 1 bar; padding gives the SMA a 20-bar warm-up so
    // exactly one point at time = ANCHOR is in-range.
    expect(out.length).toBe(1);
    expect(Number(out[0]?.time)).toBe(ANCHOR);
  });

  it("emits SMA points covering the requested range", () => {
    const src = new MockSource();
    const out = src.fetchSma(MIN, ANCHOR, ANCHOR + 30 * MIN, 20);
    expect(out.length).toBeGreaterThan(0);
    for (const p of out) {
      const t = Number(p.time);
      expect(t).toBeGreaterThanOrEqual(ANCHOR);
      expect(t).toBeLessThanOrEqual(ANCHOR + 30 * MIN);
    }
  });

  it("is self-sufficient — does not depend on chart cache", () => {
    const src = new MockSource();
    const a = src.fetchSma(MIN, ANCHOR, ANCHOR + 30 * MIN, 20);
    const b = src.fetchSma(MIN, ANCHOR, ANCHOR + 30 * MIN, 20);
    expect(a).toEqual(b);
  });
});

describe("MockSource.fetchEvents", () => {
  it("emits MarkerRecords with matching shape/position invariants", () => {
    const src = new MockSource();
    const marks = src.fetchEvents(MIN, ANCHOR, ANCHOR + DAY);
    for (const m of marks) {
      expect(m.shape === "arrowDown" || m.shape === "arrowUp").toBe(true);
      if (m.shape === "arrowDown") {
        expect(m.position).toBe("above");
      } else {
        expect(m.position).toBe("below");
      }
    }
  });
});

describe("MockSource.tickOhlc", () => {
  it("extends the latest bar when prev.time === current barTime", () => {
    const src = new MockSource();
    const prev: OhlcRecord = {
      time: asTime(ANCHOR),
      open: asPrice(100),
      high: asPrice(102),
      low: asPrice(99),
      close: asPrice(101),
      volume: 500,
    };
    // now is 30s after barTime — same minute, so extend.
    const t = src.tickOhlc(MIN, ANCHOR + 30_000, prev);
    expect(Number(t.time)).toBe(ANCHOR);
    expect(Number(t.open)).toBe(100); // open is preserved
    // high/low must include prev's range
    expect(Number(t.high)).toBeGreaterThanOrEqual(102);
    expect(Number(t.low)).toBeLessThanOrEqual(99);
  });

  it("appends a new bar when now crosses the boundary", () => {
    const src = new MockSource();
    const prev: OhlcRecord = {
      time: asTime(ANCHOR),
      open: asPrice(100),
      high: asPrice(102),
      low: asPrice(99),
      close: asPrice(101),
      volume: 500,
    };
    const t = src.tickOhlc(MIN, ANCHOR + MIN + 5_000, prev);
    expect(Number(t.time)).toBe(ANCHOR + MIN);
    // open of new bar = prev.close (continuity)
    expect(Number(t.open)).toBeCloseTo(101, 6);
  });

  it("anchors to basePrice when prev is null", () => {
    const src = new MockSource({ basePrice: 200 });
    const t = src.tickOhlc(MIN, ANCHOR, null);
    expect(Number(t.open)).toBeCloseTo(200, 6);
  });

  it("falls back to basePrice when prev is malformed (NaN OHLC fields)", () => {
    const src = new MockSource({ basePrice: 150 });
    const malformed: OhlcRecord = {
      time: asTime(ANCHOR),
      open: asPrice(NaN),
      high: asPrice(NaN),
      low: asPrice(NaN),
      close: asPrice(NaN),
      volume: 0,
    };
    const t = src.tickOhlc(MIN, ANCHOR, malformed);
    expect(Number.isFinite(Number(t.open))).toBe(true);
    expect(Number.isFinite(Number(t.high))).toBe(true);
    expect(Number.isFinite(Number(t.low))).toBe(true);
    expect(Number.isFinite(Number(t.close))).toBe(true);
    expect(Number(t.open)).toBeCloseTo(150, 6);
  });
});

describe("MockSource.tickVolume", () => {
  it("emits a green volume when close ≥ open", () => {
    const src = new MockSource();
    const ohlc: OhlcRecord = {
      time: asTime(ANCHOR),
      open: asPrice(100),
      high: asPrice(105),
      low: asPrice(99),
      close: asPrice(104),
      volume: 1000,
    };
    const v = src.tickVolume(MIN, ANCHOR, ohlc);
    expect(v.color).toBe(0x00e676);
    expect(Number(v.time)).toBe(ANCHOR);
  });

  it("emits a red volume when close < open", () => {
    const src = new MockSource();
    const ohlc: OhlcRecord = {
      time: asTime(ANCHOR),
      open: asPrice(100),
      high: asPrice(105),
      low: asPrice(95),
      close: asPrice(96),
      volume: 1000,
    };
    const v = src.tickVolume(MIN, ANCHOR, ohlc);
    expect(v.color).toBe(0xff1744);
  });
});

describe("computePivotMarkers", () => {
  it("returns [] for fewer than 5 bars", () => {
    expect(computePivotMarkers([])).toEqual([]);
    expect(computePivotMarkers(Array.from({ length: 4 }, (_, i) => mkBar(i, 100)))).toEqual([]);
  });

  it("flags a strict local high as arrowDown / above", () => {
    const bars: OhlcRecord[] = [
      mkBar(0, 100, 100, 99),
      mkBar(1, 100, 101, 99),
      mkBar(2, 100, 105, 99), // peak at idx 2
      mkBar(3, 100, 101, 99),
      mkBar(4, 100, 100, 99),
    ];
    const marks = computePivotMarkers(bars);
    expect(marks.length).toBe(1);
    const m = marks[0];
    if (m === undefined) {
      throw new Error("setup");
    }
    expect(m.shape).toBe("arrowDown");
    expect(m.position).toBe("above");
    expect(Number(m.time)).toBe(2);
  });
});

function mkBar(time: number, openClose: number, high?: number, low?: number): OhlcRecord {
  return {
    time: asTime(time),
    open: asPrice(openClose),
    high: asPrice(high ?? openClose),
    low: asPrice(low ?? openClose),
    close: asPrice(openClose),
  };
}
