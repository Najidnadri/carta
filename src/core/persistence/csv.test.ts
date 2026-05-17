import { describe, expect, it } from "vitest";
import {
  asInterval,
  asPrice,
  asTime,
  type Channel,
  type DataRecord,
  type ExportPartialDataPayload,
  type Interval,
  type OhlcRecord,
  type PointRecord,
  type Range,
  type Time,
} from "../../types.js";
import { exportCsv, type CsvExportContext } from "./csv.js";
import { ExportError } from "./types.js";

const MINUTE = 60_000;

function ohlc(t: number, o: number, h: number, l: number, c: number, v?: number): OhlcRecord {
  return {
    time: asTime(t),
    open: asPrice(o),
    high: asPrice(h),
    low: asPrice(l),
    close: asPrice(c),
    ...(v !== undefined ? { volume: v } : {}),
  };
}

function point(t: number, v: number): PointRecord {
  return { time: asTime(t), value: asPrice(v) };
}

interface MockCtxOptions {
  readonly channels?: ReadonlyMap<string, Channel>;
  readonly records?: ReadonlyMap<string, readonly DataRecord[]>;
  readonly gaps?: readonly Range[];
  readonly window?: { startTime: Time; endTime: Time };
  readonly intervalDuration?: Interval;
  readonly defaultChannelId?: string;
}

function mockCtx(opts: MockCtxOptions = {}): {
  ctx: CsvExportContext;
  emitted: ExportPartialDataPayload[];
} {
  const channels =
    opts.channels ??
    new Map<string, Channel>([["primary", { id: "primary", kind: "ohlc" }]]);
  const records = opts.records ?? new Map<string, readonly DataRecord[]>();
  const gaps = opts.gaps ?? [];
  const emitted: ExportPartialDataPayload[] = [];
  return {
    emitted,
    ctx: {
      window: opts.window ?? {
        startTime: asTime(0),
        endTime: asTime(10 * MINUTE),
      },
      intervalDuration: opts.intervalDuration ?? asInterval(MINUTE),
      defaultChannelId: opts.defaultChannelId ?? "primary",
      getChannel: (id): Channel | undefined => channels.get(id),
      recordsInRange: (id): readonly DataRecord[] => records.get(id) ?? [],
      missingRanges: (): readonly Range[] => gaps,
      emitPartialData: (p): void => {
        emitted.push(p);
      },
    },
  };
}

