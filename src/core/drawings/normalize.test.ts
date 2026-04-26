import { describe, expect, it } from "vitest";
import { normalizeDrawingDefaults } from "./normalize.js";
import { DEFAULT_FIB_LEVELS, type Drawing } from "./types.js";
import { asPrice, asTime } from "../../types.js";

const ANCHOR_A = { time: asTime(0), price: asPrice(100), paneId: "main" as Drawing["anchors"][0]["paneId"] };
const ANCHOR_B = { time: asTime(1000), price: asPrice(50), paneId: "main" as Drawing["anchors"][0]["paneId"] };

const INTERVAL_MS = 60_000;

function bareTrendline(): Drawing {
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

describe("normalizeDrawingDefaults — Cycle A baseline", () => {
  it("fills missing style with an empty frozen object on trendline", () => {
    const { drawing, warn } = normalizeDrawingDefaults(bareTrendline(), INTERVAL_MS);
    expect(warn).toBeNull();
    expect(drawing).not.toBeNull();
    expect(drawing!.style).toEqual({});
    expect(Object.isFrozen(drawing!.style)).toBe(true);
    expect(drawing!.style.extend).toBeUndefined();
  });

  it("fills missing levels with DEFAULT_FIB_LEVELS on fibRetracement", () => {
    const { drawing } = normalizeDrawingDefaults(bareFib(), INTERVAL_MS);
    if (drawing?.kind !== "fibRetracement") {
      throw new Error("expected fibRetracement");
    }
    expect(drawing.levels).toBe(DEFAULT_FIB_LEVELS);
    expect(drawing.style).toEqual({});
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
    expect(normalizeDrawingDefaults(original, INTERVAL_MS).drawing).toBe(original);
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
    const { drawing } = normalizeDrawingDefaults(fibWithLevels, INTERVAL_MS);
    if (drawing?.kind !== "fibRetracement") {
      throw new Error("expected fibRetracement");
    }
    expect(drawing.levels.length).toBe(2);
    expect(drawing.style).toEqual({});
  });
});

describe("normalizeDrawingDefaults — Cycle B.3 partial-add tolerance", () => {
  const ENTRY = { time: asTime(0), price: asPrice(100), paneId: "main" as Drawing["anchors"][0]["paneId"] };
  const SL_LONG = { time: asTime(0), price: asPrice(95), paneId: "main" as Drawing["anchors"][0]["paneId"] };
  const TP_LONG = { time: asTime(0), price: asPrice(110), paneId: "main" as Drawing["anchors"][0]["paneId"] };
  const SL_SHORT = { time: asTime(0), price: asPrice(105), paneId: "main" as Drawing["anchors"][0]["paneId"] };
  const TP_SHORT = { time: asTime(0), price: asPrice(90), paneId: "main" as Drawing["anchors"][0]["paneId"] };

  it("fills longPosition endTime / displayMode / qty defaults", () => {
    const partial = {
      id: "lp" as Drawing["id"],
      kind: "longPosition",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [ENTRY, SL_LONG, TP_LONG],
    } as unknown as Drawing;
    const { drawing, warn } = normalizeDrawingDefaults(partial, INTERVAL_MS);
    expect(warn).toBeNull();
    if (drawing?.kind !== "longPosition") {
      throw new Error("expected longPosition");
    }
    expect(Number(drawing.endTime)).toBe(12 * INTERVAL_MS);
    expect(drawing.qty).toBe(1);
    expect(drawing.displayMode).toBe("rr");
    expect(drawing.style).toEqual({});
  });

  it("preserves longPosition fields when host supplies them", () => {
    const supplied = {
      id: "lp2" as Drawing["id"],
      kind: "longPosition",
      style: {},
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [ENTRY, SL_LONG, TP_LONG],
      endTime: asTime(5 * INTERVAL_MS),
      qty: 7,
      displayMode: "ticks",
      tickSize: 0.01,
    } as unknown as Drawing;
    const { drawing } = normalizeDrawingDefaults(supplied, INTERVAL_MS);
    if (drawing?.kind !== "longPosition") {
      throw new Error("expected longPosition");
    }
    expect(Number(drawing.endTime)).toBe(5 * INTERVAL_MS);
    expect(drawing.qty).toBe(7);
    expect(drawing.displayMode).toBe("ticks");
    expect(drawing.tickSize).toBe(0.01);
  });

  it("drops longPosition when sl >= entry", () => {
    const bad = {
      id: "lp-bad" as Drawing["id"],
      kind: "longPosition",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [ENTRY, ENTRY, TP_LONG],
    } as unknown as Drawing;
    const { drawing, warn } = normalizeDrawingDefaults(bad, INTERVAL_MS);
    expect(drawing).toBeNull();
    expect(warn).toMatch(/longPosition/);
    expect(warn).toMatch(/invariant/);
  });

  it("drops longPosition when tp <= entry", () => {
    const bad = {
      id: "lp-bad2" as Drawing["id"],
      kind: "longPosition",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [ENTRY, SL_LONG, ENTRY],
    } as unknown as Drawing;
    expect(normalizeDrawingDefaults(bad, INTERVAL_MS).drawing).toBeNull();
  });

  it("fills shortPosition defaults and validates inverted invariant", () => {
    const partial = {
      id: "sp" as Drawing["id"],
      kind: "shortPosition",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [ENTRY, SL_SHORT, TP_SHORT],
    } as unknown as Drawing;
    const { drawing, warn } = normalizeDrawingDefaults(partial, INTERVAL_MS);
    expect(warn).toBeNull();
    if (drawing?.kind !== "shortPosition") {
      throw new Error("expected shortPosition");
    }
    expect(drawing.qty).toBe(1);
  });

  it("drops shortPosition when sl <= entry", () => {
    // Short invariant: tp < entry < sl. Here sl == entry violates strict <.
    const bad = {
      id: "sp-bad" as Drawing["id"],
      kind: "shortPosition",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [ENTRY, ENTRY, TP_SHORT],
    } as unknown as Drawing;
    expect(normalizeDrawingDefaults(bad, INTERVAL_MS).drawing).toBeNull();
  });

  it("drops shortPosition when tp >= entry (long-style invariant)", () => {
    const bad = {
      id: "sp-bad2" as Drawing["id"],
      kind: "shortPosition",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [ENTRY, SL_SHORT, ENTRY],
    } as unknown as Drawing;
    expect(normalizeDrawingDefaults(bad, INTERVAL_MS).drawing).toBeNull();
  });

  it("drops longPosition when interval missing AND no endTime supplied", () => {
    const partial = {
      id: "lp-noiv" as Drawing["id"],
      kind: "longPosition",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [ENTRY, SL_LONG, TP_LONG],
    } as unknown as Drawing;
    const { drawing, warn } = normalizeDrawingDefaults(partial, 0);
    expect(drawing).toBeNull();
    expect(warn).toMatch(/endTime/);
  });

  it("fills text drawing missing text → empty string", () => {
    const partial = {
      id: "tx" as Drawing["id"],
      kind: "text",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [ANCHOR_A],
    } as unknown as Drawing;
    const { drawing } = normalizeDrawingDefaults(partial, INTERVAL_MS);
    if (drawing?.kind !== "text") {
      throw new Error("expected text");
    }
    expect(drawing.text).toBe("");
  });

  it("fills callout drawing missing text → empty string", () => {
    const partial = {
      id: "cl" as Drawing["id"],
      kind: "callout",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [ANCHOR_A, ANCHOR_B],
    } as unknown as Drawing;
    const { drawing } = normalizeDrawingDefaults(partial, INTERVAL_MS);
    if (drawing?.kind !== "callout") {
      throw new Error("expected callout");
    }
    expect(drawing.text).toBe("");
  });

  it("dateRange / priceRange / priceDateRange round-trip with style fill", () => {
    for (const kind of ["dateRange", "priceRange", "priceDateRange"] as const) {
      const partial = {
        id: `r-${kind}` as Drawing["id"],
        kind,
        locked: false,
        visible: true,
        z: 0,
        schemaVersion: 1,
        anchors: [ANCHOR_A, ANCHOR_B],
      } as unknown as Drawing;
      const { drawing, warn } = normalizeDrawingDefaults(partial, INTERVAL_MS);
      expect(warn).toBeNull();
      expect(drawing).not.toBeNull();
      expect(drawing!.style).toEqual({});
    }
  });

  // ─── Phase 13 Cycle C.1 ───
  it("pitchfork missing variant → defaults to 'andrews' silently", () => {
    const partial = {
      id: "pf-bare" as Drawing["id"],
      kind: "pitchfork",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [ANCHOR_A, ANCHOR_B, ANCHOR_A],
    } as unknown as Drawing;
    const { drawing, warn } = normalizeDrawingDefaults(partial, INTERVAL_MS);
    expect(drawing?.kind).toBe("pitchfork");
    if (drawing?.kind === "pitchfork") {
      expect(drawing.variant).toBe("andrews");
      expect(drawing.style).toEqual({});
    }
    // Missing variant: not a "warn-and-fix" case — there's no signal that the
    // host meant something else. Treat as silent default.
    expect(warn).toBeNull();
  });

  it("pitchfork invalid variant → defaults to 'andrews' with a warn", () => {
    const partial = {
      id: "pf-bad" as Drawing["id"],
      kind: "pitchfork",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      style: {},
      variant: "schiffMod",
      anchors: [ANCHOR_A, ANCHOR_B, ANCHOR_A],
    } as unknown as Drawing;
    const { drawing, warn } = normalizeDrawingDefaults(partial, INTERVAL_MS);
    expect(drawing?.kind).toBe("pitchfork");
    if (drawing?.kind === "pitchfork") {
      expect(drawing.variant).toBe("andrews");
    }
    expect(warn).toMatch(/pitchfork unknown variant/);
  });

  it("gannFan / ellipse fill missing style with empty object", () => {
    for (const kind of ["gannFan", "ellipse"] as const) {
      const partial = {
        id: `c-${kind}` as Drawing["id"],
        kind,
        locked: false,
        visible: true,
        z: 0,
        schemaVersion: 1,
        anchors: [ANCHOR_A, ANCHOR_B],
      } as unknown as Drawing;
      const { drawing, warn } = normalizeDrawingDefaults(partial, INTERVAL_MS);
      expect(warn).toBeNull();
      expect(drawing).not.toBeNull();
      expect(drawing!.style).toEqual({});
    }
  });
});

describe("normalizeDrawingDefaults — Cycle C.2 NaN-anchor boundary", () => {
  const NAN_ANCHOR = {
    time: asTime(NaN),
    price: asPrice(100),
    paneId: "main" as Drawing["anchors"][0]["paneId"],
  };
  const NAN_PRICE_ANCHOR = {
    time: asTime(0),
    price: asPrice(NaN),
    paneId: "main" as Drawing["anchors"][0]["paneId"],
  };

  it("drops fibExtension with NaN anchor time", () => {
    const bad = {
      id: "fe-nan" as Drawing["id"],
      kind: "fibExtension",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [NAN_ANCHOR, ANCHOR_A, ANCHOR_B],
      levels: [{ value: 0 }, { value: 1 }],
      showPrices: true,
      showPercents: true,
    } as unknown as Drawing;
    const { drawing, warn } = normalizeDrawingDefaults(bad, INTERVAL_MS);
    expect(drawing).toBeNull();
    expect(warn).toContain("non-finite");
  });

  it("drops fibTimeZones with NaN anchor price", () => {
    const bad = {
      id: "ftz-nan" as Drawing["id"],
      kind: "fibTimeZones",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [NAN_PRICE_ANCHOR],
      offsets: [1, 2, 3],
    } as unknown as Drawing;
    const { drawing, warn } = normalizeDrawingDefaults(bad, INTERVAL_MS);
    expect(drawing).toBeNull();
    expect(warn).toContain("non-finite");
  });

  it("drops fibFan with NaN anchor", () => {
    const bad = {
      id: "ff-nan" as Drawing["id"],
      kind: "fibFan",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [NAN_ANCHOR, ANCHOR_A],
      levels: [{ value: 1 }],
    } as unknown as Drawing;
    const { drawing, warn } = normalizeDrawingDefaults(bad, INTERVAL_MS);
    expect(drawing).toBeNull();
    expect(warn).toContain("non-finite");
  });

  it("drops fibArcs with NaN anchor", () => {
    const bad = {
      id: "fa-nan" as Drawing["id"],
      kind: "fibArcs",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [NAN_ANCHOR, ANCHOR_A],
      levels: [{ value: 1 }],
    } as unknown as Drawing;
    const { drawing, warn } = normalizeDrawingDefaults(bad, INTERVAL_MS);
    expect(drawing).toBeNull();
    expect(warn).toContain("non-finite");
  });

  it("retroactively drops pitchfork with NaN anchor (C.1 S-1 carry-over)", () => {
    const bad = {
      id: "pf-nan" as Drawing["id"],
      kind: "pitchfork",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [ANCHOR_A, NAN_ANCHOR, ANCHOR_B],
      variant: "andrews",
    } as unknown as Drawing;
    const { drawing, warn } = normalizeDrawingDefaults(bad, INTERVAL_MS);
    expect(drawing).toBeNull();
    expect(warn).toContain("non-finite");
  });

  it("retroactively drops gannFan with NaN anchor (C.1 S-1 carry-over)", () => {
    const bad = {
      id: "gf-nan" as Drawing["id"],
      kind: "gannFan",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [NAN_ANCHOR, ANCHOR_B],
    } as unknown as Drawing;
    const { drawing, warn } = normalizeDrawingDefaults(bad, INTERVAL_MS);
    expect(drawing).toBeNull();
    expect(warn).toContain("non-finite");
  });

  it("retroactively drops ellipse with NaN anchor (C.1 S-1 carry-over)", () => {
    const bad = {
      id: "el-nan" as Drawing["id"],
      kind: "ellipse",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [NAN_PRICE_ANCHOR, ANCHOR_B],
    } as unknown as Drawing;
    const { drawing, warn } = normalizeDrawingDefaults(bad, INTERVAL_MS);
    expect(drawing).toBeNull();
    expect(warn).toContain("non-finite");
  });

  it("does NOT drop trendline with NaN anchor (cycle-A kinds remain unguarded)", () => {
    const partial = {
      id: "t-nan" as Drawing["id"],
      kind: "trendline",
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
      anchors: [NAN_ANCHOR, ANCHOR_B],
    } as unknown as Drawing;
    const { drawing } = normalizeDrawingDefaults(partial, INTERVAL_MS);
    // Trendline path didn't gain the finite-anchor guard in C.2; it remains
    // host-responsibility for now.  Document via test.
    expect(drawing).not.toBeNull();
  });
});
