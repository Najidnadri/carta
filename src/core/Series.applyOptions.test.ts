import { describe, it, expect, vi } from "vitest";
import type * as PixiNS from "pixi.js";
import { CandlestickSeries } from "./CandlestickSeries.js";
import { OhlcBarSeries } from "./OhlcBarSeries.js";
import { HeikinAshiSeries } from "./HeikinAshiSeries.js";
import { LineSeries } from "./LineSeries.js";
import { AreaSeries } from "./AreaSeries.js";
import { HistogramSeries } from "./HistogramSeries.js";
import { BaselineSeries } from "./BaselineSeries.js";
import { MarkerOverlay } from "./MarkerOverlay.js";
import { DataStore } from "./DataStore.js";

// MarkerOverlay constructs `BitmapText` eagerly when its render runs in jsdom;
// the FakeBitmapText pattern from MarkerOverlay.test.ts ports cleanly because
// `applyOptions` doesn't render — but `addChild(text)` happens in `acquire()`,
// which only runs from `render`. None of the tests below trigger `render`,
// so the real `BitmapText` is never instantiated.
vi.mock("pixi.js", async () => {
  const actual = await vi.importActual<typeof PixiNS>("pixi.js");
  return actual;
});

const IV = 60_000;

describe("Series.applyOptions — channel-pin invariant", () => {
  it("CandlestickSeries pins channel and merges everything else", () => {
    const s = new CandlestickSeries({ channel: "primary", upColor: 0xff0000 });
    s.applyOptions({
      upColor: 0x00ff00,
      downColor: 0x0000ff,
      // Cast: TS would otherwise reject `channel` since it's readonly on
      // the input interface. The library accepts the patch and silently
      // pins — see MergeOptions docstring.
      ...({ channel: "evil" } as { channel: string }),
    });
    expect(s.channel).toBe("primary");
  });

  it("OhlcBarSeries pins channel", () => {
    const s = new OhlcBarSeries({ channel: "primary" });
    s.applyOptions({ ...({ channel: "evil" } as { channel: string }) });
    expect(s.channel).toBe("primary");
  });

  it("HeikinAshiSeries pins channel", () => {
    const s = new HeikinAshiSeries({ channel: "primary" });
    s.applyOptions({ ...({ channel: "evil" } as { channel: string }) });
    expect(s.channel).toBe("primary");
  });

  it("LineSeries pins channel", () => {
    const s = new LineSeries({ channel: "primary" });
    s.applyOptions({ ...({ channel: "evil" } as { channel: string }) });
    expect(s.channel).toBe("primary");
  });

  it("AreaSeries pins channel", () => {
    const s = new AreaSeries({ channel: "primary" });
    s.applyOptions({ ...({ channel: "evil" } as { channel: string }) });
    expect(s.channel).toBe("primary");
  });

  it("HistogramSeries pins channel", () => {
    const s = new HistogramSeries({ channel: "primary" });
    s.applyOptions({ ...({ channel: "evil" } as { channel: string }) });
    expect(s.channel).toBe("primary");
  });

  it("BaselineSeries pins channel", () => {
    const s = new BaselineSeries({ channel: "primary" });
    s.applyOptions({ ...({ channel: "evil" } as { channel: string }) });
    expect(s.channel).toBe("primary");
  });

  it("MarkerOverlay pins both channel and priceReference.channel", () => {
    const s = new MarkerOverlay({
      channel: "events",
      priceReference: { channel: "primary", field: "high" },
    });
    s.applyOptions({
      ...({ channel: "evil" } as { channel: string }),
      priceReference: {
        // priceReference.channel pinned — only the field can flip.
        ...({ channel: "evil" } as { channel: string }),
        field: "low",
      },
    });
    expect(s.channel).toBe("events");
    // Read back the (now-merged) priceReference via the rendering path.
    // No public getter for opts, so we exercise the render path's reference
    // channel lookup via the data store query — but for this unit, the
    // simplest assertion is that the constructor's value is what we still
    // see in `priceReference.channel` after applyOptions.
    const internalOpts = (
      s as unknown as { opts: { priceReference: { channel: string; field: string } } }
    ).opts;
    expect(internalOpts.priceReference.channel).toBe("primary");
    expect(internalOpts.priceReference.field).toBe("low");
  });
});

describe("Series.applyOptions — invalidator wiring", () => {
  it("calls the bound invalidate callback exactly once", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    const invalidate = vi.fn<() => void>();
    const s = new CandlestickSeries({ channel: "primary" });
    s.setQueryContext({ dataStore: store, getInterval: () => IV, invalidate });
    s.applyOptions({ upColor: 0x00ff00 });
    expect(invalidate).toHaveBeenCalledTimes(1);
    s.applyOptions({ downColor: 0x0000ff });
    expect(invalidate).toHaveBeenCalledTimes(2);
    s.destroy();
  });

  it("is a no-op-on-invalidator when no query context is bound", () => {
    const s = new LineSeries({ channel: "primary" });
    expect(() => { s.applyOptions({ color: 0x00ff00 }); }).not.toThrow();
    s.destroy();
  });

  it("does not invalidate after destroy clears the query context", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    const invalidate = vi.fn<() => void>();
    const s = new CandlestickSeries({ channel: "primary" });
    s.setQueryContext({ dataStore: store, getInterval: () => IV, invalidate });
    s.destroy();
    s.applyOptions({ upColor: 0x00ff00 });
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("Series.applyOptions — merge semantics", () => {
  it("undefined-patch fields preserve current values", () => {
    const s = new CandlestickSeries({
      channel: "primary",
      upColor: 0xff0000,
      downColor: 0x0000ff,
    });
    s.applyOptions({ upColor: 0x00ff00 });
    const opts = (
      s as unknown as { opts: { upColor: number; downColor: number } }
    ).opts;
    expect(opts.upColor).toBe(0x00ff00);
    expect(opts.downColor).toBe(0x0000ff);
  });

  it("empty patch is a valid no-op (still invalidates)", () => {
    const store = new DataStore();
    store.defineChannel({ id: "primary", kind: "ohlc" });
    const invalidate = vi.fn<() => void>();
    const s = new CandlestickSeries({ channel: "primary", upColor: 0xff00ff });
    s.setQueryContext({ dataStore: store, getInterval: () => IV, invalidate });
    s.applyOptions({});
    expect(invalidate).toHaveBeenCalledTimes(1);
    const opts = (s as unknown as { opts: { upColor: number } }).opts;
    expect(opts.upColor).toBe(0xff00ff);
    s.destroy();
  });

  it("HistogramSeries.participatesInAutoScale flips and is observable", () => {
    const s = new HistogramSeries({
      channel: "primary",
      participatesInAutoScale: true,
    });
    s.applyOptions({ participatesInAutoScale: false });
    const opts = (
      s as unknown as { opts: { participatesInAutoScale: boolean } }
    ).opts;
    expect(opts.participatesInAutoScale).toBe(false);
  });
});
