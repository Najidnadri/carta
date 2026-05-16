import { describe, it, expect } from "vitest";
import { isChartSaveState, isPaneSaveEntry, isSeriesSaveEntry, isWatermarkConfig } from "./validate.js";
import { CARTA_SCHEMA_VERSION } from "./types.js";

const validMin = (): unknown => ({
  schemaVersion: CARTA_SCHEMA_VERSION,
  savedAt: "2026-05-17T00:00:00.000Z",
  window: { startTime: 1, endTime: 2 },
  intervalDuration: 60000,
  chartType: "candle",
  primaryChannelId: "primary",
  series: [],
});

describe("isChartSaveState — positive", () => {
  it("accepts minimal valid state", () => {
    expect(isChartSaveState(validMin())).toBe(true);
  });

  it("accepts state with all optional fields", () => {
    const v = {
      ...(validMin() as Record<string, unknown>),
      app: { name: "demo", version: "1.0.0" },
      theme: { name: "dark", overrides: { background: 0x000000 } },
      primarySymbol: "AAPL",
      drawings: { schemaVersion: 1, drawings: [] },
      panes: [
        { id: "main", stretchFactor: 1, minHeight: 50, heightOverride: null, hidden: false, collapsed: false },
      ],
      ui: { trackingMode: false, watermark: { text: "© Demo" } },
    };
    expect(isChartSaveState(v)).toBe(true);
  });
});

describe("isChartSaveState — rejects every bad type", () => {
  const bad = (mutate: (v: Record<string, unknown>) => void): unknown => {
    const v = validMin() as Record<string, unknown>;
    mutate(v);
    return v;
  };

  it("rejects null", () => { expect(isChartSaveState(null)).toBe(false); });
  it("rejects array", () => { expect(isChartSaveState([])).toBe(false); });
  it("rejects undefined", () => { expect(isChartSaveState(undefined)).toBe(false); });
  it("rejects string", () => { expect(isChartSaveState("x")).toBe(false); });
  it("rejects number", () => { expect(isChartSaveState(42)).toBe(false); });

  it("rejects wrong schemaVersion", () => {
    expect(isChartSaveState(bad((v) => { v["schemaVersion"] = 0; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["schemaVersion"] = 2; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["schemaVersion"] = "1"; }))).toBe(false);
  });

  it("rejects non-string savedAt", () => {
    expect(isChartSaveState(bad((v) => { v["savedAt"] = 1234567890; }))).toBe(false);
  });

  it("rejects malformed window", () => {
    expect(isChartSaveState(bad((v) => { v["window"] = null; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["window"] = { startTime: "x", endTime: 1 }; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["window"] = { startTime: NaN, endTime: 1 }; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["window"] = { startTime: 1 }; }))).toBe(false);
  });

  it("rejects invalid intervalDuration", () => {
    expect(isChartSaveState(bad((v) => { v["intervalDuration"] = 0; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["intervalDuration"] = -60; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["intervalDuration"] = 1.5; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["intervalDuration"] = NaN; }))).toBe(false);
  });

  it("rejects unknown chartType", () => {
    expect(isChartSaveState(bad((v) => { v["chartType"] = "unknown"; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["chartType"] = 1; }))).toBe(false);
  });

  it("rejects empty primaryChannelId", () => {
    expect(isChartSaveState(bad((v) => { v["primaryChannelId"] = ""; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["primaryChannelId"] = 1; }))).toBe(false);
  });

  it("rejects non-string primarySymbol", () => {
    expect(isChartSaveState(bad((v) => { v["primarySymbol"] = 1; }))).toBe(false);
  });

  it("rejects non-array series", () => {
    expect(isChartSaveState(bad((v) => { v["series"] = "x"; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["series"] = null; }))).toBe(false);
  });

  it("rejects malformed series entry", () => {
    expect(isChartSaveState(bad((v) => { v["series"] = [{ kind: "candle" }]; }))).toBe(false);
    expect(
      isChartSaveState(bad((v) => { v["series"] = [{ kind: "unknown", channel: "primary", options: { channel: "primary" } }]; })),
    ).toBe(false);
    expect(
      isChartSaveState(bad((v) => { v["series"] = [{ kind: "candle", channel: "", options: { channel: "primary" } }]; })),
    ).toBe(false);
  });

  it("rejects bad theme block", () => {
    expect(isChartSaveState(bad((v) => { v["theme"] = []; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["theme"] = { name: 1 }; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["theme"] = { name: "dark", overrides: [] }; }))).toBe(false);
  });

  it("rejects bad drawings block", () => {
    expect(isChartSaveState(bad((v) => { v["drawings"] = { schemaVersion: 2, drawings: [] }; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["drawings"] = { schemaVersion: 1, drawings: "x" }; }))).toBe(false);
  });

  it("rejects bad panes block", () => {
    expect(isChartSaveState(bad((v) => { v["panes"] = [{}]; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["panes"] = [{ id: "" }]; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["panes"] = "x"; }))).toBe(false);
  });

  it("rejects duplicate pane IDs (F-2 cross-field regression)", () => {
    expect(
      isChartSaveState(
        bad((v) => {
          v["panes"] = [{ id: "main" }, { id: "main" }];
        }),
      ),
    ).toBe(false);
    expect(
      isChartSaveState(
        bad((v) => {
          v["panes"] = [{ id: "main" }, { id: "volume" }, { id: "volume" }];
        }),
      ),
    ).toBe(false);
  });

  it("rejects bad ui block", () => {
    expect(isChartSaveState(bad((v) => { v["ui"] = { trackingMode: "yes" }; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["ui"] = { watermark: "x" }; }))).toBe(false);
  });

  it("rejects bad app block", () => {
    expect(isChartSaveState(bad((v) => { v["app"] = { name: 1, version: "1" }; }))).toBe(false);
    expect(isChartSaveState(bad((v) => { v["app"] = { name: "x" }; }))).toBe(false);
  });
});

