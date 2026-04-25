import { beforeEach, describe, expect, it } from "vitest";
import { IntervalCache } from "./IntervalCache.js";
import { noopLogger } from "./Logger.js";
import {
  asPrice,
  asTime,
  type Logger,
  type MarkerRecord,
  type OhlcRecord,
  type PointRecord,
} from "../types.js";

const MINUTE = 60_000;

function mockLogger(): Logger & { warnings: unknown[][] } {
  const warnings: unknown[][] = [];
  return {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (...args: readonly unknown[]): void => {
      warnings.push([...args]);
    },
    error: (): void => undefined,
    warnings,
  } as Logger & { warnings: unknown[][] };
}

function ohlc(timeMs: number, price = 100): OhlcRecord {
  return {
    time: asTime(timeMs),
    open: asPrice(price),
    high: asPrice(price + 1),
    low: asPrice(price - 1),
    close: asPrice(price + 0.5),
  };
}

function point(timeMs: number, value = 50): PointRecord {
  return { time: asTime(timeMs), value: asPrice(value) };
}

function marker(timeMs: number): MarkerRecord {
  return { time: asTime(timeMs), position: "above", shape: "circle" };
}

const DEFAULT_OPTS = { cap: 500_000, slack: 1_000 };

describe("IntervalCache — basic insert + recordsInRange (OHLC)", () => {
  let cache: IntervalCache<OhlcRecord>;
  beforeEach(() => {
    cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
  });

  it("starts empty", () => {
    expect(cache.size()).toBe(0);
    expect(cache.revision).toBe(0);
    expect(cache.recordsInRange(0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("inserts a single aligned record", () => {
    const accepted = cache.insert(ohlc(MINUTE));
    expect(accepted).toBe(true);
    expect(cache.size()).toBe(1);
    expect(cache.revision).toBe(1);
    expect(cache.getAt(MINUTE)).toBeDefined();
  });

  it("round-trips bulk OHLC records in inclusive-inclusive range", () => {
    const records = Array.from({ length: 10 }, (_, i) => ohlc((i + 1) * MINUTE, 100 + i));
    cache.insertMany(records);
    expect(cache.size()).toBe(10);
    const slice = cache.recordsInRange(MINUTE, 10 * MINUTE);
    expect(slice).toHaveLength(10);
    expect(slice.map((r) => Number(r.time))).toEqual(records.map((r) => Number(r.time)));
  });

  it("returns [] for degenerate window (start > end)", () => {
    cache.insertMany([ohlc(MINUTE), ohlc(2 * MINUTE)]);
    expect(cache.recordsInRange(2 * MINUTE, MINUTE)).toEqual([]);
  });

  it("returns fresh arrays that host can mutate", () => {
    cache.insertMany([ohlc(MINUTE), ohlc(2 * MINUTE)]);
    const slice = cache.recordsInRange(MINUTE, 2 * MINUTE) as OhlcRecord[];
    slice.length = 0;
    expect(cache.size()).toBe(2);
  });
});

describe("IntervalCache — overwrite dedup", () => {
  it("overwrites same-time record; size unchanged; revision bumps", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
    cache.insert(ohlc(MINUTE, 100));
    const r1 = cache.revision;
    cache.insert(ohlc(MINUTE, 200));
    expect(cache.size()).toBe(1);
    expect(cache.revision).toBe(r1 + 1);
    const got = cache.getAt(MINUTE);
    expect(got).toBeDefined();
    expect(Number(got?.open)).toBe(200);
  });

  it("last-write-wins across insertMany within the same batch", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
    cache.insertMany([ohlc(MINUTE, 100), ohlc(MINUTE, 200), ohlc(MINUTE, 300)]);
    expect(cache.size()).toBe(1);
    expect(Number(cache.getAt(MINUTE)?.open)).toBe(300);
  });
});

describe("IntervalCache — two-pointer merge", () => {
  let cache: IntervalCache<OhlcRecord>;
  beforeEach(() => {
    cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
    cache.insertMany([ohlc(MINUTE), ohlc(3 * MINUTE), ohlc(5 * MINUTE)]);
  });

  it("handles disjoint right-append", () => {
    cache.insertMany([ohlc(7 * MINUTE), ohlc(9 * MINUTE)]);
    expect(cache.size()).toBe(5);
    expect(cache.recordsInRange(0, 10 * MINUTE)).toHaveLength(5);
  });

  it("handles disjoint left-prepend", () => {
    cache.insertMany([ohlc(-3 * MINUTE), ohlc(-MINUTE)]);
    expect(cache.size()).toBe(5);
    const slice = cache.recordsInRange(-10 * MINUTE, 10 * MINUTE);
    expect(slice.map((r) => Number(r.time))).toEqual([
      -3 * MINUTE,
      -MINUTE,
      MINUTE,
      3 * MINUTE,
      5 * MINUTE,
    ]);
  });

  it("handles interleaved merge", () => {
    cache.insertMany([ohlc(2 * MINUTE), ohlc(4 * MINUTE), ohlc(6 * MINUTE)]);
    expect(cache.size()).toBe(6);
    const times = cache.recordsInRange(0, 10 * MINUTE).map((r) => Number(r.time));
    expect(times).toEqual([MINUTE, 2 * MINUTE, 3 * MINUTE, 4 * MINUTE, 5 * MINUTE, 6 * MINUTE]);
  });

  it("handles full overlap (all incoming overwrite existing)", () => {
    cache.insertMany([ohlc(MINUTE, 999), ohlc(3 * MINUTE, 999), ohlc(5 * MINUTE, 999)]);
    expect(cache.size()).toBe(3);
    expect(Number(cache.getAt(MINUTE)?.open)).toBe(999);
    expect(Number(cache.getAt(3 * MINUTE)?.open)).toBe(999);
    expect(Number(cache.getAt(5 * MINUTE)?.open)).toBe(999);
  });

  it("handles unsorted incoming", () => {
    cache.insertMany([ohlc(8 * MINUTE), ohlc(4 * MINUTE), ohlc(6 * MINUTE)]);
    expect(cache.size()).toBe(6);
  });
});

describe("IntervalCache — eviction", () => {
  it("evicts overflow + slack once cap is exceeded", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: { cap: 10, slack: 3 },
      logger: noopLogger,
    });
    const records = Array.from({ length: 12 }, (_, i) => ohlc((i + 1) * MINUTE));
    cache.insertMany(records);
    expect(cache.size()).toBeLessThanOrEqual(10);
    expect(cache.size()).toBe(12 - (2 + 3));
  });

  it("evicts the oldest records (smallest time first)", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: { cap: 5, slack: 2 },
      logger: noopLogger,
    });
    const records = Array.from({ length: 8 }, (_, i) => ohlc((i + 1) * MINUTE));
    cache.insertMany(records);
    expect(cache.getAt(MINUTE)).toBeUndefined();
    expect(cache.getAt(2 * MINUTE)).toBeUndefined();
    expect(cache.getAt(3 * MINUTE)).toBeUndefined();
    expect(cache.getAt(6 * MINUTE)).toBeDefined();
    expect(cache.getAt(8 * MINUTE)).toBeDefined();
  });

  it("revision bumps on eviction", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: { cap: 2, slack: 0 },
      logger: noopLogger,
    });
    cache.insert(ohlc(MINUTE));
    const r1 = cache.revision;
    cache.insert(ohlc(2 * MINUTE));
    cache.insert(ohlc(3 * MINUTE));
    expect(cache.revision).toBeGreaterThan(r1);
    expect(cache.size()).toBeLessThanOrEqual(2);
  });
});

