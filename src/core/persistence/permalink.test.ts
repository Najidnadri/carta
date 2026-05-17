import { describe, expect, it } from "vitest";
import {
  asInterval,
  asTime,
} from "../../types.js";
import { asPaneId, MAIN_PANE_ID } from "../drawings/types.js";
import {
  decodePermalink,
  encodePermalink,
} from "./permalink.js";
import {
  CARTA_SCHEMA_VERSION,
  CartaSchemaError,
  PermalinkTooLargeError,
  type ChartSaveState,
  type SeriesSaveEntry,
} from "./types.js";
import { lzEncode } from "./lzCodec.js";

const MINUTE = 60_000;

function blankSaveState(
  overrides: Partial<ChartSaveState> = {},
): ChartSaveState {
  const series: SeriesSaveEntry[] = overrides.series === undefined
    ? [
        {
          kind: "candle",
          channel: "primary",
          options: {
            channel: "primary",
            paneId: MAIN_PANE_ID,
            priceScaleId: "right",
          },
        },
      ]
    : [...overrides.series];
  return {
    schemaVersion: CARTA_SCHEMA_VERSION,
    savedAt: "2026-05-16T00:00:00.000Z",
    window: {
      startTime: asTime(1_700_000_000_000),
      endTime: asTime(1_700_000_000_000 + 60 * MINUTE),
    },
    intervalDuration: asInterval(MINUTE),
    chartType: "candle",
    primaryChannelId: "primary",
    theme: { name: "dark" },
    series,
    panes: overrides.panes ?? [
      { id: MAIN_PANE_ID, stretchFactor: 1 },
    ],
    drawings: overrides.drawings ?? { schemaVersion: 1, drawings: [] },
    ...(overrides.primarySymbol !== undefined
      ? { primarySymbol: overrides.primarySymbol }
      : {}),
    ...(overrides.theme !== undefined ? { theme: overrides.theme } : {}),
  };
}

describe("encodePermalink — Tier 1 (minimal)", () => {
  it("round-trips a minimal save state through encode/decode", () => {
    const state = blankSaveState({ primarySymbol: "AAPL" });
    const fragment = encodePermalink({ buildSaveState: () => state }, { tier: "minimal" });
    expect(fragment.startsWith("#")).toBe(true);
    expect(fragment.length).toBeLessThanOrEqual(200);
    const decoded = decodePermalink(fragment);
    expect(decoded.intervalDuration).toBe(state.intervalDuration);
    expect(decoded.window?.startTime).toBe(state.window.startTime);
    expect(decoded.window?.endTime).toBe(state.window.endTime);
    expect(decoded.chartType).toBe("candle");
    expect(decoded.primaryChannelId).toBe("primary");
    expect(decoded.primarySymbol).toBe("AAPL");
    expect(decoded.theme?.name).toBe("dark");
  });

  it("survives URI encoding of symbol with '.' (BRK.B)", () => {
    const state = blankSaveState({ primarySymbol: "BRK.B" });
    const fragment = encodePermalink({ buildSaveState: () => state }, { tier: "minimal" });
    const decoded = decodePermalink(fragment);
    expect(decoded.primarySymbol).toBe("BRK.B");
  });

  it("survives URI encoding of symbol with international suffix (7203.T)", () => {
    const state = blankSaveState({ primarySymbol: "7203.T" });
    const fragment = encodePermalink({ buildSaveState: () => state }, { tier: "minimal" });
    expect(decodePermalink(fragment).primarySymbol).toBe("7203.T");
  });

  it("omits 's' field when primarySymbol is absent", () => {
    const state = blankSaveState();
    const fragment = encodePermalink({ buildSaveState: () => state }, { tier: "minimal" });
    expect(fragment.includes("s=")).toBe(false);
  });

  it("Tier 1 is ≤ 200 chars on a typical state", () => {
    const state = blankSaveState({ primarySymbol: "AAPL" });
    const fragment = encodePermalink({ buildSaveState: () => state }, { tier: "minimal" });
    expect(fragment.length).toBeLessThanOrEqual(200);
  });

  it("throws PermalinkTooLargeError when a giant symbol overflows Tier 1", () => {
    const huge = "X".repeat(500);
    const state = blankSaveState({ primarySymbol: huge });
    expect(() =>
      encodePermalink({ buildSaveState: () => state }, { tier: "minimal" }),
    ).toThrow(PermalinkTooLargeError);
  });
});

