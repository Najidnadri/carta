import { describe, expect, it } from "vitest";
import { DataStore } from "./DataStore.js";
import {
  asPrice,
  asTime,
  type Logger,
  type MarkerRecord,
  type OhlcRecord,
  type PointRecord,
} from "../types.js";

const MINUTE = 60_000;
const FIVE_MIN = 5 * MINUTE;

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

function ohlc(t: number, p = 100): OhlcRecord {
  return {
    time: asTime(t),
    open: asPrice(p),
    high: asPrice(p + 1),
    low: asPrice(p - 1),
    close: asPrice(p + 0.5),
  };
}

function point(t: number, v = 42): PointRecord {
  return { time: asTime(t), value: asPrice(v) };
}

function marker(t: number): MarkerRecord {
  return { time: asTime(t), position: "above", shape: "circle" };
}

describe("DataStore — channel registration", () => {
  it("is idempotent for same-kind redefines", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    store.defineChannel({ id: "primary", kind: "ohlc" });
    expect(store.hasChannel("primary")).toBe(true);
    expect(store.getChannel("primary")?.kind).toBe("ohlc");
  });

  it("throws on kind collision with a descriptive message", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    expect(() => { store.defineChannel({ id: "primary", kind: "point" }); }).toThrow(/ohlc/);
    expect(() => { store.defineChannel({ id: "primary", kind: "point" }); }).toThrow(/point/);
  });

  it("throws on insert for unregistered channel", () => {
    const store = new DataStore();
    expect(() => store.insert("unknown", MINUTE, ohlc(MINUTE))).toThrow(/unregistered/);
    expect(() => store.insertMany("unknown", MINUTE, [ohlc(MINUTE)])).toThrow(/unregistered/);
  });
});

describe("DataStore — kind enforcement at insert", () => {
  it("drops mismatched records at insert with logger.warn", () => {
    const log = mockLogger();
    const store = new DataStore({ logger: log });
    store.defineChannel({ id: "primary", kind: "ohlc" });
    const bad = store.insert("primary", MINUTE, point(MINUTE) as unknown as OhlcRecord);
    expect(bad).toBe(false);
    expect(store.size("primary", MINUTE)).toBe(0);
    expect(log.warnings.length).toBe(1);
  });

  it("drops mismatched records inside insertMany, keeps valid ones", () => {
    const log = mockLogger();
    const store = new DataStore({ logger: log });
    store.defineChannel({ id: "volume", kind: "point" });
    const mixed = [
      point(MINUTE, 10),
      ohlc(2 * MINUTE) as unknown as PointRecord,
      point(3 * MINUTE, 30),
    ];
    const accepted = store.insertMany("volume", MINUTE, mixed);
    expect(accepted).toBe(2);
    expect(store.size("volume", MINUTE)).toBe(2);
    expect(log.warnings.length).toBe(1);
  });
});

describe("DataStore — round-trip across record kinds", () => {
  it("OHLC records", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    const records = Array.from({ length: 5 }, (_, i) => ohlc((i + 1) * MINUTE, 100 + i));
    store.insertMany("primary", MINUTE, records);
    const slice = store.recordsInRange("primary", MINUTE, MINUTE, 5 * MINUTE) as readonly OhlcRecord[];
    expect(slice.map((r) => Number(r.time))).toEqual(records.map((r) => Number(r.time)));
    expect(slice.map((r) => Number(r.open))).toEqual(records.map((r) => Number(r.open)));
  });

  it("Point records", () => {
    const store = new DataStore();
    store.defineChannel({ id: "sma", kind: "point" });
    const records = Array.from({ length: 4 }, (_, i) => point((i + 1) * MINUTE, i * 10));
    store.insertMany("sma", MINUTE, records);
    const slice = store.recordsInRange("sma", MINUTE, MINUTE, 4 * MINUTE) as readonly PointRecord[];
    expect(slice.map((r) => Number(r.value))).toEqual([0, 10, 20, 30]);
  });

  it("Marker records (unaligned times allowed)", () => {
    const store = new DataStore();
    store.defineChannel({ id: "events", kind: "marker" });
    store.insertMany("events", MINUTE, [marker(12_345), marker(67_890)]);
    const slice = store.recordsInRange("events", MINUTE, 0, 100_000) as readonly MarkerRecord[];
    expect(slice).toHaveLength(2);
  });
});