describe("IntervalCache — alignment (OHLC / point)", () => {
  it("drops unaligned OHLC records with logger.warn", () => {
    const log = mockLogger();
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: log,
    });
    const ok = cache.insert(ohlc(MINUTE));
    const bad = cache.insert(ohlc(MINUTE + 37));
    expect(ok).toBe(true);
    expect(bad).toBe(false);
    expect(cache.size()).toBe(1);
    expect(log.warnings.length).toBe(1);
  });

  it("drops non-finite time records", () => {
    const log = mockLogger();
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: log,
    });
    expect(cache.insert(ohlc(Number.NaN))).toBe(false);
    expect(cache.insert(ohlc(Number.POSITIVE_INFINITY))).toBe(false);
    expect(cache.size()).toBe(0);
    expect(log.warnings.length).toBe(2);
  });

  it("sampled fast path: all-aligned batch skips per-record check", () => {
    const log = mockLogger();
    const cache = new IntervalCache<PointRecord>({
      interval: MINUTE,
      kind: "point",
      options: DEFAULT_OPTS,
      logger: log,
    });
    const records = Array.from({ length: 64 }, (_, i) => point((i + 1) * MINUTE));
    cache.insertMany(records);
    expect(cache.size()).toBe(64);
    expect(log.warnings.length).toBe(0);
  });

  it("sampled check miss: falls back to per-record filter (index 47 misaligned)", () => {
    const log = mockLogger();
    const cache = new IntervalCache<PointRecord>({
      interval: MINUTE,
      kind: "point",
      options: DEFAULT_OPTS,
      logger: log,
    });
    const records = Array.from({ length: 100 }, (_, i) => point((i + 1) * MINUTE));
    // Index 47 is not a sampled index (0, 99, or multiple of 16). We keep it
    // aligned, but index 48 (multiple of 16 + offset) would be hit. Instead,
    // offset index 16 (a sampled index) so the fallback kicks in.
    (records[16] as unknown as { time: number }).time = 16 * MINUTE + 17;
    cache.insertMany(records);
    expect(cache.size()).toBe(99);
    expect(log.warnings.length).toBeGreaterThan(0);
  });

  it("markers accept unaligned times", () => {
    const cache = new IntervalCache<MarkerRecord>({
      interval: MINUTE,
      kind: "marker",
      options: { cap: 50_000, slack: 1_000 },
      logger: noopLogger,
    });
    expect(cache.insert(marker(12345))).toBe(true);
    expect(cache.insert(marker(67890))).toBe(true);
    expect(cache.size()).toBe(2);
  });

  it("markers reject non-finite times", () => {
    const log = mockLogger();
    const cache = new IntervalCache<MarkerRecord>({
      interval: MINUTE,
      kind: "marker",
      options: { cap: 50_000, slack: 1_000 },
      logger: log,
    });
    expect(cache.insert(marker(Number.NaN))).toBe(false);
    expect(cache.size()).toBe(0);
    expect(log.warnings.length).toBe(1);
  });
});