describe("encodePermalink — auto tier", () => {
  it("picks 'minimal' for a blank state with no drawings, panes, or extras", () => {
    const state = blankSaveState();
    const fragment = encodePermalink({ buildSaveState: () => state });
    expect(fragment.startsWith("#z=")).toBe(false);
  });

  it("auto-promotes to 'full' when drawings exist", () => {
    const state: ChartSaveState = {
      ...blankSaveState(),
      drawings: {
        schemaVersion: 1,
        drawings: [
          {
            id: "d1",
            kind: "horizontalLine",
            anchors: [{ time: asTime(1_700_000_000_000), price: 100 }],
            style: { stroke: { color: 0xffffff, width: 1, style: "solid" } },
            paneId: MAIN_PANE_ID,
            scope: { startTime: asTime(0), endTime: asTime(Number.POSITIVE_INFINITY) },
            createdAt: 0,
            updatedAt: 0,
          } as unknown as ChartSaveState["drawings"] extends infer T
            ? T extends { drawings: readonly (infer D)[] }
              ? D
              : never
            : never,
        ],
      },
    };
    const fragment = encodePermalink({ buildSaveState: () => state });
    expect(fragment.startsWith("#z=")).toBe(true);
  });

  it("auto-promotes to 'full' with ≥ 2 series", () => {
    const series: SeriesSaveEntry[] = [
      {
        kind: "candle",
        channel: "primary",
        options: { channel: "primary", paneId: MAIN_PANE_ID, priceScaleId: "right" },
      },
      {
        kind: "line",
        channel: "sma",
        options: { channel: "sma", paneId: MAIN_PANE_ID, priceScaleId: "right" },
      },
    ];
    const state = blankSaveState({ series });
    const fragment = encodePermalink({ buildSaveState: () => state });
    expect(fragment.startsWith("#z=")).toBe(true);
  });

  it("auto-promotes to 'full' when theme has overrides", () => {
    const state = blankSaveState({
      theme: { name: "dark", overrides: { background: 0x121212 } },
    });
    const fragment = encodePermalink({ buildSaveState: () => state });
    expect(fragment.startsWith("#z=")).toBe(true);
  });

  it("auto-promotes to 'full' when theme.name === 'custom'", () => {
    const state = blankSaveState({
      theme: { name: "custom" },
    });
    const fragment = encodePermalink({ buildSaveState: () => state });
    expect(fragment.startsWith("#z=")).toBe(true);
  });

  it("auto-promotes to 'full' when extra (non-primary) panes exist", () => {
    const state = blankSaveState({
      panes: [
        { id: MAIN_PANE_ID, stretchFactor: 1 },
        { id: asPaneId("volume"), stretchFactor: 0.3 },
      ],
    });
    const fragment = encodePermalink({ buildSaveState: () => state });
    expect(fragment.startsWith("#z=")).toBe(true);
  });
});

describe("encodePermalink — Tier 2 (full)", () => {
  it("round-trips a full state byte-equal after migrate+validate", () => {
    const state = blankSaveState({ primarySymbol: "AAPL" });
    const fragment = encodePermalink({ buildSaveState: () => state }, { tier: "full" });
    expect(fragment.startsWith("#z=")).toBe(true);
    const decoded = decodePermalink(fragment);
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(state));
  });

  it("throws PermalinkTooLargeError when encoded length exceeds limit", () => {
    // Build a state with thousands of synthetic drawings to overflow 8192.
    const drawings: ChartSaveState["drawings"] = {
      schemaVersion: 1,
      drawings: Array.from({ length: 2000 }, (_, i) => ({
        id: `d${String(i)}`,
        kind: "horizontalLine",
        anchors: [{ time: asTime(1_700_000_000_000 + i), price: 100 + i }],
        style: { stroke: { color: 0xffffff, width: 1, style: "solid" } },
        paneId: MAIN_PANE_ID,
        scope: { startTime: asTime(0), endTime: asTime(Number.POSITIVE_INFINITY) },
        createdAt: 0,
        updatedAt: 0,
      })) as unknown as ChartSaveState["drawings"] extends { drawings: readonly (infer D)[] }
        ? readonly D[]
        : never,
    };
    const state: ChartSaveState = { ...blankSaveState(), drawings };
    expect(() =>
      encodePermalink({ buildSaveState: () => state }, { tier: "full" }),
    ).toThrow(PermalinkTooLargeError);
  });

  it("encoded Tier 2 fragment is URI-safe (alphabet [A-Za-z0-9+\\-$_=])", () => {
    const state = blankSaveState();
    const fragment = encodePermalink({ buildSaveState: () => state }, { tier: "full" });
    // Strip the "#z=" prefix; the rest is lz-string's URI-safe output.
    const body = fragment.slice(3);
    expect(/^[A-Za-z0-9+\-$_]*$/.test(body)).toBe(true);
  });
});

