// Phase 13 Cycle D — preview synthetic-anchor padding tests.
import { describe, expect, it } from "vitest";
import { padPreviewAnchors, shouldPreview, PREVIEW_DRAWING_ID } from "./preview.js";
import type { DrawingAnchor, DrawingKind } from "./types.js";
import { MAIN_PANE_ID } from "./types.js";
import { asPrice, asTime } from "../../types.js";

const A = (t: number, p: number): DrawingAnchor =>
  Object.freeze({ time: asTime(t), price: asPrice(p), paneId: MAIN_PANE_ID });

describe("preview — shouldPreview", () => {
  it("returns false when cursor is null", () => {
    expect(shouldPreview("trendline", null)).toBe(false);
  });

  it("returns false for brush (handled by capture FSM)", () => {
    expect(shouldPreview("brush", A(0, 100))).toBe(false);
  });

  it("returns false when cursor.time is NaN", () => {
    expect(shouldPreview("trendline", A(NaN, 100))).toBe(false);
  });

  it("returns false when cursor.price is NaN", () => {
    expect(shouldPreview("trendline", A(0, NaN))).toBe(false);
  });

  it("returns false when cursor.time is +Infinity", () => {
    expect(shouldPreview("trendline", A(Infinity, 100))).toBe(false);
  });

  it("returns true for a normal cursor on every non-brush kind", () => {
    const cursor = A(60_000, 100);
    const kinds: DrawingKind[] = [
      "trendline", "horizontalLine", "verticalLine", "rectangle", "fibRetracement",
      "ray", "extendedLine", "horizontalRay", "parallelChannel", "longPosition",
      "shortPosition", "text", "callout", "arrow", "dateRange", "priceRange",
      "priceDateRange", "pitchfork", "gannFan", "ellipse", "fibExtension",
      "fibTimeZones", "fibFan", "fibArcs", "icon",
    ];
    for (const k of kinds) {
      expect(shouldPreview(k, cursor)).toBe(true);
    }
  });
});

describe("preview — padPreviewAnchors", () => {
  const cursor = A(60_000, 110);

  it("returns null for brush", () => {
    expect(padPreviewAnchors("brush", [], cursor)).toBeNull();
  });

  it("pads 0 placed → [cursor] for single-anchor kinds", () => {
    const out = padPreviewAnchors("text", [], cursor);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(1);
    expect(out?.[0]).toBe(cursor);
  });

  it("pads 0 placed → [cursor, cursor] for 2-anchor kinds", () => {
    const out = padPreviewAnchors("trendline", [], cursor);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(2);
    expect(out?.[0]).toBe(cursor);
    expect(out?.[1]).toBe(cursor);
  });

  it("pads 0 placed → [cursor, cursor, cursor] for 3-anchor kinds", () => {
    const out = padPreviewAnchors("parallelChannel", [], cursor);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(3);
  });

  it("pads 1 placed → [placed[0], cursor] for 2-anchor kinds", () => {
    const placed = A(0, 100);
    const out = padPreviewAnchors("trendline", [placed], cursor);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(2);
    expect(out?.[0]).toBe(placed);
    expect(out?.[1]).toBe(cursor);
  });

  it("pads 1 placed → [placed[0], cursor, cursor] for 3-anchor kinds", () => {
    const placed = A(0, 100);
    const out = padPreviewAnchors("parallelChannel", [placed], cursor);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(3);
    expect(out?.[0]).toBe(placed);
    expect(out?.[1]).toBe(cursor);
    expect(out?.[2]).toBe(cursor);
  });

  it("pads 2 placed → [placed[0], placed[1], cursor] for 3-anchor kinds", () => {
    const a0 = A(0, 100);
    const a1 = A(60_000, 110);
    const out = padPreviewAnchors("parallelChannel", [a0, a1], cursor);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(3);
    expect(out?.[0]).toBe(a0);
    expect(out?.[1]).toBe(a1);
    expect(out?.[2]).toBe(cursor);
  });

  it("doesn't truncate excess placed anchors (pads only up to required)", () => {
    const a0 = A(0, 100);
    const a1 = A(60_000, 110);
    const a2 = A(120_000, 120);
    // 2-anchor kind given 3 placed — returns first 2.
    const out = padPreviewAnchors("trendline", [a0, a1, a2], cursor);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(2);
    expect(out?.[0]).toBe(a0);
    expect(out?.[1]).toBe(a1);
  });

  it("3-anchor pitchfork preview matches parallelChannel padding semantics", () => {
    const a0 = A(0, 100);
    const a1 = A(60_000, 110);
    const out = padPreviewAnchors("pitchfork", [a0, a1], cursor);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(3);
    expect(out?.[2]).toBe(cursor);
  });

  it("PREVIEW_DRAWING_ID is a stable string id", () => {
    expect(typeof PREVIEW_DRAWING_ID).toBe("string");
    expect(String(PREVIEW_DRAWING_ID)).toContain("preview");
  });
});
