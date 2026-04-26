/**
 * Per-fib-drawing BitmapText pool. Mirrors the `CrosshairController` pattern:
 * one atlas seed on construction so the first live render does not pay a
 * glyph-generation hitch, in-place font swap on theme change, and a pool that
 * grows but never shrinks (extras hidden via `visible = false`).
 *
 * Labels render a small pill-style background using a shared `GraphicsContext`
 * keyed by `(bg, w, h)`, parented to `drawingsHandlesLayer` so they escape the
 * plot clip.
 */

import { BitmapText, Container, Graphics, GraphicsContext } from "pixi.js";
import type { PriceFormatter, Theme } from "../../types.js";
import type { FibLevelGeom } from "./project.js";

const ATLAS_SEED = "0123456789-.%, ";
const PADDING_X = 4;
const PADDING_Y = 2;
const LABEL_X_OFFSET = 4;

interface LabelEntry {
  readonly container: Container;
  readonly bg: Graphics;
  readonly text: BitmapText;
  lastText: string;
  lastWidth: number;
  lastHeight: number;
  lastBgColor: number;
}

export interface FibLabelSyncContext {
  readonly theme: Theme;
  readonly priceFormatter: PriceFormatter;
  readonly showPrices: boolean;
  readonly showPercents: boolean;
  /** Right edge of the fib level region (labels render at `xMax + 4`). */
  readonly xRight: number;
  /**
   * Plot rect width in CSS px. Labels are clamped so they never render outside
   * the plot — when `xRight + label.width + offset > plotWidth`, labels flip
   * to the **left** side of the fib endpoint instead. Fixes the mobile
   * narrow-viewport clipping case (G11) where labels would overflow the right
   * edge into the price-axis gutter.
   */
  readonly plotWidth: number;
}

export class FibLabelPool {
  private readonly parent: Container;
  private readonly entries: LabelEntry[] = [];
  private readonly bgContextCache = new Map<string, GraphicsContext>();

  private lastFontFamily = "Arial";
  private lastFontSize = 11;
  private destroyed = false;

  constructor(parent: Container) {
    this.parent = parent;
  }