describe("DataStore — cross-channel isolation", () => {
  it("clearChannel only wipes the named channel", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    store.defineChannel({ id: "sma20", kind: "point" });
    store.insertMany("primary", MINUTE, [ohlc(MINUTE), ohlc(2 * MINUTE)]);
    store.insertMany("sma20", MINUTE, [point(MINUTE), point(2 * MINUTE)]);
    store.clearChannel("sma20");
    expect(store.size("primary", MINUTE)).toBe(2);
    expect(store.size("sma20", MINUTE)).toBe(0);
  });
});

describe("DataStore.setInterval — wipe semantics", () => {
  it("wipes only prevIv across every channel when newIv !== prevIv", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    store.defineChannel({ id: "sma", kind: "point" });
    store.insertMany("primary", MINUTE, [ohlc(MINUTE), ohlc(2 * MINUTE)]);
    store.insertMany("primary", FIVE_MIN, [ohlc(FIVE_MIN), ohlc(10 * MINUTE)]);
    store.insertMany("sma", MINUTE, [point(MINUTE)]);
    store.insertMany("sma", FIVE_MIN, [point(FIVE_MIN)]);

    store.setInterval(FIVE_MIN, MINUTE);

    expect(store.size("primary", MINUTE)).toBe(0);
    expect(store.size("primary", FIVE_MIN)).toBe(2);
    expect(store.size("sma", MINUTE)).toBe(0);
    expect(store.size("sma", FIVE_MIN)).toBe(1);
  });

  it("is a no-op when newIv === prevIv", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    store.insertMany("primary", MINUTE, [ohlc(MINUTE), ohlc(2 * MINUTE)]);
    const revBefore = store.revision("primary", MINUTE);
    store.setInterval(MINUTE, MINUTE);
    expect(store.size("primary", MINUTE)).toBe(2);
    expect(store.revision("primary", MINUTE)).toBe(revBefore);
  });

  it("is a no-op when prevIv is null", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    store.insertMany("primary", MINUTE, [ohlc(MINUTE)]);
    store.setInterval(FIVE_MIN, null);
    expect(store.size("primary", MINUTE)).toBe(1);
  });
});

describe("DataStore.clearCache — combinations", () => {
  function seed(store: DataStore): void {
    store.defineChannel({ id: "primary", kind: "ohlc" });
    store.defineChannel({ id: "sma", kind: "point" });
    store.insertMany("primary", MINUTE, [ohlc(MINUTE), ohlc(2 * MINUTE)]);
    store.insertMany("primary", FIVE_MIN, [ohlc(FIVE_MIN)]);
    store.insertMany("sma", MINUTE, [point(MINUTE)]);
    store.insertMany("sma", FIVE_MIN, [point(FIVE_MIN)]);
  }

  it("no args clears everything", () => {
    const store = new DataStore();
    seed(store);
    store.clearCache();
    expect(store.size("primary", MINUTE)).toBe(0);
    expect(store.size("primary", FIVE_MIN)).toBe(0);
    expect(store.size("sma", MINUTE)).toBe(0);
    expect(store.size("sma", FIVE_MIN)).toBe(0);
  });

  it("channelId only clears every interval of that channel", () => {
    const store = new DataStore();
    seed(store);
    store.clearCache({ channelId: "sma" });
    expect(store.size("primary", MINUTE)).toBe(2);
    expect(store.size("primary", FIVE_MIN)).toBe(1);
    expect(store.size("sma", MINUTE)).toBe(0);
    expect(store.size("sma", FIVE_MIN)).toBe(0);
  });

  it("intervalDuration only clears that interval across all channels", () => {
    const store = new DataStore();
    seed(store);
    store.clearCache({ intervalDuration: MINUTE });
    expect(store.size("primary", MINUTE)).toBe(0);
    expect(store.size("sma", MINUTE)).toBe(0);
    expect(store.size("primary", FIVE_MIN)).toBe(1);
    expect(store.size("sma", FIVE_MIN)).toBe(1);
  });

  it("both channelId + intervalDuration clears only that pair", () => {
    const store = new DataStore();
    seed(store);
    store.clearCache({ channelId: "primary", intervalDuration: MINUTE });
    expect(store.size("primary", MINUTE)).toBe(0);
    expect(store.size("primary", FIVE_MIN)).toBe(1);
    expect(store.size("sma", MINUTE)).toBe(1);
    expect(store.size("sma", FIVE_MIN)).toBe(1);
  });
});