describe("isSeriesSaveEntry", () => {
  it("accepts each enumerated kind", () => {
    for (const kind of [
      "candle",
      "ohlcBar",
      "heikinAshi",
      "line",
      "area",
      "histogram",
      "baseline",
      "markerOverlay",
    ]) {
      expect(
        isSeriesSaveEntry({ kind, channel: "primary", options: { channel: "primary" } }),
      ).toBe(true);
    }
  });

  it("rejects unknown kind", () => {
    expect(
      isSeriesSaveEntry({ kind: "candleStick", channel: "primary", options: { channel: "primary" } }),
    ).toBe(false);
  });

  it("rejects missing channel", () => {
    expect(isSeriesSaveEntry({ kind: "candle", options: { channel: "primary" } })).toBe(false);
  });

  it("rejects empty channel in options", () => {
    expect(isSeriesSaveEntry({ kind: "candle", channel: "primary", options: { channel: "" } })).toBe(false);
  });
});

describe("isPaneSaveEntry", () => {
  it("accepts minimal", () => {
    expect(isPaneSaveEntry({ id: "main" })).toBe(true);
  });

  it("accepts heightOverride = null", () => {
    expect(isPaneSaveEntry({ id: "main", heightOverride: null })).toBe(true);
  });

  it("rejects empty id", () => {
    expect(isPaneSaveEntry({ id: "" })).toBe(false);
  });

  it("rejects bad heightOverride", () => {
    expect(isPaneSaveEntry({ id: "main", heightOverride: "x" })).toBe(false);
    expect(isPaneSaveEntry({ id: "main", heightOverride: NaN })).toBe(false);
  });

  it("rejects negative heightOverride (F-2 regression)", () => {
    expect(isPaneSaveEntry({ id: "main", heightOverride: -50 })).toBe(false);
    expect(isPaneSaveEntry({ id: "main", heightOverride: -0.1 })).toBe(false);
  });

  it("accepts heightOverride = 0", () => {
    expect(isPaneSaveEntry({ id: "main", heightOverride: 0 })).toBe(true);
  });

  it("rejects non-positive stretchFactor / minHeight (F-2 regression)", () => {
    expect(isPaneSaveEntry({ id: "main", stretchFactor: 0 })).toBe(false);
    expect(isPaneSaveEntry({ id: "main", stretchFactor: -1 })).toBe(false);
    expect(isPaneSaveEntry({ id: "main", minHeight: 0 })).toBe(false);
    expect(isPaneSaveEntry({ id: "main", minHeight: -10 })).toBe(false);
  });

  it("accepts header: false", () => {
    expect(isPaneSaveEntry({ id: "main", header: false })).toBe(true);
  });

  it("accepts header: object", () => {
    expect(isPaneSaveEntry({ id: "main", header: { title: "RSI" } })).toBe(true);
  });

  it("rejects header: 'true'", () => {
    expect(isPaneSaveEntry({ id: "main", header: "true" })).toBe(false);
  });
});

describe("isWatermarkConfig", () => {
  it("accepts basic", () => {
    expect(isWatermarkConfig({ text: "© Demo" })).toBe(true);
  });

  it("accepts empty object", () => {
    expect(isWatermarkConfig({})).toBe(true);
  });

  it("rejects bad opacity", () => {
    expect(isWatermarkConfig({ opacity: "0.5" })).toBe(false);
  });

  it("rejects bad color", () => {
    expect(isWatermarkConfig({ color: -1 })).toBe(false);
    expect(isWatermarkConfig({ color: 0x1000000 })).toBe(false);
  });

  it("rejects non-string text", () => {
    expect(isWatermarkConfig({ text: 123 })).toBe(false);
  });
});