describe("IntervalCache — revision counter", () => {
  it("stays stable across recordsInRange calls", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
    cache.insertMany([ohlc(MINUTE), ohlc(2 * MINUTE)]);
    const r = cache.revision;
    cache.recordsInRange(0, 10 * MINUTE);
    cache.recordsInRange(0, 10 * MINUTE);
    expect(cache.revision).toBe(r);
  });

  it("bumps on clear when non-empty; does not bump when already empty", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
    const r0 = cache.revision;
    cache.clear();
    expect(cache.revision).toBe(r0);
    cache.insert(ohlc(MINUTE));
    const r1 = cache.revision;
    cache.clear();
    expect(cache.revision).toBe(r1 + 1);
  });
});

describe("IntervalCache — adversarial edge cases", () => {
  it("cap = 0 does not infinite-loop; evicts clamped to size", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: { cap: 0, slack: 1000 },
      logger: noopLogger,
    });
    cache.insert(ohlc(MINUTE));
    expect(cache.size()).toBe(0);
  });

  it("eviction does not fire at size === cap; fires at size === cap + 1", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: { cap: 3, slack: 1 },
      logger: noopLogger,
    });
    cache.insertMany([ohlc(MINUTE), ohlc(2 * MINUTE), ohlc(3 * MINUTE)]);
    expect(cache.size()).toBe(3);
    cache.insert(ohlc(4 * MINUTE));
    expect(cache.size()).toBe(2);
  });

  it("triple-duplicate times collapse to a single record (last-write-wins)", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
    cache.insertMany([
      ohlc(MINUTE, 1),
      ohlc(MINUTE, 2),
      ohlc(MINUTE, 3),
      ohlc(MINUTE, 4),
    ]);
    expect(cache.size()).toBe(1);
    expect(Number(cache.getAt(MINUTE)?.open)).toBe(4);
  });

  it("internal invariant: _times.length === byTime.size after mutations", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
    cache.insertMany(Array.from({ length: 10 }, (_, i) => ohlc((i + 1) * MINUTE)));
    cache.insert(ohlc(3 * MINUTE, 999));
    cache.insert(ohlc(11 * MINUTE));
    expect(cache.size()).toBe(11);
    const slice = cache.recordsInRange(MINUTE, 11 * MINUTE);
    expect(slice).toHaveLength(11);
  });

  it("NaN time: rejected (covers Infinity % iv → NaN !== 0)", () => {
    const log = mockLogger();
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: log,
    });
    expect(cache.insert(ohlc(Number.NEGATIVE_INFINITY))).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("reversed batch is sorted before merge", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
    const records = Array.from({ length: 20 }, (_, i) => ohlc((20 - i) * MINUTE));
    cache.insertMany(records);
    expect(cache.size()).toBe(20);
    const slice = cache.recordsInRange(MINUTE, 20 * MINUTE);
    const times = slice.map((r) => Number(r.time));
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1] as number);
    }
  });
});

