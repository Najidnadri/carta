/**
 * Phase 13 Cycle C.3 — icon parser + normalize tests.
 */

import { describe, expect, it } from "vitest";
import { asPrice, asTime } from "../../types.js";
import {
  asDrawingId,
  DEFAULT_ICON_GLYPHS,
  MAIN_PANE_ID,
  type IconDrawing,
} from "./types.js";
import { normalizeDrawingDefaults } from "./normalize.js";
import { parseDrawing } from "./parsers.js";

const validJson = {
  id: "icn-1",
  kind: "icon",
  anchors: [{ time: 0, price: 100, paneId: "main" }],
  glyph: "flag",
  style: {},
  locked: false,
  visible: true,
  z: 0,
  schemaVersion: 1,
};

describe("icon parsing", () => {
  it("parses a valid icon JSON shape", () => {
    const parsed = parseDrawing(validJson);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("icon");
    if (parsed?.kind === "icon") {
      expect(parsed.glyph).toBe("flag");
    }
  });

  it("rejects an unknown glyph", () => {
    const bad = { ...validJson, glyph: "rocketship" };
    expect(parseDrawing(bad)).toBeNull();
  });

  it("supports every default catalog glyph", () => {
    for (const glyph of DEFAULT_ICON_GLYPHS) {
      const parsed = parseDrawing({ ...validJson, glyph });
      expect(parsed?.kind).toBe("icon");
    }
  });

  it("preserves size + tint when present", () => {
    const parsed = parseDrawing({ ...validJson, size: 48, tint: 0xff00ff });
    expect(parsed?.kind).toBe("icon");
    if (parsed?.kind === "icon") {
      expect(parsed.size).toBe(48);
      expect(parsed.tint).toBe(0xff00ff);
    }
  });

  it("filters non-finite size", () => {
    const parsed = parseDrawing({ ...validJson, size: NaN });
    expect(parsed?.kind).toBe("icon");
    if (parsed?.kind === "icon") {
      expect(parsed.size).toBeUndefined();
    }
  });
});

describe("icon normalize", () => {
  it("accepts a well-formed icon", () => {
    const icon: IconDrawing = Object.freeze({
      id: asDrawingId("icn-2"),
      kind: "icon",
      anchors: Object.freeze([
        Object.freeze({ time: asTime(0), price: asPrice(100), paneId: MAIN_PANE_ID }),
      ] as const),
      glyph: "star",
      style: Object.freeze({}),
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
    });
    const result = normalizeDrawingDefaults(icon, 60_000);
    expect(result.drawing).not.toBeNull();
    expect(result.warn).toBeNull();
  });

  it("drops an icon with non-finite anchor", () => {
    const icon: IconDrawing = Object.freeze({
      id: asDrawingId("icn-3"),
      kind: "icon",
      anchors: Object.freeze([
        Object.freeze({ time: asTime(NaN), price: asPrice(100), paneId: MAIN_PANE_ID }),
      ] as const),
      glyph: "star",
      style: Object.freeze({}),
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1,
    });
    const result = normalizeDrawingDefaults(icon, 60_000);
    expect(result.drawing).toBeNull();
  });

  it("drops an icon with unknown glyph (runtime add path)", () => {
    const icon = {
      id: asDrawingId("icn-4"),
      kind: "icon" as const,
      anchors: Object.freeze([
        Object.freeze({ time: asTime(0), price: asPrice(100), paneId: MAIN_PANE_ID }),
      ] as const),
      glyph: "rocket" as never,
      style: Object.freeze({}),
      locked: false,
      visible: true,
      z: 0,
      schemaVersion: 1 as const,
    };
    const result = normalizeDrawingDefaults(icon, 60_000);
    expect(result.drawing).toBeNull();
    expect(result.warn).not.toBeNull();
  });
});
