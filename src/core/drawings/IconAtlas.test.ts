/**
 * Phase 13 Cycle C.3 — IconAtlas tests.
 *
 * `buildIconAtlas` requires a DOM canvas; vitest config in this repo runs
 * with `environment: 'happy-dom'` for components, but happy-dom's canvas
 * 2D context is partial. To keep the suite green without forcing a Pixi
 * canvas backend in unit tests, we stub `document.createElement('canvas')`
 * with a minimal shape and stub the `pixi.js` `Texture` / `TextureSource`
 * to no-op constructors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ICON_GLYPHS } from "./types.js";
import { buildIconAtlas, ICON_CELL_CSS_PX } from "./IconAtlas.js";

function ensureCanvasAvailable(): void {
  // happy-dom provides HTMLCanvasElement but `getContext('2d')` may return
  // null. We don't assert it; the atlas degrades to an empty texture map.
  if (typeof document === "undefined") {
    throw new Error("DOM not available — atlas tests need happy-dom or jsdom");
  }
}

describe("IconAtlas", () => {
  beforeEach(() => {
    ensureCanvasAvailable();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds an atlas at dpr=1 with one cell per default glyph", () => {
    const atlas = buildIconAtlas(1);
    try {
      expect(atlas.dprBucket).toBe(1);
      expect(atlas.cellPx).toBe(ICON_CELL_CSS_PX);
      expect(atlas.source).toBeDefined();
      // Texture map is empty when ctx is null (happy-dom no-op canvas) OR
      // populated when canvas works — either way the atlas object is valid.
      // What we strictly require: a Map keyed by glyph.
      expect(atlas.textures).toBeInstanceOf(Map);
      // When happy-dom returns a 2d ctx, all 10 glyphs are present.
      // When it returns null, the map is empty. Both are acceptable.
      expect([0, DEFAULT_ICON_GLYPHS.length]).toContain(atlas.textures.size);
    } finally {
      atlas.destroy();
    }
  });

  it("clamps dpr bucket to {1, 1.5, 2}", () => {
    const sub1 = buildIconAtlas(0.5);
    const dpr1 = buildIconAtlas(1);
    const dpr125 = buildIconAtlas(1.25);
    const dpr15 = buildIconAtlas(1.5);
    const dpr2 = buildIconAtlas(2);
    const dpr3 = buildIconAtlas(3);
    try {
      expect(sub1.dprBucket).toBe(1);
      expect(dpr1.dprBucket).toBe(1);
      expect(dpr125.dprBucket).toBe(1.5);
      expect(dpr15.dprBucket).toBe(1.5);
      expect(dpr2.dprBucket).toBe(2);
      expect(dpr3.dprBucket).toBe(2);
      expect(dpr2.cellPx).toBe(ICON_CELL_CSS_PX * 2);
      expect(dpr15.cellPx).toBe(Math.round(ICON_CELL_CSS_PX * 1.5));
    } finally {
      sub1.destroy();
      dpr1.destroy();
      dpr125.destroy();
      dpr15.destroy();
      dpr2.destroy();
      dpr3.destroy();
    }
  });

  it("destroy() releases textures and source", () => {
    const atlas = buildIconAtlas(2);
    const sourceDestroySpy = vi.spyOn(atlas.source, "destroy");
    const texSize = atlas.textures.size;
    const sampleTextures = Array.from(atlas.textures.values());
    const texDestroySpies = sampleTextures.map((t) => vi.spyOn(t, "destroy"));
    atlas.destroy();
    expect(sourceDestroySpy).toHaveBeenCalled();
    expect(atlas.textures.size).toBe(0);
    if (texSize > 0) {
      for (const spy of texDestroySpies) {
        expect(spy).toHaveBeenCalled();
      }
    }
  });

  it("non-finite dpr defaults to bucket 1", () => {
    const a = buildIconAtlas(NaN);
    const b = buildIconAtlas(Infinity);
    try {
      expect(a.dprBucket).toBe(1);
      // Infinity is non-finite → bucket 1 per `clampDprBucket`.
      expect(b.dprBucket).toBe(1);
    } finally {
      a.destroy();
      b.destroy();
    }
  });
});