describe("DataStore.missingRanges — at store level", () => {
  it("returns full range when the channel has no cache for that interval", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    const ranges = store.missingRanges("primary", MINUTE, MINUTE, 5 * MINUTE);
    expect(ranges).toEqual([{ start: MINUTE, end: 5 * MINUTE }]);
  });

  it("returns [] for unregistered channel", () => {
    const store = new DataStore();
    expect(store.missingRanges("nope", MINUTE, MINUTE, 5 * MINUTE)).toEqual([]);
  });

  it("returns [] for marker channels", () => {
    const store = new DataStore();
    store.defineChannel({ id: "events", kind: "marker" });
    expect(store.missingRanges("events", MINUTE, 0, 10 * MINUTE)).toEqual([]);
  });

  it("delegates to IntervalCache for partial-cache windows", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    store.insertMany("primary", MINUTE, [ohlc(MINUTE), ohlc(2 * MINUTE), ohlc(4 * MINUTE)]);
    const ranges = store.missingRanges("primary", MINUTE, MINUTE, 4 * MINUTE);
    expect(ranges).toEqual([{ start: 3 * MINUTE, end: 3 * MINUTE }]);
  });

  it("honors options.requestThresholdBars", () => {
    const store = new DataStore({ options: { requestThresholdBars: 3 } });
    store.defineChannel({ id: "primary", kind: "ohlc" });
    store.insertMany("primary", MINUTE, [ohlc(MINUTE), ohlc(3 * MINUTE)]);
    // gap of 1 bar at 2*MINUTE; threshold is 3 → suppressed
    const ranges = store.missingRanges("primary", MINUTE, MINUTE, 3 * MINUTE);
    expect(ranges).toEqual([]);
  });
});

describe("DataStore — caps are kind-specific", () => {
  it("marker cap applies independently of ohlc cap", () => {
    const store = new DataStore({
      options: { caps: { ohlc: 1_000, point: 1_000, marker: 5 } },
    });
    store.defineChannel({ id: "events", kind: "marker" });
    for (let i = 0; i < 10; i++) {
      store.insert("events", MINUTE, marker(i * MINUTE + 7));
    }
    expect(store.size("events", MINUTE)).toBeLessThanOrEqual(5);
  });
});

describe("DataStore — options accessors", () => {
  it("requestThresholdBars reflects resolved options", () => {
    const a = new DataStore();
    expect(a.requestThresholdBars).toBe(1);
    const b = new DataStore({ options: { requestThresholdBars: 5 } });
    expect(b.requestThresholdBars).toBe(5);
  });
});

describe("DataStore — adversarial", () => {
  it("record with both ohlc AND point fields routes by channel kind", () => {
    const store = new DataStore();
    store.defineChannel({ id: "ohlcChan", kind: "ohlc" });
    store.defineChannel({ id: "pointChan", kind: "point" });
    const ambiguous = {
      time: asTime(MINUTE),
      open: asPrice(1),
      high: asPrice(2),
      low: asPrice(0),
      close: asPrice(1),
      value: asPrice(9),
    } as unknown as OhlcRecord & PointRecord;

    store.insert("ohlcChan", MINUTE, ambiguous);
    expect(store.size("ohlcChan", MINUTE)).toBe(1);

    store.insert("pointChan", MINUTE, ambiguous);
    expect(store.size("pointChan", MINUTE)).toBe(1);
  });

  it("channel id with unicode / emoji / empty string is accepted as a distinct key", () => {
    const store = new DataStore();
    store.defineChannel({ id: "", kind: "point" });
    store.defineChannel({ id: "价格", kind: "point" });
    store.defineChannel({ id: "📈", kind: "point" });
    expect(store.hasChannel("")).toBe(true);
    expect(store.hasChannel("价格")).toBe(true);
    expect(store.hasChannel("📈")).toBe(true);
  });

  it("channel ids are case-sensitive", () => {
    const store = new DataStore();
    store.defineChannel({ id: "Close", kind: "point" });
    expect(() => { store.defineChannel({ id: "close", kind: "ohlc" }); }).not.toThrow();
    expect(store.getChannel("Close")?.kind).toBe("point");
    expect(store.getChannel("close")?.kind).toBe("ohlc");
  });

  it("setInterval wipe frees the bucket (subsequent missingRanges sees cold-cache, not empty)", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    store.insertMany("primary", MINUTE, [ohlc(MINUTE), ohlc(2 * MINUTE), ohlc(3 * MINUTE)]);
    store.setInterval(FIVE_MIN, MINUTE);
    // After wipe, a missingRanges query for the old interval should return the
    // full range (cold-cache fallback), not an empty array.
    const ranges = store.missingRanges("primary", MINUTE, MINUTE, 3 * MINUTE);
    expect(ranges).toEqual([{ start: MINUTE, end: 3 * MINUTE }]);
  });

  it("records with missing required fields are dropped via type guard", () => {
    const log = mockLogger();
    const store = new DataStore({ logger: log });
    store.defineChannel({ id: "primary", kind: "ohlc" });
    const incomplete = { time: asTime(MINUTE), open: asPrice(1) } as unknown as OhlcRecord;
    const accepted = store.insert("primary", MINUTE, incomplete);
    expect(accepted).toBe(false);
    expect(store.size("primary", MINUTE)).toBe(0);
    expect(log.warnings.length).toBe(1);
  });

  it("missingRanges perf on 500k-bar cache over 1-day window < 10ms", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    const records = Array.from({ length: 500_000 }, (_, i) => ohlc((i + 1) * MINUTE));
    store.insertMany("primary", MINUTE, records);
    const t0 = performance.now();
    // Query a 1-day window fully inside the cached range
    const ranges = store.missingRanges("primary", MINUTE, 1000 * MINUTE, 1000 * MINUTE + 1440 * MINUTE);
    const dt = performance.now() - t0;
    expect(ranges).toEqual([]);
    expect(dt).toBeLessThan(10);
  });
});