describe("IntervalCache — first/last time helpers (cycle B)", () => {
  it("firstTime / lastTime return null when empty", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
    expect(cache.firstTime()).toBeNull();
    expect(cache.lastTime()).toBeNull();
  });

  it("firstTime === lastTime === only record for a single-element cache", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
    cache.insert(ohlc(7 * MINUTE));
    expect(cache.firstTime()).toBe(7 * MINUTE);
    expect(cache.lastTime()).toBe(7 * MINUTE);
  });

  it("firstTime tracks smallest time, lastTime tracks largest after inserts", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
    cache.insertMany([ohlc(5 * MINUTE), ohlc(10 * MINUTE), ohlc(1 * MINUTE)]);
    expect(cache.firstTime()).toBe(1 * MINUTE);
    expect(cache.lastTime()).toBe(10 * MINUTE);
  });

  it("firstTime / lastTime return null again after clear()", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
    cache.insert(ohlc(2 * MINUTE));
    cache.clear();
    expect(cache.firstTime()).toBeNull();
    expect(cache.lastTime()).toBeNull();
  });

  it("firstTime advances after evictOldest; lastTime stable", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
    cache.insertMany([ohlc(1 * MINUTE), ohlc(2 * MINUTE), ohlc(3 * MINUTE)]);
    cache.evictOldest(1);
    expect(cache.firstTime()).toBe(2 * MINUTE);
    expect(cache.lastTime()).toBe(3 * MINUTE);
  });
});

describe("IntervalCache — first/last in range (cycle B)", () => {
  function build(times: readonly number[]): IntervalCache<OhlcRecord> {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
    cache.insertMany(times.map((t) => ohlc(t)));
    return cache;
  }

  it("returns null when the cache is empty", () => {
    const cache = build([]);
    expect(cache.firstTimeInRange(0, 10 * MINUTE)).toBeNull();
    expect(cache.lastTimeInRange(0, 10 * MINUTE)).toBeNull();
  });

  it("returns null when the range excludes every cached point", () => {
    const cache = build([5 * MINUTE, 6 * MINUTE]);
    expect(cache.firstTimeInRange(10 * MINUTE, 20 * MINUTE)).toBeNull();
    expect(cache.lastTimeInRange(10 * MINUTE, 20 * MINUTE)).toBeNull();
    expect(cache.firstTimeInRange(1 * MINUTE, 4 * MINUTE)).toBeNull();
    expect(cache.lastTimeInRange(1 * MINUTE, 4 * MINUTE)).toBeNull();
  });

  it("returns inclusive boundary matches on both ends", () => {
    const cache = build([5 * MINUTE, 6 * MINUTE, 7 * MINUTE]);
    expect(cache.firstTimeInRange(5 * MINUTE, 5 * MINUTE)).toBe(5 * MINUTE);
    expect(cache.lastTimeInRange(7 * MINUTE, 7 * MINUTE)).toBe(7 * MINUTE);
    expect(cache.firstTimeInRange(5 * MINUTE, 7 * MINUTE)).toBe(5 * MINUTE);
    expect(cache.lastTimeInRange(5 * MINUTE, 7 * MINUTE)).toBe(7 * MINUTE);
  });

  it("partial overlap returns the innermost data point", () => {
    const cache = build([5 * MINUTE, 6 * MINUTE, 7 * MINUTE]);
    expect(cache.firstTimeInRange(6 * MINUTE, 20 * MINUTE)).toBe(6 * MINUTE);
    expect(cache.lastTimeInRange(0, 6 * MINUTE)).toBe(6 * MINUTE);
  });

  it("returns null for inverted or non-finite ranges", () => {
    const cache = build([5 * MINUTE, 6 * MINUTE, 7 * MINUTE]);
    expect(cache.firstTimeInRange(10, 5)).toBeNull();
    expect(cache.firstTimeInRange(Number.NaN, 10 * MINUTE)).toBeNull();
    expect(cache.lastTimeInRange(Number.NaN, 10 * MINUTE)).toBeNull();
  });
});

describe("IntervalCache — perf spot-check (logged, not asserted)", () => {
  it("inserts 100k sorted OHLC into an empty cache", () => {
    const cache = new IntervalCache<OhlcRecord>({
      interval: MINUTE,
      kind: "ohlc",
      options: DEFAULT_OPTS,
      logger: noopLogger,
    });
    const records = Array.from({ length: 100_000 }, (_, i) => ohlc((i + 1) * MINUTE));
    const t0 = performance.now();
    cache.insertMany(records);
    const dt = performance.now() - t0;
    // Log, don't assert — environment varies. Fail only if >10× budget.
    if (dt > 500) {
       
      console.warn(`[carta perf] insertMany 100k took ${dt.toFixed(2)}ms (>> 50ms budget)`);
    }
    expect(cache.size()).toBe(100_000);
    expect(dt).toBeLessThan(500);
  });
});
