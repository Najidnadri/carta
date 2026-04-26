import { describe, expect, it, vi } from "vitest";
import type * as PixiNS from "pixi.js";

vi.mock("pixi.js", async () => {
  const actual = await vi.importActual<typeof PixiNS>("pixi.js");
  class FakeBitmapText extends actual.Container {
    text = "";
    style: { fontFamily: string; fontSize: number; fill: number } = {
      fontFamily: "Arial",
      fontSize: 11,
      fill: 0xffffff,
    };
    get width(): number {
      return this.text.length * 6;
    }
    // eslint-disable-next-line @typescript-eslint/class-literal-property-style
    get height(): number {
      return 11;
    }
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
import { DarkTheme } from "../infra/themes.js";
import {
  LabelPool,
  type EndOfRayLabelSpec,
  type LabelSyncContext,
  type RightOfCxLabelSpec,
  type RightOfXLabelSpec,
  type TopOfXLabelSpec,
} from "./LabelPool.js";

const ctx = (plotWidth = 400): LabelSyncContext => Object.freeze({ theme: DarkTheme, plotWidth });

describe("LabelPool", () => {
  it("grows pool monotonically and hides extras when spec count shrinks", () => {
    const parent = new Container();
    const pool = new LabelPool(parent);
    const specs: RightOfXLabelSpec[] = [
      { placement: "right-of-x", text: "0%", xRight: 100, y: 0 },
      { placement: "right-of-x", text: "50%", xRight: 100, y: 50 },
      { placement: "right-of-x", text: "100%", xRight: 100, y: 100 },
    ];
    pool.sync(specs, ctx());
    expect(pool.poolSize()).toBe(3);
    expect(pool.visibleCount()).toBe(3);
    pool.sync([specs[0]!], ctx());
    expect(pool.poolSize()).toBe(3);
    expect(pool.visibleCount()).toBe(1);
    pool.destroy();
  });

  it("'right-of-x' flips left when right placement overflows plotWidth", () => {
    const parent = new Container();
    const pool = new LabelPool(parent);
    const spec: RightOfXLabelSpec = {
      placement: "right-of-x",
      text: "long-label-text",
      xRight: 180,
      y: 50,
    };
    pool.sync([spec], ctx(200));
    const e = pool.entryAt(0);
    if (e === null) {
      throw new Error("expected entry");
    }
    // Label should sit to the left of xRight=180.
    expect(e.position.x).toBeLessThan(180);
    pool.destroy();
  });

  it("'top-of-x' clamps to plot edges", () => {
    const parent = new Container();
    const pool = new LabelPool(parent);
    const left: TopOfXLabelSpec = { placement: "top-of-x", text: "1", x: 4, y: 2 };
    const right: TopOfXLabelSpec = { placement: "top-of-x", text: "8", x: 396, y: 2 };
    pool.sync([left, right], ctx(400));
    const eL = pool.entryAt(0);
    const eR = pool.entryAt(1);
    if (eL === null || eR === null) {
      throw new Error("expected entries");
    }
    expect(eL.position.x).toBeGreaterThanOrEqual(0);
    // Right-edge label should not overflow plotWidth.
    expect(eR.position.x + 14).toBeLessThanOrEqual(400);
    pool.destroy();
  });

  it("'end-of-ray' clamps when right placement overflows", () => {
    const parent = new Container();
    const pool = new LabelPool(parent);
    const spec: EndOfRayLabelSpec = {
      placement: "end-of-ray",
      text: "61.8%",
      x: 395,
      y: 100,
    };
    pool.sync([spec], ctx(400));
    const e = pool.entryAt(0);
    if (e === null) {
      throw new Error("expected entry");
    }
    // Should fall to the left of x=395 (or clamp to 0).
    expect(e.position.x).toBeLessThan(395);
    pool.destroy();
  });

  it("'right-of-cx' positions the label at (cx + r + offset, cy)", () => {
    const parent = new Container();
    const pool = new LabelPool(parent);
    const spec: RightOfCxLabelSpec = {
      placement: "right-of-cx",
      text: "61.8%",
      cx: 100,
      cy: 200,
      r: 50,
    };
    pool.sync([spec], ctx(400));
    const e = pool.entryAt(0);
    if (e === null) {
      throw new Error("expected entry");
    }
    // Default placement = cx + r + 4 = 154; label width 5 chars × 6 + 8 padding = 38.
    expect(e.position.x).toBeGreaterThan(150);
    expect(e.position.x).toBeLessThan(160);
    // Vertically centered on cy = 200 (label height ~15) → y close to 192.
    expect(e.position.y).toBeLessThan(200);
    expect(e.position.y).toBeGreaterThan(180);
    pool.destroy();
  });

  it("'right-of-cx' clamps to plot edge when right placement overflows", () => {
    const parent = new Container();
    const pool = new LabelPool(parent);
    const spec: RightOfCxLabelSpec = {
      placement: "right-of-cx",
      text: "100%",
      cx: 380,
      cy: 100,
      r: 30,
    };
    pool.sync([spec], ctx(400));
    const e = pool.entryAt(0);
    if (e === null) {
      throw new Error("expected entry");
    }
    // Default = 380 + 30 + 4 = 414, overflows 400. Should flip to left of cx − r.
    expect(e.position.x).toBeLessThan(380 - 30);
    pool.destroy();
  });

  it("hideAll() hides without freeing the pool", () => {
    const parent = new Container();
    const pool = new LabelPool(parent);
    pool.sync([
      { placement: "right-of-x", text: "0%", xRight: 100, y: 0 },
      { placement: "right-of-x", text: "100%", xRight: 100, y: 100 },
    ], ctx());
    expect(pool.visibleCount()).toBe(2);
    pool.hideAll();
    expect(pool.visibleCount()).toBe(0);
    expect(pool.poolSize()).toBe(2);
    pool.destroy();
  });

  it("destroy() empties the pool", () => {
    const parent = new Container();
    const pool = new LabelPool(parent);
    pool.sync([{ placement: "right-of-x", text: "0%", xRight: 100, y: 0 }], ctx());
    expect(pool.poolSize()).toBe(1);
    pool.destroy();
    expect(pool.poolSize()).toBe(0);
  });

  it("skips empty-text specs", () => {
    const parent = new Container();
    const pool = new LabelPool(parent);
    pool.sync(
      [
        { placement: "right-of-x", text: "", xRight: 100, y: 0 },
        { placement: "right-of-x", text: "1.0", xRight: 100, y: 50 },
      ],
      ctx(),
    );
    expect(pool.visibleCount()).toBe(1);
    pool.destroy();
  });
});
