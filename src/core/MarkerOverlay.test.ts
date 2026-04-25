import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as PixiNS from "pixi.js";
import { MarkerOverlay } from "./MarkerOverlay.js";
import { DataStore } from "./DataStore.js";
import {
  asPrice,
  asTime,
  type MarkerRecord,
  type OhlcRecord,
} from "../types.js";
import { DarkTheme } from "./themes.js";
import type { SeriesRenderContext } from "./Series.js";

const IV = 60_000;
const MARKER_CHANNEL = "events";
const OHLC_CHANNEL = "primary";

// Stub BitmapText — text rasterization needs a canvas that jsdom lacks.
// We extend the real Container so the fake still has all the ContainerChild
// lifecycle methods Pixi uses during addChild / destroy traversals.
vi.mock("pixi.js", async () => {
  const actual = await vi.importActual<typeof PixiNS>("pixi.js");
  class FakeBitmapText extends actual.Container {
    text = "";
    style: { fontFamily: string; fontSize: number; fill: number } = {
      fontFamily: "Arial",
      fontSize: 11,
      fill: 0xffffff,
    };
    anchor = {
      set: (_x: number, _y: number): void => {
        // Intentional no-op — tests don't assert on anchor math.
      },
    };
    constructor(opts?: { style?: { fontFamily?: string; fontSize?: number; fill?: number } }) {
      super();
      if (opts?.style !== undefined) {
        this.style = {
          fontFamily: opts.style.fontFamily ?? "Arial",
          fontSize: opts.style.fontSize ?? 11,
          fill: opts.style.fill ?? 0xffffff,
        };
      }
    }
  }
  return { ...actual, BitmapText: FakeBitmapText };
});

function ohlc(time: number, o: number, h: number, l: number, c: number): OhlcRecord {
  return {
    time: asTime(time),
    open: asPrice(o),
    high: asPrice(h),
    low: asPrice(l),
    close: asPrice(c),
  };
}

function marker(
  time: number,
  shape: MarkerRecord["shape"],
  position: MarkerRecord["position"],
  text?: string,
): MarkerRecord {
  return {
    time: asTime(time),
    shape,
    position,
    ...(text !== undefined ? { text } : {}),
  };
}

function buildCtx(store: DataStore, opts?: { startTime?: number; endTime?: number }): SeriesRenderContext {
  const start = opts?.startTime ?? 0;
  const end = opts?.endTime ?? 10 * IV;
  const timeScale = {
    timeToPixel: (t: number): number => t - start,
    barSpacingPx: 1,
    visibleBarSlots: (): readonly number[] => [],
  };
  const priceScale = {
    valueToPixel: (v: number): number => 100 - v,
  };
  return {
    startTime: asTime(start),
    endTime: asTime(end),
    intervalDuration: IV,
    plotWidth: end - start,
    plotHeight: 200,
    timeScale: timeScale as unknown as SeriesRenderContext["timeScale"],
    priceScale: priceScale as unknown as SeriesRenderContext["priceScale"],
    dataStore: store,
    theme: DarkTheme,
  } as unknown as SeriesRenderContext;
}

describe("MarkerOverlay", () => {
  let store: DataStore;
  let overlay: MarkerOverlay;

  beforeEach(() => {
    store = new DataStore();
    store.defineChannel({ id: OHLC_CHANNEL, kind: "ohlc" });
    store.defineChannel({ id: MARKER_CHANNEL, kind: "marker" });
    overlay = new MarkerOverlay({
      channel: MARKER_CHANNEL,
      priceReference: { channel: OHLC_CHANNEL, field: "high" },
    });
    overlay.setQueryContext({ dataStore: store, getInterval: () => IV });
  });

  afterEach(() => {
    overlay.destroy();
    store.clearAll();
  });

  it("priceRangeInWindow always returns null (no auto-scale influence)", () => {
    store.insertMany(OHLC_CHANNEL, IV, [ohlc(0, 100, 110, 90, 105)]);
    store.insertMany(MARKER_CHANNEL, IV, [marker(0, "circle", "above")]);
    expect(overlay.priceRangeInWindow(asTime(0), asTime(IV))).toBeNull();
  });

  it("renders one pooled marker per visible record", () => {
    store.insertMany(OHLC_CHANNEL, IV, [
      ohlc(0, 100, 110, 90, 105),
      ohlc(IV, 105, 120, 95, 115),
      ohlc(2 * IV, 115, 125, 100, 120),
    ]);
    store.insertMany(MARKER_CHANNEL, IV, [
      marker(0, "circle", "above"),
      marker(IV, "arrowDown", "below"),
      marker(2 * IV, "square", "inBar"),
    ]);
    overlay.render(buildCtx(store));
    expect(overlay.activePoolSize()).toBe(3);
    // Pool grew to 3 on first render; stays 3 on second.
    overlay.render(buildCtx(store));
    expect(overlay.activePoolSize()).toBe(3);
    expect(overlay.totalPoolSize()).toBe(3);
  });

  it("skips markers whose reference bar does not exist (no backward-snap target)", () => {
    // Reference channel has only the IV=1 bar; marker at time 0 has no earlier bar.
    store.insertMany(OHLC_CHANNEL, IV, [ohlc(IV, 100, 110, 90, 105)]);
    store.insertMany(MARKER_CHANNEL, IV, [marker(0, "circle", "above")]);
    overlay.render(buildCtx(store));
    expect(overlay.activePoolSize()).toBe(0);
    expect(overlay.lastSkippedCount()).toBe(1);
  });

  it("renders nothing when reference channel is missing or wrong kind", () => {
    const overlay2 = new MarkerOverlay({
      channel: MARKER_CHANNEL,
      priceReference: { channel: "does-not-exist" },
    });
    overlay2.setQueryContext({ dataStore: store, getInterval: () => IV });
    store.insertMany(MARKER_CHANNEL, IV, [marker(0, "circle", "above")]);
    overlay2.render(buildCtx(store));
    expect(overlay2.activePoolSize()).toBe(0);
    overlay2.destroy();
  });

  it("pool releases and reuses Graphics across frames", () => {
    store.insertMany(OHLC_CHANNEL, IV, [ohlc(0, 100, 110, 90, 105)]);
    store.insertMany(MARKER_CHANNEL, IV, [marker(0, "circle", "above")]);
    overlay.render(buildCtx(store));
    const firstPoolSize = overlay.totalPoolSize();
    expect(firstPoolSize).toBeGreaterThan(0);
    // Empty frame: all released, pool size unchanged (no shrink).
    store.clearCache({ channelId: MARKER_CHANNEL });
    overlay.render(buildCtx(store));
    expect(overlay.activePoolSize()).toBe(0);
    expect(overlay.totalPoolSize()).toBe(firstPoolSize);
  });

  it("destroy() marks every Graphics, BitmapText, and context destroyed", () => {
    store.insertMany(OHLC_CHANNEL, IV, [ohlc(0, 100, 110, 90, 105)]);
    store.insertMany(MARKER_CHANNEL, IV, [marker(0, "circle", "above")]);
    overlay.render(buildCtx(store));
    const total = overlay.totalPoolSize();
    expect(total).toBe(1);
    overlay.destroy();
    expect(overlay.totalPoolSize()).toBe(0);
  });

  it("destroy() is idempotent", () => {
    overlay.destroy();
    expect(() => {
      overlay.destroy();
    }).not.toThrow();
  });

  it("channel kind is 'marker'", () => {
    expect(overlay.kind).toBe("marker");
  });
});