describe("encodePermalink — purity", () => {
  it("does not touch globalThis.location or history", () => {
    const state = blankSaveState();
    const before = globalThis.location.toString();
    encodePermalink({ buildSaveState: () => state }, { tier: "minimal" });
    const after = globalThis.location.toString();
    expect(after).toBe(before);
  });
});

describe("decodePermalink — Tier 1", () => {
  it("decodes a valid Tier 1 fragment from '#' envelope", () => {
    const decoded = decodePermalink(
      "#c=1&pc=primary&i=60000&f=1&t=2&y=line&th=light&s=AAPL",
    );
    expect(decoded.intervalDuration).toBe(asInterval(MINUTE));
    expect(decoded.chartType).toBe("line");
    expect(decoded.primarySymbol).toBe("AAPL");
    expect(decoded.theme?.name).toBe("light");
  });

  it("decodes a valid Tier 1 fragment from '?' envelope", () => {
    const decoded = decodePermalink("?c=1&pc=primary&i=60000&f=1&t=2&y=area&th=dark");
    expect(decoded.chartType).toBe("area");
  });

  it("decodes from a full URL", () => {
    const decoded = decodePermalink(
      "https://example.com/chart#c=1&pc=primary&i=60000&f=1&t=2&y=candle&th=dark",
    );
    expect(decoded.chartType).toBe("candle");
  });

  it("prefers fragment over query when both exist", () => {
    const decoded = decodePermalink(
      "https://x.y?c=1&pc=primary&i=60000&f=1&t=2&y=area&th=light#c=1&pc=primary&i=60000&f=1&t=2&y=candle&th=dark",
    );
    expect(decoded.chartType).toBe("candle");
  });

  it("throws on schemaVersion mismatch (c=2)", () => {
    expect(() =>
      decodePermalink("#c=2&pc=primary&i=60000&f=1&t=2&y=candle&th=dark"),
    ).toThrow(CartaSchemaError);
  });

  it("throws on non-integer intervalDuration", () => {
    expect(() =>
      decodePermalink("#c=1&pc=primary&i=60000.5&f=1&t=2&y=candle&th=dark"),
    ).toThrow(CartaSchemaError);
  });

  it("throws on zero intervalDuration", () => {
    expect(() =>
      decodePermalink("#c=1&pc=primary&i=0&f=1&t=2&y=candle&th=dark"),
    ).toThrow(CartaSchemaError);
  });

  it("throws on unknown chartType", () => {
    expect(() =>
      decodePermalink("#c=1&pc=primary&i=60000&f=1&t=2&y=foo&th=dark"),
    ).toThrow(CartaSchemaError);
  });

  it("throws on f >= t", () => {
    expect(() =>
      decodePermalink("#c=1&pc=primary&i=60000&f=2&t=2&y=candle&th=dark"),
    ).toThrow(CartaSchemaError);
  });

  it("throws on non-numeric f", () => {
    expect(() =>
      decodePermalink("#c=1&pc=primary&i=60000&f=NaN&t=2&y=candle&th=dark"),
    ).toThrow(CartaSchemaError);
  });

  it("throws on bad theme name", () => {
    expect(() =>
      decodePermalink("#c=1&pc=primary&i=60000&f=1&t=2&y=candle&th=hotpink"),
    ).toThrow(CartaSchemaError);
  });

  it("defaults theme to dark when 'th' missing", () => {
    const decoded = decodePermalink("#c=1&pc=primary&i=60000&f=1&t=2&y=candle");
    expect(decoded.theme?.name).toBe("dark");
  });

  it("defaults primaryChannelId to 'primary' when 'pc' missing", () => {
    const decoded = decodePermalink("#c=1&i=60000&f=1&t=2&y=candle&th=dark");
    expect(decoded.primaryChannelId).toBe("primary");
  });

  it("Tier 1 → encode → decode → encode → byte-equal", () => {
    const state = blankSaveState({ primarySymbol: "AAPL" });
    const f1 = encodePermalink({ buildSaveState: () => state }, { tier: "minimal" });
    const decoded = decodePermalink(f1);
    // Re-encode requires a full ChartSaveState; synthesize one from the decoded
    // partial + the missing required fields.
    const theme = decoded.theme ?? state.theme;
    const reState: ChartSaveState = {
      ...state,
      // Pull through the fields that Tier 1 actually carries
      window: decoded.window ?? state.window,
      intervalDuration: decoded.intervalDuration ?? state.intervalDuration,
      chartType: decoded.chartType ?? state.chartType,
      primaryChannelId: decoded.primaryChannelId ?? state.primaryChannelId,
      ...(decoded.primarySymbol !== undefined ? { primarySymbol: decoded.primarySymbol } : {}),
      ...(theme !== undefined ? { theme } : {}),
    };
    const f2 = encodePermalink({ buildSaveState: () => reState }, { tier: "minimal" });
    expect(f2).toBe(f1);
  });
});

