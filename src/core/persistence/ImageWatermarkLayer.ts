/**
 * Phase 15 Cycle C — image watermark overlay for `chart.exportPNG`.
 *
 * Mirrors `WatermarkLayer.ts` (text-only, cycle A) shape. Built fresh per
 * export and destroyed after; the layer's `load(...)` awaits the
 * `Assets.load(url)` Promise (PixiJS v8 — internal URL-keyed cache, so
 * repeat exports of the same URL reuse the texture).
 *
 * Lifecycle:
 *   const layer = new ImageWatermarkLayer();
 *   await layer.load(url, canvasW, canvasH, config);   // throws on 404 / CORS / decode
 *   stage.addChild(layer);
 *   ...render...
 *   stage.removeChild(layer);
 *   layer.destroy();                                    // calls Assets.unload(url)
 *
 * CORS-tainted images:
 *   `Assets.load` resolves with a tainted texture; the failure surfaces
 *   later when `renderer.extract.canvas` is called on the export RT —
 *   the browser throws `SecurityError`. We do NOT probe upfront — the
 *   probe would itself trip the same error. The export-pipeline catch
 *   block re-throws as `ExportError('GENERIC', 'watermark image tainted')`
 *   so the host sees the failure at click-time.
 */

import { Assets, Container, Sprite, type Texture } from "pixi.js";

export type ImageWatermarkPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "center";

export interface ImageWatermarkOptions {
  readonly position?: ImageWatermarkPosition;
  readonly opacity?: number;
  /** Multiplier on the fit-inside box. Default 1. */
  readonly scale?: number;
  /** Hard cap on rendered width in canvas px. Default = 25 % of canvas width. */
  readonly maxWidth?: number;
  /** Hard cap on rendered height in canvas px. Default = 25 % of canvas height. */
  readonly maxHeight?: number;
}

const DEFAULT_OPACITY = 0.45;
const PADDING = 12;
const DEFAULT_FIT_RATIO = 0.25;

export class ImageWatermarkLayer extends Container {
  private sprite: Sprite | null = null;
  private loadedUrl: string | null = null;
  private generation = 0;

  constructor() {
    super({ label: "carta:ImageWatermarkLayer" });
  }

  /**
   * Load `url` via `Assets.load`, lay out the sprite at the given
   * `canvasWidth` / `canvasHeight`, and add it to this container. Async —
   * the export pipeline awaits this before calling `renderer.render`.
   *
   * Rejects on 404 / DNS failure / decode error (whatever `Assets.load`
   * rejects with). CORS-tainted images resolve here and surface later at
   * extract time.
   */
  async load(
    url: string,
    canvasWidth: number,
    canvasHeight: number,
    opts: ImageWatermarkOptions = {},
  ): Promise<void> {
    const myGen = ++this.generation;
    let texture: Texture;
    try {
      texture = await Assets.load<Texture>(url);
    } catch (err: unknown) {
      // Bubble up; caller (pngExport) maps to ExportError.
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (myGen !== this.generation) {
      // Superseded — balance the ref and bail.
      try { await Assets.unload(url); } catch { /* ignore */ }
      return;
    }
    // Tear down any prior sprite (re-call). texture: false because Assets
    // owns the texture and we'll unload on destroy.
    if (this.sprite !== null) {
      this.sprite.destroy({ texture: false });
      this.sprite = null;
    }
    const sprite = new Sprite(texture);
    const opacity =
      typeof opts.opacity === "number" && opts.opacity >= 0 && opts.opacity <= 1
        ? opts.opacity
        : DEFAULT_OPACITY;
    sprite.alpha = opacity;

    const maxW = typeof opts.maxWidth === "number" && opts.maxWidth > 0
      ? opts.maxWidth
      : Math.max(1, canvasWidth * DEFAULT_FIT_RATIO);
    const maxH = typeof opts.maxHeight === "number" && opts.maxHeight > 0
      ? opts.maxHeight
      : Math.max(1, canvasHeight * DEFAULT_FIT_RATIO);
    const scaleMul =
      typeof opts.scale === "number" && Number.isFinite(opts.scale) && opts.scale > 0
        ? opts.scale
        : 1;

    const intrinsicW = Math.max(1, texture.width);
    const intrinsicH = Math.max(1, texture.height);
    const fitScale = Math.min(maxW / intrinsicW, maxH / intrinsicH, 1) * scaleMul;
    sprite.width = intrinsicW * fitScale;
    sprite.height = intrinsicH * fitScale;

    const tw = sprite.width;
    const th = sprite.height;
    const pos = opts.position ?? "bottom-right";
    switch (pos) {
      case "top-left":
        sprite.position.set(PADDING, PADDING);
        break;
      case "top-right":
        sprite.position.set(Math.max(PADDING, canvasWidth - tw - PADDING), PADDING);
        break;
      case "bottom-left":
        sprite.position.set(PADDING, Math.max(PADDING, canvasHeight - th - PADDING));
        break;
      case "center":
        sprite.position.set(
          Math.max(0, (canvasWidth - tw) / 2),
          Math.max(0, (canvasHeight - th) / 2),
        );
        break;
      case "bottom-right":
      default:
        sprite.position.set(
          Math.max(PADDING, canvasWidth - tw - PADDING),
          Math.max(PADDING, canvasHeight - th - PADDING),
        );
        break;
    }
    this.sprite = sprite;
    this.loadedUrl = url;
    this.addChild(sprite);
  }

  override destroy(): void {
    const url = this.loadedUrl;
    this.loadedUrl = null;
    if (this.sprite !== null) {
      this.sprite.destroy({ texture: false });
      this.sprite = null;
    }
    super.destroy();
    if (url !== null) {
      // Balance our Assets.load ref. Fire-and-forget — unload is async but
      // we don't need to await it; the texture is gone from our refs.
      void Assets.unload(url).catch(() => { /* ignore */ });
    }
  }
}