  /**
   * Sync labels to the projected level set. `levels` is iterated in order; the
   * pool grows to `levels.length` once and is never shrunk — extras are hidden.
   */
  sync(
    levels: readonly FibLevelGeom[],
    ctx: FibLabelSyncContext,
  ): void {
    if (this.destroyed) {
      return;
    }
    this.applyFontIfChanged(ctx.theme.fontFamily, ctx.theme.fontSize);
    let visibleCount = 0;
    for (const lvl of levels) {
      if (!lvl.visible) {
        continue;
      }
      const labelText = formatFibLabel(lvl.value, lvl.price, ctx);
      if (labelText.length === 0) {
        continue;
      }
      const entry = this.acquireEntry(visibleCount);
      this.applyEntry(entry, labelText, lvl.snappedY, ctx);
      visibleCount += 1;
    }
    for (let i = visibleCount; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e !== undefined) {
        e.container.visible = false;
      }
    }
  }

  /** Hide every label without freeing pool memory (called when fib invisible). */
  hideAll(): void {
    for (const entry of this.entries) {
      entry.container.visible = false;
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const entry of this.entries) {
      entry.container.parent?.removeChild(entry.container);
      entry.container.destroy({ children: true });
    }
    this.entries.length = 0;
    for (const ctx of this.bgContextCache.values()) {
      ctx.destroy();
    }
    this.bgContextCache.clear();
  }

  // ─── Introspection (tests) ────────────────────────────────────────────

  poolSize(): number {
    return this.entries.length;
  }

  visibleCount(): number {
    let c = 0;
    for (const e of this.entries) {
      if (e.container.visible) {
        c += 1;
      }
    }
    return c;
  }

  /** Test-only: read-back the entry container at a pool index, or null. */
  entryAt(idx: number): { readonly position: { readonly x: number; readonly y: number }; readonly visible: boolean } | null {
    const entry = this.entries[idx];
    if (entry === undefined) {
      return null;
    }
    return {
      position: { x: entry.container.position.x, y: entry.container.position.y },
      visible: entry.container.visible,
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private acquireEntry(idx: number): LabelEntry {
    const existing = this.entries[idx];
    if (existing !== undefined) {
      return existing;
    }
    const container = new Container({ label: `fibLabel:${String(idx)}`, eventMode: "none" });
    const bg = new Graphics();
    const text = new BitmapText({
      text: "",
      style: {
        fontFamily: this.lastFontFamily,
        fontSize: this.lastFontSize,
        fill: 0xffffff,
      },
    });
    // Atlas seed so the first live label doesn't pay glyph generation.
    text.text = ATLAS_SEED;
    text.text = "";
    text.position.set(PADDING_X, PADDING_Y);
    container.addChild(bg);
    container.addChild(text);
    container.visible = false;
    this.parent.addChild(container);
    const entry: LabelEntry = {
      container,
      bg,
      text,
      lastText: "",
      lastWidth: 0,
      lastHeight: 0,
      lastBgColor: -1,
    };
    this.entries.push(entry);
    return entry;
  }

  private applyEntry(
    entry: LabelEntry,
    labelText: string,
    snappedY: number,
    ctx: FibLabelSyncContext,
  ): void {
    if (entry.lastText !== labelText) {
      entry.text.text = labelText;
      entry.lastText = labelText;
    }
    const w = Math.ceil(entry.text.width) + PADDING_X * 2;
    const h = Math.ceil(entry.text.height) + PADDING_Y * 2;
    const bgColor = ctx.theme.crosshairTagBg;
    if (entry.lastWidth !== w || entry.lastHeight !== h || entry.lastBgColor !== bgColor) {
      entry.bg.context = this.bgContext(bgColor, w, h);
      entry.lastWidth = w;
      entry.lastHeight = h;
      entry.lastBgColor = bgColor;
    }
    entry.text.style.fill = ctx.theme.crosshairTagText;
    // G11 fix — clamp label X so it never overflows the plot rect. When the
    // default right-side placement would clip, flip to the left of the fib
    // endpoint. Last resort: clamp to plot edge so the label is at least
    // partially visible rather than fully offscreen.
    const rightX = ctx.xRight + LABEL_X_OFFSET;
    let placedX = rightX;
    if (Number.isFinite(ctx.plotWidth) && rightX + w > ctx.plotWidth) {
      const leftX = ctx.xRight - LABEL_X_OFFSET - w;
      if (leftX >= 0) {
        placedX = leftX;
      } else {
        placedX = Math.max(0, ctx.plotWidth - w);
      }
    }
    entry.container.position.set(placedX, snappedY - h / 2);
    entry.container.visible = true;
  }

  private bgContext(color: number, w: number, h: number): GraphicsContext {
    const key = `${String(color)}|${String(w)}|${String(h)}`;
    const cached = this.bgContextCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const c = new GraphicsContext()
      .roundRect(0, 0, w, h, 3)
      .fill({ color, alpha: 0.85 });
    this.bgContextCache.set(key, c);
    return c;
  }

  private applyFontIfChanged(fontFamily: string, fontSize: number): void {
    if (fontFamily === this.lastFontFamily && fontSize === this.lastFontSize) {
      return;
    }
    this.lastFontFamily = fontFamily;
    this.lastFontSize = fontSize;
    for (const entry of this.entries) {
      entry.text.style.fontFamily = fontFamily;
      entry.text.style.fontSize = fontSize;
      // Re-seed atlas under the new style.
      const prev = entry.text.text;
      entry.text.text = ATLAS_SEED;
      entry.text.text = prev;
      entry.lastWidth = 0;
      entry.lastHeight = 0;
    }
  }
}

function formatFibLabel(value: number, price: number, ctx: FibLabelSyncContext): string {
  const parts: string[] = [];
  if (ctx.showPercents) {
    parts.push(`${(value * 100).toFixed(1)}%`);
  }
  if (ctx.showPrices) {
    parts.push(ctx.priceFormatter(price));
  }
  return parts.join(" ");
}