describe("exportCsv — OHLC channel", () => {
  it("emits a UTF-8-BOM + CRLF + header row + 3 bars by default", () => {
    const records = [
      ohlc(MINUTE, 100, 101, 99, 100.5, 1000),
      ohlc(2 * MINUTE, 100.5, 102, 100, 101.5, 1500),
      ohlc(3 * MINUTE, 101.5, 103, 101, 102.5, 800),
    ];
    const { ctx } = mockCtx({
      records: new Map([["primary", records]]),
    });
    const csv = exportCsv(ctx);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("time,open,high,low,close,volume");
    expect(lines).toHaveLength(4);
    // ISO time, 2-decimal default precision.
    expect(lines[1]).toBe("1970-01-01T00:01:00.000Z,100.00,101.00,99.00,100.50,1000.00");
    expect(lines[2]).toBe("1970-01-01T00:02:00.000Z,100.50,102.00,100.00,101.50,1500.00");
    expect(lines[3]).toBe("1970-01-01T00:03:00.000Z,101.50,103.00,101.00,102.50,800.00");
  });

  it("omits BOM when includeBOM:false", () => {
    const { ctx } = mockCtx({ records: new Map([["primary", [ohlc(MINUTE, 1, 2, 0, 1.5)]]]) });
    const csv = exportCsv(ctx, { includeBOM: false });
    expect(csv.startsWith("﻿")).toBe(false);
    expect(csv.startsWith("time,")).toBe(true);
  });

  it("uses LF endings when overridden", () => {
    const { ctx } = mockCtx({ records: new Map([["primary", [ohlc(MINUTE, 1, 2, 0, 1.5)]]]) });
    const csv = exportCsv(ctx, { lineEnding: "\n", includeBOM: false });
    expect(csv.includes("\r\n")).toBe(false);
    expect(csv.includes("\n")).toBe(true);
  });

  it("emits empty cells for NaN OHLC values, not literal 'NaN'", () => {
    const records = [
      {
        time: asTime(MINUTE),
        open: asPrice(NaN),
        high: asPrice(2),
        low: asPrice(0),
        close: asPrice(1.5),
      } as OhlcRecord,
    ];
    const { ctx } = mockCtx({ records: new Map([["primary", records]]) });
    const csv = exportCsv(ctx, { includeBOM: false });
    const dataRow = csv.split("\r\n")[1];
    expect(dataRow).toBeDefined();
    // open is empty
    expect(dataRow).toBe("1970-01-01T00:01:00.000Z,,2.00,0.00,1.50,");
    expect(csv.includes("NaN")).toBe(false);
  });

  it("emits empty cell for missing volume (not zero)", () => {
    const { ctx } = mockCtx({
      records: new Map([["primary", [ohlc(MINUTE, 1, 2, 0, 1.5)]]]),
    });
    const csv = exportCsv(ctx, { includeBOM: false });
    const dataRow = csv.split("\r\n")[1] ?? "";
    expect(dataRow.endsWith(",")).toBe(true);
    expect(dataRow.endsWith(",0.00")).toBe(false);
  });

  it("respects DACH locale {decimal:',', delimiter:';'}", () => {
    const { ctx } = mockCtx({
      records: new Map([["primary", [ohlc(MINUTE, 1.23, 2.34, 0.12, 1.78, 1000)]]]),
    });
    const csv = exportCsv(ctx, {
      decimal: ",",
      delimiter: ";",
      includeBOM: false,
    });
    expect(csv.split("\r\n")[0]).toBe("time;open;high;low;close;volume");
    expect(csv.split("\r\n")[1]).toBe("1970-01-01T00:01:00.000Z;1,23;2,34;0,12;1,78;1000,00");
  });

  it("respects timeFormat: 'epoch-ms'", () => {
    const { ctx } = mockCtx({
      records: new Map([["primary", [ohlc(MINUTE, 1, 2, 0, 1.5)]]]),
    });
    const csv = exportCsv(ctx, { timeFormat: "epoch-ms", includeBOM: false });
    const dataRow = csv.split("\r\n")[1] ?? "";
    expect(dataRow.startsWith(String(MINUTE) + ",")).toBe(true);
  });

  it("respects custom precision (0)", () => {
    const { ctx } = mockCtx({
      records: new Map([["primary", [ohlc(MINUTE, 1.7, 2.4, 0.6, 1.3)]]]),
    });
    const csv = exportCsv(ctx, { precision: 0, includeBOM: false });
    const dataRow = csv.split("\r\n")[1] ?? "";
    expect(dataRow).toBe("1970-01-01T00:01:00.000Z,2,2,1,1,");
  });

  it("throws on decimal === delimiter", () => {
    const { ctx } = mockCtx();
    expect(() => exportCsv(ctx, { decimal: ",", delimiter: "," })).toThrow(ExportError);
    expect(() => exportCsv(ctx, { decimal: ",", delimiter: "," })).toThrow(/delimiter/);
  });

  it("throws on precision out of range (negative)", () => {
    const { ctx } = mockCtx();
    expect(() => exportCsv(ctx, { precision: -1 })).toThrow(ExportError);
    expect(() => exportCsv(ctx, { precision: -1 })).toThrow(/precision/);
  });

  it("throws on precision out of range (> 12)", () => {
    const { ctx } = mockCtx();
    expect(() => exportCsv(ctx, { precision: 13 })).toThrow(ExportError);
  });

  it("throws on non-integer precision", () => {
    const { ctx } = mockCtx();
    expect(() => exportCsv(ctx, { precision: 2.5 })).toThrow(ExportError);
  });

  it("throws on unknown channel", () => {
    const { ctx } = mockCtx();
    expect(() => exportCsv(ctx, { channelId: "nope" })).toThrow(ExportError);
    expect(() => exportCsv(ctx, { channelId: "nope" })).toThrow(/unknown channel/);
  });

  it("throws on marker channel", () => {
    const channels = new Map<string, Channel>([
      ["events", { id: "events", kind: "marker" }],
    ]);
    const { ctx } = mockCtx({ channels, defaultChannelId: "events" });
    expect(() => exportCsv(ctx)).toThrow(ExportError);
    expect(() => exportCsv(ctx)).toThrow(/marker/);
  });

  it("empty range → header-only output (still has BOM by default)", () => {
    const { ctx } = mockCtx();
    const csv = exportCsv(ctx);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.slice(1)).toBe("time,open,high,low,close,volume");
  });

  it("single-bar range → 2 lines", () => {
    const { ctx } = mockCtx({
      records: new Map([["primary", [ohlc(MINUTE, 1, 2, 0, 1.5)]]]),
    });
    const csv = exportCsv(ctx, { includeBOM: false });
    expect(csv.split("\r\n")).toHaveLength(2);
  });

  it("uses opts.range over ctx.window", () => {
    const { ctx } = mockCtx({
      records: new Map([["primary", [ohlc(MINUTE, 1, 2, 0, 1.5)]]]),
    });
    // The mock recordsInRange ignores start/end, so we use range only to
    // verify the encoder reads it without throwing.
    const csv = exportCsv(ctx, {
      range: { startTime: 0, endTime: 99 * MINUTE },
      includeBOM: false,
    });
    expect(csv.split("\r\n")).toHaveLength(2);
  });
});