describe("decodePermalink — Tier 2", () => {
  it("decodes a valid Tier 2 fragment", () => {
    const state = blankSaveState({ primarySymbol: "AAPL" });
    const fragment = encodePermalink({ buildSaveState: () => state }, { tier: "full" });
    const decoded = decodePermalink(fragment);
    expect(decoded.primarySymbol).toBe("AAPL");
    expect(decoded.series?.length).toBe(1);
  });

  it("throws on invalid lz payload", () => {
    expect(() => decodePermalink("#z=!@#$%^&*()")).toThrow(CartaSchemaError);
  });

  it("regression: mangled lz body returns null (not TypeError) — phase-15 cycle B `adv-perm-tier2-mangled-body`", () => {
    // Pre-fix, lz-string returned `null` and `lzDecode` accessed `.length`
    // on it, leaking `TypeError`. Post-fix, `lzDecode` narrows via `typeof`
    // and `decodePermalink` maps `null` → `CartaSchemaError`.
    expect(() => decodePermalink("#z=!!!notvalidlz!!!")).toThrow(CartaSchemaError);
    expect(() => decodePermalink("#z=garbage_no_lz_string_here_!!!!")).toThrow(CartaSchemaError);
  });

  it("throws on lz payload that decompresses to non-JSON", () => {
    const fragment = "#z=" + lzEncode("not json {{{");
    expect(() => decodePermalink(fragment)).toThrow(CartaSchemaError);
  });

  it("throws on lz payload that decompresses to JSON but fails schema validation", () => {
    const fragment = "#z=" + lzEncode(JSON.stringify({ schemaVersion: 1, hello: "world" }));
    expect(() => decodePermalink(fragment)).toThrow(CartaSchemaError);
  });

  it("throws on empty z field", () => {
    expect(() => decodePermalink("#z=")).toThrow(CartaSchemaError);
  });
});

describe("decodePermalink — envelope edge cases", () => {
  it("throws on empty fragment", () => {
    expect(() => decodePermalink("#")).toThrow(CartaSchemaError);
  });

  it("throws on bare empty string", () => {
    expect(() => decodePermalink("")).toThrow(CartaSchemaError);
  });

  it("accepts bare key=value form (no '#' or '?')", () => {
    const decoded = decodePermalink(
      "c=1&pc=primary&i=60000&f=1&t=2&y=candle&th=dark",
    );
    expect(decoded.chartType).toBe("candle");
  });
});
