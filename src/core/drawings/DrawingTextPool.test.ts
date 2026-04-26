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
import { DrawingTextPool, type DrawingTextSpec } from "./DrawingTextPool.js";
import { DarkTheme, LightTheme } from "../infra/themes.js";

function spec(text: string, x = 0, y = 0): DrawingTextSpec {
  return Object.freeze({
    text,
    x,
    y,
    bgColor: 0x111111,
    textColor: 0xffffff,
  });
}

describe("DrawingTextPool", () => {
  it("grows pool to match visible specs", () => {
    const parent = new Container();
    const pool = new DrawingTextPool(parent);
    pool.sync([spec("a"), spec("b"), spec("c")], DarkTheme);
    expect(pool.poolSize()).toBe(3);
    expect(pool.visibleCount()).toBe(3);
    pool.destroy();
  });

  it("never shrinks; hides extras when count drops", () => {
    const parent = new Container();
    const pool = new DrawingTextPool(parent);
    pool.sync([spec("a"), spec("b"), spec("c")], DarkTheme);
    expect(pool.poolSize()).toBe(3);
    pool.sync([spec("a")], DarkTheme);
    expect(pool.poolSize()).toBe(3);
    expect(pool.visibleCount()).toBe(1);
    pool.destroy();
  });

  it("hides empty-string specs", () => {
    const parent = new Container();
    const pool = new DrawingTextPool(parent);
    pool.sync([spec(""), spec("b")], DarkTheme);
    expect(pool.visibleCount()).toBe(1);
    pool.destroy();
  });

  it("hideAll hides without freeing", () => {
    const parent = new Container();
    const pool = new DrawingTextPool(parent);
    pool.sync([spec("a"), spec("b")], DarkTheme);
    expect(pool.visibleCount()).toBe(2);
    pool.hideAll();
    expect(pool.visibleCount()).toBe(0);
    expect(pool.poolSize()).toBe(2);
    pool.destroy();
  });

  it("destroy clears the pool", () => {
    const parent = new Container();
    const pool = new DrawingTextPool(parent);
    pool.sync([spec("a")], DarkTheme);
    pool.destroy();
    expect(pool.poolSize()).toBe(0);
  });

  it("theme swap re-applies font (lastWidth/lastHeight reset)", () => {
    const parent = new Container();
    const pool = new DrawingTextPool(parent);
    pool.sync([spec("hi")], DarkTheme);
    pool.sync([spec("hi")], LightTheme); // different fontSize/fontFamily
    expect(pool.visibleCount()).toBe(1);
    pool.destroy();
  });

  it("entryAt reflects placed position + text", () => {
    const parent = new Container();
    const pool = new DrawingTextPool(parent);
    pool.sync([spec("xyz", 10, 20)], DarkTheme);
    const e = pool.entryAt(0);
    expect(e?.position.x).toBe(10);
    expect(e?.position.y).toBe(20);
    expect(e?.text).toBe("xyz");
    pool.destroy();
  });
});
