import { describe, expect, it } from "vitest";
import { computePaneRectBundles, computePaneRects } from "./PaneLayout.js";

const OPTS = { bottomMargin: 28, minHeight: 50 } as const;

describe("PaneLayout.computePaneRects", () => {
  it("returns one full-canvas rect for a single pane (matches legacy plotRect)", () => {
    const rects = computePaneRects(800, 400, [{ stretchFactor: 1, minHeight: 50 }], OPTS);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 800, h: 372 });
  });

  it("distributes 2 panes by 0.75 / 0.25 stretch factors", () => {
    const rects = computePaneRects(
      800,
      600,
      [
        { stretchFactor: 0.75, minHeight: 50 },
        { stretchFactor: 0.25, minHeight: 50 },
      ],
      OPTS,
    );
    expect(rects).toHaveLength(2);
    // available = 572. 75% = 429, 25% = 143.
    expect(rects[0]?.y).toBe(0);
    expect(rects[0]?.h).toBe(429);
    expect(rects[1]?.y).toBe(429);
    expect(rects[1]?.h).toBe(143);
    expect((rects[0]?.h ?? 0) + (rects[1]?.h ?? 0)).toBe(572);
  });

  it("distributes 4 panes equally when factors are uniform", () => {
    const rects = computePaneRects(
      800,
      600,
      Array.from({ length: 4 }, () => ({ stretchFactor: 1, minHeight: 50 })),
      OPTS,
    );
    expect(rects).toHaveLength(4);
    const totalH = rects.reduce((acc, r) => acc + r.h, 0);
    expect(totalH).toBe(572);
    // Each pane is ~143; rounding can vary by 1 px between rows.
    for (const r of rects) {
      expect(Math.abs(r.h - 143)).toBeLessThanOrEqual(1);
    }
  });

  it("falls back to equal distribution when sum(stretchFactor) === 0", () => {
    const rects = computePaneRects(
      800,
      600,
      [
        { stretchFactor: 0, minHeight: 50 },
        { stretchFactor: 0, minHeight: 50 },
      ],
      OPTS,
    );
    expect(rects).toHaveLength(2);
    expect(rects[0]?.h).toBeGreaterThan(0);
    expect(rects[1]?.h).toBeGreaterThan(0);
    expect((rects[0]?.h ?? 0) + (rects[1]?.h ?? 0)).toBe(572);
  });

  it("treats negative or non-finite stretch factors as 0", () => {
    const rects = computePaneRects(
      800,
      600,
      [
        { stretchFactor: 1, minHeight: 50 },
        { stretchFactor: Number.NaN, minHeight: 50 },
        { stretchFactor: -2, minHeight: 50 },
      ],
      OPTS,
    );
    expect(rects).toHaveLength(3);
    // Only the first pane has a positive factor → it should get 100% (after minHeight).
    expect(rects[0]?.h).toBeGreaterThan(rects[1]?.h ?? Number.POSITIVE_INFINITY);
    expect(rects[1]?.h).toBe(50);
    expect(rects[2]?.h).toBe(50);
  });

  it("steals from largest flex pane to enforce minHeight", () => {
    const rects = computePaneRects(
      800,
      400,
      [
        { stretchFactor: 0.95, minHeight: 50 },
        { stretchFactor: 0.05, minHeight: 50 },
      ],
      OPTS,
    );
    // available = 372. Raw: 353.4 / 18.6. Pane 1 below min (50), so steal from pane 0.
    expect(rects).toHaveLength(2);
    expect(rects[1]?.h).toBeGreaterThanOrEqual(50);
    expect((rects[0]?.h ?? 0) + (rects[1]?.h ?? 0)).toBe(372);
  });

  it("rounds heights to integer pixels and keeps the stack exact", () => {
    const rects = computePaneRects(
      800,
      619, // odd → forces rounding
      [
        { stretchFactor: 0.6, minHeight: 50 },
        { stretchFactor: 0.4, minHeight: 50 },
      ],
      OPTS,
    );
    for (const r of rects) {
      expect(Number.isInteger(r.y)).toBe(true);
      expect(Number.isInteger(r.h)).toBe(true);
    }
    const total = rects.reduce((acc, r) => acc + r.h, 0);
    expect(total).toBe(619 - 28);
  });

  it("returns empty array on non-finite chart height", () => {
    expect(computePaneRects(800, Number.NaN, [{ stretchFactor: 1, minHeight: 50 }], OPTS)).toEqual([]);
    expect(
      computePaneRects(800, Number.POSITIVE_INFINITY, [{ stretchFactor: 1, minHeight: 50 }], OPTS),
    ).toEqual([]);
  });

  it("returns empty array on chart height ≤ 0", () => {
    expect(computePaneRects(800, 0, [{ stretchFactor: 1, minHeight: 50 }], OPTS)).toEqual([]);
    expect(computePaneRects(800, -100, [{ stretchFactor: 1, minHeight: 50 }], OPTS)).toEqual([]);
  });

  it("returns empty array on zero panes", () => {
    expect(computePaneRects(800, 600, [], OPTS)).toEqual([]);
  });

  it("hard-floors any pane's minHeight to 30 px", () => {
    const rects = computePaneRects(
      800,
      400,
      [
        { stretchFactor: 1, minHeight: 10 }, // below hard floor
        { stretchFactor: 0.05, minHeight: 5 }, // below hard floor
      ],
      { bottomMargin: 28, minHeight: 30 },
    );
    expect(rects[1]?.h).toBeGreaterThanOrEqual(30);
  });

  it("excludes hidden panes from layout (height = 0)", () => {
    const rects = computePaneRects(
      800,
      600,
      [
        { stretchFactor: 1, minHeight: 50 },
        { stretchFactor: 1, minHeight: 50, hidden: true },
      ],
      OPTS,
    );
    expect(rects).toHaveLength(2);
    expect(rects[0]?.h).toBe(572);
    expect(rects[1]?.h).toBe(0);
  });

  it("pinned heightOverride is subtracted from availableHeight first", () => {
    const rects = computePaneRects(
      800,
      600,
      [
        { stretchFactor: 1, minHeight: 50 },
        { stretchFactor: 1, minHeight: 50, heightOverride: 150 },
      ],
      OPTS,
    );
    expect(rects).toHaveLength(2);
    // available = 572, pinned = 150, flex pane gets 422.
    expect(rects[0]?.h).toBe(422);
    expect(rects[1]?.h).toBe(150);
  });

  it("multi-pinned panes leave the flex pane with the remainder", () => {
    const rects = computePaneRects(
      800,
      600,
      [
        { stretchFactor: 1, minHeight: 50 },
        { stretchFactor: 1, minHeight: 50, heightOverride: 100 },
        { stretchFactor: 1, minHeight: 50, heightOverride: 80 },
      ],
      OPTS,
    );
    expect(rects).toHaveLength(3);
    // available = 572, pinned = 180, flex panes (only 1) gets 392.
    expect(rects[0]?.h).toBe(392);
    expect(rects[1]?.h).toBe(100);
    expect(rects[2]?.h).toBe(80);
  });

  it("overflows when Σ minHeight > availableHeight (cycle B will collapse)", () => {
    const rects = computePaneRects(
      800,
      200, // available = 172
      [
        { stretchFactor: 1, minHeight: 100 },
        { stretchFactor: 1, minHeight: 100 },
      ],
      OPTS,
    );
    expect(rects).toHaveLength(2);
    const total = rects.reduce((acc, r) => acc + r.h, 0);
    expect(total).toBeGreaterThan(172);
  });

  // ─── Phase 14 Cycle C ────────────────────────────────────────────────

  describe("cycle C — collapsed panes + headerHeight", () => {
    it("collapsed panes contribute exactly headerHeight (plot region = 0)", () => {
      const bundles = computePaneRectBundles(
        800,
        600,
        [
          { stretchFactor: 1, minHeight: 50 },
          { stretchFactor: 1, minHeight: 50, collapsed: true, headerHeight: 24 },
        ],
        OPTS,
      );
      expect(bundles).toHaveLength(2);
      // Plot region of collapsed pane is 0; header is 24.
      expect(bundles[1]?.rect.h).toBe(0);
      expect(bundles[1]?.headerRect.h).toBe(24);
      expect(bundles[1]?.outerRect.h).toBe(24);
      // First pane gets all the leftover flex space.
      expect((bundles[0]?.outerRect.h ?? 0) + 24).toBeLessThanOrEqual(572);
    });

    it("hidden panes still contribute 0 (header skipped)", () => {
      const bundles = computePaneRectBundles(
        800,
        600,
        [
          { stretchFactor: 1, minHeight: 50 },
          { stretchFactor: 1, minHeight: 50, hidden: true, headerHeight: 24 },
        ],
        OPTS,
      );
      expect(bundles).toHaveLength(2);
      expect(bundles[1]?.rect.h).toBe(0);
      expect(bundles[1]?.headerRect.h).toBe(0);
      expect(bundles[1]?.outerRect.h).toBe(0);
    });

    it("reserves headerHeight above each pane's plot region", () => {
      const bundles = computePaneRectBundles(
        800,
        600,
        [
          { stretchFactor: 1, minHeight: 50 },
          { stretchFactor: 1, minHeight: 50, headerHeight: 24 },
        ],
        OPTS,
      );
      expect(bundles).toHaveLength(2);
      // Header strip sits at the top of pane 1's outer band.
      expect(bundles[1]?.headerRect.y).toBe(bundles[1]?.outerRect.y);
      expect(bundles[1]?.headerRect.h).toBe(24);
      // Plot region starts directly below the header.
      expect(bundles[1]?.rect.y).toBe(
        (bundles[1]?.outerRect.y ?? 0) + (bundles[1]?.headerRect.h ?? 0),
      );
    });

    it("computePaneRects (legacy) returns plot rects only — back-compat", () => {
      const rects = computePaneRects(
        800,
        600,
        [
          { stretchFactor: 1, minHeight: 50 },
          { stretchFactor: 1, minHeight: 50, headerHeight: 24 },
        ],
        OPTS,
      );
      expect(rects).toHaveLength(2);
      // Both rects are plot regions; pane 1's plot starts 24 px below its
      // outer top.
      expect(rects[0]?.y).toBe(0);
      expect(rects[1]?.y).toBeGreaterThan(rects[0]?.h ?? 0);
    });

    it("ignores non-finite / negative headerHeight (treats as 0)", () => {
      const bundles = computePaneRectBundles(
        800,
        600,
        [
          { stretchFactor: 1, minHeight: 50 },
          { stretchFactor: 1, minHeight: 50, headerHeight: -5 },
          { stretchFactor: 1, minHeight: 50, headerHeight: Number.NaN },
        ],
        OPTS,
      );
      expect(bundles[1]?.headerRect.h).toBe(0);
      expect(bundles[2]?.headerRect.h).toBe(0);
    });

    it("3-pane collapse scenario — 2 collapsed contribute 24px each, 1 expanded fills the rest", () => {
      const bundles = computePaneRectBundles(
        800,
        600,
        [
          { stretchFactor: 1, minHeight: 50 },
          { stretchFactor: 1, minHeight: 50, collapsed: true, headerHeight: 24 },
          { stretchFactor: 1, minHeight: 50, collapsed: true, headerHeight: 24 },
        ],
        OPTS,
      );
      // available - bottomMargin - 2 headers = 572 - 48 = 524 for the
      // expanded pane.
      expect(bundles[0]?.rect.h).toBe(524);
      expect(bundles[1]?.outerRect.h).toBe(24);
      expect(bundles[2]?.outerRect.h).toBe(24);
    });
  });
});
