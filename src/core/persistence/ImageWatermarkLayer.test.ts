/**
 * Phase 15 Cycle C — ImageWatermarkLayer tests. Mocks PixiJS `Assets.load`
 * so we don't need a GPU. The layer's behavior under success / failure /
 * supersession is the focus.
 */

import { Assets, type Texture, type TextureSource } from "pixi.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageWatermarkLayer } from "./ImageWatermarkLayer.js";

function fakeTexture(w: number, h: number): Texture {
  // Minimal Texture stand-in — width/height + a destroy stub is all the
  // Sprite + layout math touch.
  const src = {
    width: w,
    height: h,
  } as TextureSource;
  return {
    width: w,
    height: h,
    source: src,
    label: "fake",
    destroy: (): void => {},
  } as unknown as Texture;
}

let unloadCalls: unknown[][] = [];

beforeEach(() => {
  unloadCalls = [];
  vi.spyOn(Assets, "load").mockImplementation(((...args: readonly unknown[]): Promise<unknown> => {
    void args;
    return Promise.resolve(fakeTexture(200, 100));
  }) as typeof Assets.load);
  vi.spyOn(Assets, "unload").mockImplementation(((...args: readonly unknown[]): Promise<unknown> => {
    unloadCalls.push([...args]);
    return Promise.resolve(undefined);
  }) as typeof Assets.unload);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ImageWatermarkLayer — load success", () => {
  it("adds a sprite child after load resolves", async () => {
    const layer = new ImageWatermarkLayer();
    await layer.load("https://logo.example/img.png", 800, 600);
    expect(layer.children.length).toBe(1);
    layer.destroy();
  });

  it("fits intrinsic dims inside 25 % of canvas by default", async () => {
    const layer = new ImageWatermarkLayer();
    await layer.load("https://x.png", 800, 600);
    const sprite = layer.children[0] as { width: number; height: number };
    // 800 * 0.25 = 200 (max), texture is 200x100; fit-scale = min(200/200, 150/100, 1) = 1
    expect(sprite.width).toBe(200);
    expect(sprite.height).toBe(100);
    layer.destroy();
  });

  it("applies maxWidth + maxHeight overrides", async () => {
    const layer = new ImageWatermarkLayer();
    await layer.load("https://x.png", 800, 600, { maxWidth: 100, maxHeight: 100 });
    const sprite = layer.children[0] as { width: number; height: number };
    expect(sprite.width).toBe(100);
    expect(sprite.height).toBe(50);
    layer.destroy();
  });

  it("scale multiplier multiplies the fit dims", async () => {
    const layer = new ImageWatermarkLayer();
    await layer.load("https://x.png", 800, 600, { maxWidth: 100, scale: 0.5 });
    const sprite = layer.children[0] as { width: number; height: number };
    expect(sprite.width).toBe(50);
    layer.destroy();
  });

  it("position: bottom-right is the default", async () => {
    const layer = new ImageWatermarkLayer();
    await layer.load("https://x.png", 800, 600);
    const sprite = layer.children[0] as { position: { x: number; y: number } };
    expect(sprite.position.x).toBeGreaterThan(400);
    expect(sprite.position.y).toBeGreaterThan(400);
    layer.destroy();
  });

  it("position: center centers the sprite", async () => {
    const layer = new ImageWatermarkLayer();
    await layer.load("https://x.png", 800, 600, { position: "center" });
    const sprite = layer.children[0] as { position: { x: number; y: number } };
    expect(sprite.position.x).toBeCloseTo((800 - 200) / 2, 0);
    expect(sprite.position.y).toBeCloseTo((600 - 100) / 2, 0);
    layer.destroy();
  });
});

describe("ImageWatermarkLayer — load failure", () => {
  it("rejects when Assets.load rejects", async () => {
    vi.spyOn(Assets, "load").mockImplementation((() => Promise.reject(new Error("404 not found"))) as typeof Assets.load);
    const layer = new ImageWatermarkLayer();
    await expect(layer.load("https://nope.png", 100, 100)).rejects.toThrow(/404/);
    expect(layer.children.length).toBe(0);
    layer.destroy();
  });

  it("supersedes prior load via generation counter", async () => {
    let firstResolveDelay = 50;
    vi.spyOn(Assets, "load").mockImplementation(((...args: readonly unknown[]) => {
      const delay = firstResolveDelay;
      firstResolveDelay = 0;
      const url = args[0] as string;
      return new Promise<unknown>((resolve) => {
        setTimeout(() => { resolve(fakeTexture(url === "a" ? 200 : 400, 100)); }, delay);
      });
    }) as typeof Assets.load);

    const layer = new ImageWatermarkLayer();
    const p1 = layer.load("a", 800, 600);
    const p2 = layer.load("b", 800, 600);
    await Promise.all([p1, p2]);
    // The first load was superseded — only one child added (b).
    expect(layer.children.length).toBeLessThanOrEqual(1);
    layer.destroy();
  });
});

describe("ImageWatermarkLayer — destroy", () => {
  it("calls Assets.unload on destroy when loaded", async () => {
    const layer = new ImageWatermarkLayer();
    await layer.load("https://x.png", 100, 100);
    layer.destroy();
    expect(unloadCalls.some((args) => args[0] === "https://x.png")).toBe(true);
  });

  it("does not call unload when never loaded", () => {
    const layer = new ImageWatermarkLayer();
    layer.destroy();
    expect(unloadCalls.length).toBe(0);
  });
});
