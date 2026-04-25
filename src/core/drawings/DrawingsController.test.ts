import { describe, expect, it } from "vitest";
import { normalizeDrawingDefaults } from "./DrawingsController.js";
import { DEFAULT_FIB_LEVELS, type Drawing } from "./types.js";
import { asPrice, asTime } from "../../types.js";

const ANCHOR_A = { time: asTime(0), price: asPrice(100), paneId: "main" as Drawing["anchors"][0]["paneId"] };
const ANCHOR_B = { time: asTime(1000), price: asPrice(50), paneId: "main" as Drawing["anchors"][0]["paneId"] };

function bareTrendline(): Drawing {
  // Simulates a host building a drawing without filling the optional `style`
  // field — the plain object is structurally a Drawing minus `style`.
  return {
    id: "t-bare" as Drawing["id"],
    kind: "trendline",
    locked: false,
    visible: true,
    z: 0,
    schemaVersion: 1,
    anchors: [ANCHOR_A, ANCHOR_B],
  } as unknown as Drawing;
}

function bareFib(): Drawing {
  return {
    id: "f-bare" as Drawing["id"],
    kind: "fibRetracement",
    locked: false,
    visible: true,
    z: 0,
    schemaVersion: 1,
    anchors: [ANCHOR_A, ANCHOR_B],
    showPrices: true,
    showPercents: true,
  } as unknown as Drawing;
}

describe("normalizeDrawingDefaults", () => {
  it("fills missing style with an empty frozen object on trendline", () => {
    const d = normalizeDrawingDefaults(bareTrendline());
    expect(d.style).toEqual({});
    expect(Object.isFrozen(d.style)).toBe(true);
    // Subsequent reads of style.extend must not throw.
    expect(d.style.extend).toBeUndefined();
  });

  it("fills missing levels with DEFAULT_FIB_LEVELS on fibRetracement", () => {
    const d = normalizeDrawingDefaults(bareFib());
    if (d.kind !== "fibRetracement") {
      throw new Error("expected fibRetracement");
    }
    expect(d.levels).toBe(DEFAULT_FIB_LEVELS);
    expect(d.style).toEqual({});
  });

  it("returns the input by reference when both fields are present", () => {
    const original: Drawing = {
      id: "t-ok" as Drawing["id"],
      kind: "trendline",
      style: { stroke: { color: 0xff0000 } },
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [ANCHOR_A, ANCHOR_B],
    } as Drawing;
    expect(normalizeDrawingDefaults(original)).toBe(original);
  });

  it("preserves levels when fib has them; only fills style", () => {
    const fibWithLevels = {
      id: "f-keep" as Drawing["id"],
      kind: "fibRetracement",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [ANCHOR_A, ANCHOR_B],
      levels: [{ value: 0 }, { value: 1 }],
      showPrices: true,
      showPercents: true,
    } as unknown as Drawing;
    const d = normalizeDrawingDefaults(fibWithLevels);
    if (d.kind !== "fibRetracement") {
      throw new Error("expected fibRetracement");
    }
    expect(d.levels.length).toBe(2);
    expect(d.style).toEqual({});
  });

  it("does not throw when projected after normalization", async () => {
    // Round-trip: normalize → project → no throw.
    const { projectDrawing } = await import("./project.js");
    const { TimeScale } = await import("../time/TimeScale.js");
    const { PriceScale } = await import("../price/PriceScale.js");
    const { asInterval } = await import("../../types.js");
    const ctx = {
      timeScale: new TimeScale({
        startTime: asTime(0),
        endTime: asTime(1000),
        intervalDuration: asInterval(10),
        pixelWidth: 1000,
      }),
      priceScale: new PriceScale({
        domainMin: asPrice(0),
        domainMax: asPrice(100),
        pixelHeight: 500,
        margins: { top: 0, bottom: 0 },
      }),
      plotRect: { x: 0, y: 0, w: 1000, h: 500 },
    };
    const t = normalizeDrawingDefaults(bareTrendline());
    const f = normalizeDrawingDefaults(bareFib());
    expect(() => projectDrawing(t, ctx)).not.toThrow();
    expect(() => projectDrawing(f, ctx)).not.toThrow();
  });
});