describe("DataStore — snapshot()", () => {
  it("returns [] when no channels are registered", () => {
    const store = new DataStore();
    expect(store.snapshot()).toEqual([]);
  });

  it("lists a defineChannel-only channel with empty intervals and zero records", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    const snap = store.snapshot();
    expect(snap.length).toBe(1);
    expect(snap[0]).toEqual({
      channelId: "primary",
      kind: "ohlc",
      intervalsLoaded: [],
      totalRecords: 0,
    });
  });

  it("aggregates per-interval record counts across a multi-channel store", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    store.defineChannel({ id: "volume", kind: "point" });
    store.defineChannel({ id: "events", kind: "marker" });

    store.insertMany("primary", MINUTE, [ohlc(MINUTE), ohlc(2 * MINUTE)]);
    store.insertMany("primary", FIVE_MIN, [ohlc(FIVE_MIN), ohlc(2 * FIVE_MIN), ohlc(3 * FIVE_MIN)]);
    store.insertMany("volume", MINUTE, [point(MINUTE), point(2 * MINUTE), point(3 * MINUTE)]);
    store.insert("events", MINUTE, marker(MINUTE));

    const snap = store.snapshot();
    expect(snap.length).toBe(3);
    const byId = new Map(snap.map((s) => [s.channelId, s]));
    expect(byId.get("primary")).toEqual({
      channelId: "primary",
      kind: "ohlc",
      intervalsLoaded: [MINUTE, FIVE_MIN],
      totalRecords: 5,
    });
    expect(byId.get("volume")).toEqual({
      channelId: "volume",
      kind: "point",
      intervalsLoaded: [MINUTE],
      totalRecords: 3,
    });
    expect(byId.get("events")).toEqual({
      channelId: "events",
      kind: "marker",
      intervalsLoaded: [MINUTE],
      totalRecords: 1,
    });
  });

  it("intervals are sorted ascending regardless of insertion order", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    store.insert("primary", FIVE_MIN, ohlc(FIVE_MIN));
    store.insert("primary", MINUTE, ohlc(MINUTE));
    const snap = store.snapshot();
    expect(snap[0]?.intervalsLoaded).toEqual([MINUTE, FIVE_MIN]);
  });

  it("tracks bucket removal after setInterval", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    store.insert("primary", MINUTE, ohlc(MINUTE));
    store.insert("primary", FIVE_MIN, ohlc(FIVE_MIN));
    store.setInterval(FIVE_MIN, MINUTE);
    const snap = store.snapshot();
    expect(snap[0]?.intervalsLoaded).toEqual([FIVE_MIN]);
    expect(snap[0]?.totalRecords).toBe(1);
  });
});