describe("exportCsv — point channel", () => {
  it("emits 2-column header + rows", () => {
    const channels = new Map<string, Channel>([
      ["sma", { id: "sma", kind: "point" }],
    ]);
    const records = [point(MINUTE, 100.123), point(2 * MINUTE, 101.456)];
    const { ctx } = mockCtx({
      channels,
      defaultChannelId: "sma",
      records: new Map([["sma", records]]),
    });
    const csv = exportCsv(ctx, { precision: 3, includeBOM: false });
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("time,value");
    expect(lines[1]).toBe("1970-01-01T00:01:00.000Z,100.123");
    expect(lines[2]).toBe("1970-01-01T00:02:00.000Z,101.456");
  });
});

describe("exportCsv — gap detection", () => {
  it("emits export:partial-data exactly once when gaps exist", () => {
    const gaps: Range[] = [{ start: 5 * MINUTE, end: 7 * MINUTE }];
    const { ctx, emitted } = mockCtx({
      records: new Map([["primary", [ohlc(MINUTE, 1, 2, 0, 1.5)]]]),
      gaps,
    });
    exportCsv(ctx);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.channelId).toBe("primary");
    expect(emitted[0]?.gaps).toEqual(gaps);
    expect(Number(emitted[0]?.intervalDuration)).toBe(MINUTE);
  });

  it("does NOT emit when there are no gaps", () => {
    const { ctx, emitted } = mockCtx({
      records: new Map([["primary", [ohlc(MINUTE, 1, 2, 0, 1.5)]]]),
      gaps: [],
    });
    exportCsv(ctx);
    expect(emitted).toHaveLength(0);
  });
});

describe("exportCsv — ISO time always emits Z-suffixed UTC", () => {
  it("formats epoch ms as ISO with Z", () => {
    const { ctx } = mockCtx({
      records: new Map([["primary", [ohlc(1_700_000_000_000, 1, 2, 0, 1.5)]]]),
    });
    const csv = exportCsv(ctx, { includeBOM: false });
    const dataRow = csv.split("\r\n")[1] ?? "";
    expect(dataRow.startsWith("2023-11-14T22:13:20.000Z")).toBe(true);
  });
});

describe("exportCsv — perf canary", () => {
  it("encodes 100K OHLC bars in < 1000ms (loose budget for CI)", () => {
    const big: OhlcRecord[] = [];
    for (let i = 0; i < 100_000; i += 1) {
      big.push(ohlc((i + 1) * MINUTE, 100 + i * 0.01, 101 + i * 0.01, 99 + i * 0.01, 100.5 + i * 0.01, 1000));
    }
    const { ctx } = mockCtx({ records: new Map([["primary", big]]) });
    const t0 = performance.now();
    const csv = exportCsv(ctx, { includeBOM: false });
    const dt = performance.now() - t0;
    // CI guard: 1s budget is generous. Local laptops should easily land < 200ms.
    expect(dt).toBeLessThan(1000);
    expect(csv.split("\r\n")).toHaveLength(100_001);
  });
});
