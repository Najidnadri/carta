import { describe, expect, it } from "vitest";
import { IntervalCache } from "./IntervalCache.js";
import { noopLogger } from "./Logger.js";
import {
  asPrice,
  asTime,
  type MarkerRecord,
  type OhlcRecord,
} from "../types.js";

const MINUTE = 60_000;
const DEFAULT = { cap: 500_000, slack: 1_000 };

function makeOhlcCache(): IntervalCache<OhlcRecord> {
  return new IntervalCache<OhlcRecord>({
    interval: MINUTE,
    kind: "ohlc",
    options: DEFAULT,
    logger: noopLogger,
  });
}

function bar(t: number): OhlcRecord {
  return {
    time: asTime(t),
    open: asPrice(1),
    high: asPrice(2),
    low: asPrice(0),
    close: asPrice(1),
  };
}

describe("missingRanges — empty cache", () => {
  it("emits a single range covering [s, e] when cache is empty", () => {
    const cache = makeOhlcCache();
    const ranges = cache.missingRanges(MINUTE, 5 * MINUTE, 1);
    expect(ranges).toEqual([{ start: MINUTE, end: 5 * MINUTE }]);
  });

  it("aligns unaligned start/end via alignDown", () => {
    const cache = makeOhlcCache();
    const ranges = cache.missingRanges(MINUTE + 15, 5 * MINUTE + 42, 1);
    expect(ranges).toEqual([{ start: MINUTE, end: 5 * MINUTE }]);
  });
});

describe("missingRanges — fully cached", () => {
  it("returns [] when every slot in [s,e] is cached", () => {
    const cache = makeOhlcCache();
    cache.insertMany([bar(MINUTE), bar(2 * MINUTE), bar(3 * MINUTE), bar(4 * MINUTE)]);
    expect(cache.missingRanges(MINUTE, 4 * MINUTE, 1)).toEqual([]);
  });
});

describe("missingRanges — single gap in middle", () => {
  it("emits a single range covering the gap", () => {
    const cache = makeOhlcCache();
    cache.insertMany([
      bar(MINUTE),
      bar(2 * MINUTE),
      bar(5 * MINUTE),
      bar(6 * MINUTE),
    ]);
    const ranges = cache.missingRanges(MINUTE, 6 * MINUTE, 1);
    expect(ranges).toEqual([{ start: 3 * MINUTE, end: 4 * MINUTE }]);
  });
});

describe("missingRanges — multiple gaps", () => {
  it("emits N ranges when hits and misses alternate", () => {
    const cache = makeOhlcCache();
    cache.insertMany([bar(MINUTE), bar(3 * MINUTE), bar(5 * MINUTE), bar(7 * MINUTE)]);
    const ranges = cache.missingRanges(MINUTE, 7 * MINUTE, 1);
    expect(ranges).toEqual([
      { start: 2 * MINUTE, end: 2 * MINUTE },
      { start: 4 * MINUTE, end: 4 * MINUTE },
      { start: 6 * MINUTE, end: 6 * MINUTE },
    ]);
  });
});

describe("missingRanges — threshold > 1", () => {
  it("suppresses single-bar gaps when threshold is 2", () => {
    const cache = makeOhlcCache();
    cache.insertMany([bar(MINUTE), bar(3 * MINUTE), bar(5 * MINUTE), bar(7 * MINUTE)]);
    const ranges = cache.missingRanges(MINUTE, 7 * MINUTE, 2);
    expect(ranges).toEqual([]);
  });

  it("emits only gaps >= threshold bars", () => {
    const cache = makeOhlcCache();
    cache.insertMany([
      bar(MINUTE),
      bar(2 * MINUTE),
      bar(7 * MINUTE),
      bar(8 * MINUTE),
    ]);
    const ranges = cache.missingRanges(MINUTE, 8 * MINUTE, 3);
    expect(ranges).toEqual([{ start: 3 * MINUTE, end: 6 * MINUTE }]);
  });
});

describe("missingRanges — degenerate window", () => {
  it("returns [] when start > end", () => {
    const cache = makeOhlcCache();
    cache.insert(bar(MINUTE));
    expect(cache.missingRanges(5 * MINUTE, MINUTE, 1)).toEqual([]);
  });

  it("returns [] for non-finite start/end", () => {
    const cache = makeOhlcCache();
    expect(cache.missingRanges(Number.NaN, MINUTE, 1)).toEqual([]);
    expect(cache.missingRanges(MINUTE, Number.POSITIVE_INFINITY, 1)).toEqual([]);
  });
});

describe("missingRanges — window entirely outside cached data", () => {
  it("window entirely before cached data → single-range emission", () => {
    const cache = makeOhlcCache();
    cache.insert(bar(10 * MINUTE));
    const ranges = cache.missingRanges(MINUTE, 5 * MINUTE, 1);
    expect(ranges).toEqual([{ start: MINUTE, end: 5 * MINUTE }]);
  });

  it("window entirely after cached data → single-range emission", () => {
    const cache = makeOhlcCache();
    cache.insert(bar(MINUTE));
    const ranges = cache.missingRanges(10 * MINUTE, 15 * MINUTE, 1);
    expect(ranges).toEqual([{ start: 10 * MINUTE, end: 15 * MINUTE }]);
  });
});

describe("missingRanges — marker channel", () => {
  it("always returns [] for marker kind", () => {
    const cache = new IntervalCache<MarkerRecord>({
      interval: MINUTE,
      kind: "marker",
      options: { cap: 50_000, slack: 1_000 },
      logger: noopLogger,
    });
    cache.insert({ time: asTime(MINUTE), position: "above", shape: "circle" });
    expect(cache.missingRanges(0, 10 * MINUTE, 1)).toEqual([]);
    expect(cache.missingRanges(MINUTE, 10 * MINUTE, 1)).toEqual([]);
  });
});

describe("missingRanges — fractional interval is rejected", () => {
  it("returns [] when interval is non-integer", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: 60_000.5,
      kind: "ohlc",
      options: DEFAULT,
      logger: noopLogger,
    });
    expect(cache.missingRanges(0, 100_000, 1)).toEqual([]);
  });
});
