import { describe, expect, it, vi } from "vitest";
import type * as PixiNS from "pixi.js";

// Stub BitmapText — the real one needs a canvas jsdom doesn't provide.
vi.mock("pixi.js", async () => {
  const actual = await vi.importActual<typeof PixiNS>("pixi.js");
  class FakeBitmapText extends actual.Container {
    text = "";
    style: { fontFamily: string; fontSize: number; fill: number } = {
      fontFamily: "Arial",
      fontSize: 11,
      fill: 0xffffff,
    };
    get width(): number { return this.text.length * 6; }
    // eslint-disable-next-line @typescript-eslint/class-literal-property-style
    get height(): number { return 11; }
    constructor(opts?: { text?: string; style?: { fontFamily?: string; fontSize?: number; fill?: number } }) {
      super();
      if (opts?.text !== undefined) {
        this.text = opts.text;
      }
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

import { Container } from "pixi.js";
import { FibLabelPool, type FibLabelSyncContext } from "./FibLabelPool.js";
import { DarkTheme } from "../infra/themes.js";
import type { FibLevelGeom } from "./project.js";

function makeLevel(value: number, y: number, price: number, visible = true): FibLevelGeom {
  return Object.freeze({
    value,
    y,
    snappedY: y,
    price,
    visible,
    color: undefined,
    alpha: undefined,
  });
}

function ctx(showPrices: boolean, showPercents: boolean, plotWidth = 400): FibLabelSyncContext {
  return Object.freeze({
    theme: DarkTheme,
    priceFormatter: (v: number): string => v.toFixed(2),
    showPrices,
    showPercents,
    xRight: 100,
    plotWidth,
  });
}

describe("FibLabelPool", () => {
  it("grows pool to match visible levels and shows the right count", () => {
    const parent = new Container();
    const pool = new FibLabelPool(parent);
    pool.sync([makeLevel(0, 0, 100), makeLevel(0.5, 50, 105), makeLevel(1, 100, 110)], ctx(true, true));
    expect(pool.poolSize()).toBe(3);
    expect(pool.visibleCount()).toBe(3);
    pool.destroy();
  });

  it("grows once and hides extras when level count shrinks", () => {
    const parent = new Container();
    const pool = new FibLabelPool(parent);
    pool.sync(
      [makeLevel(0, 0, 100), makeLevel(0.5, 50, 105), makeLevel(1, 100, 110)],
      ctx(true, true),
    );
    expect(pool.poolSize()).toBe(3);
    pool.sync([makeLevel(0, 0, 100)], ctx(true, true));
    expect(pool.poolSize()).toBe(3); // never shrinks
    expect(pool.visibleCount()).toBe(1); // extras hidden
    pool.destroy();
  });

  it("emits empty label when both flags are off, hiding the entry", () => {
    const parent = new Container();
    const pool = new FibLabelPool(parent);
    pool.sync([makeLevel(0, 0, 100)], ctx(false, false));
    expect(pool.visibleCount()).toBe(0);
    pool.destroy();
  });

  it("respects level.visible=false (skips invisible levels)", () => {
    const parent = new Container();
    const pool = new FibLabelPool(parent);
    pool.sync(
      [makeLevel(0, 0, 100, true), makeLevel(0.5, 50, 105, false), makeLevel(1, 100, 110, true)],
      ctx(true, true),
    );
    expect(pool.visibleCount()).toBe(2);
    pool.destroy();
  });

  it("hideAll() hides without freeing the pool", () => {
    const parent = new Container();
    const pool = new FibLabelPool(parent);
    pool.sync([makeLevel(0, 0, 100), makeLevel(1, 100, 110)], ctx(true, true));
    expect(pool.visibleCount()).toBe(2);
    pool.hideAll();
    expect(pool.visibleCount()).toBe(0);
    expect(pool.poolSize()).toBe(2);
    pool.destroy();
  });

  it("destroy() empties the pool", () => {
    const parent = new Container();
    const pool = new FibLabelPool(parent);
    pool.sync([makeLevel(0, 0, 100)], ctx(true, true));
    expect(pool.poolSize()).toBe(1);
    pool.destroy();
    expect(pool.poolSize()).toBe(0);
  });

  it("G11 — flips labels to the left of the fib endpoint when right placement would overflow plotWidth", () => {
    const parent = new Container();
    const pool = new FibLabelPool(parent);
    // Narrow plot (200 px); xRight at 180 means default right placement at 184
    // overflows. Label should flip to the left of xRight-LABEL_X_OFFSET.
    const narrow: FibLabelSyncContext = Object.freeze({
      theme: DarkTheme,
      priceFormatter: (v: number): string => v.toFixed(2),
      showPrices: true,
      showPercents: true,
      xRight: 180,
      plotWidth: 200,
    });
    pool.sync([makeLevel(0.5, 50, 100.0)], narrow);
    const entry = pool.entryAt(0);
    if (entry === null) {
      throw new Error("expected one entry");
    }
    // With label width ≈ 16 chars * 6 + padding, label fits to the left of 180.
    expect(entry.position.x).toBeLessThan(180);
    pool.destroy();
  });

  it("G11 fallback — clamps to plot edge when both right and left placements overflow", () => {
    const parent = new Container();
    const pool = new FibLabelPool(parent);
    // Tiny plot (50 px) and xRight at 10 — neither right (10+offset+w) nor
    // left (10-offset-w<0) fits; clamp to right edge.
    const tiny: FibLabelSyncContext = Object.freeze({
      theme: DarkTheme,
      priceFormatter: (v: number): string => v.toFixed(2),
      showPrices: true,
      showPercents: true,
      xRight: 10,
      plotWidth: 50,
    });
    pool.sync([makeLevel(0.5, 50, 100.0)], tiny);
    const entry = pool.entryAt(0);
    if (entry === null) {
      throw new Error("expected one entry");
    }
    expect(entry.position.x).toBeGreaterThanOrEqual(0);
    expect(entry.position.x).toBeLessThanOrEqual(50);
    pool.destroy();
  });
});
