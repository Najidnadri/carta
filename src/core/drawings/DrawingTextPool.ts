/**
 * Generic per-drawing pooled `BitmapText` + pill-background renderer used by
 * Cycle B.2 drawing kinds (text, callout, ranges, position readouts). Mirrors
 * the discipline of `FibLabelPool` but is drawing-kind-agnostic — caller
 * computes placement, pool handles BitmapText / Graphics lifecycle.
 *
 * Atlas seed on construction so the first live label does not pay
 * glyph-generation hitch. Pool grows but never shrinks (extras hidden via
 * `visible = false`). Pill backgrounds use a shared `GraphicsContext` cache
 * keyed by `(bgColor, w, h)` to avoid per-label geometry uploads.
 */

import { BitmapText, Container, Graphics, GraphicsContext } from "pixi.js";
import type { Theme } from "../../types.js";

const PADDING_X = 4;
const PADDING_Y = 2;
const BG_RADIUS = 3;
const BG_ALPHA = 0.85;

/** Default seed covers ASCII digits, punctuation, units we use across B.2. */
export const DEFAULT_TEXT_ATLAS_SEED =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz +-.:%/$dhms,";

export interface DrawingTextSpec {
  /** Text content. Empty string → entry hidden. */
  readonly text: string;
  /** Top-left of the pill (caller has already done clamp / flip). */
  readonly x: number;
  readonly y: number;
  /** Pill background color. */
  readonly bgColor: number;
  /** Text color. */
  readonly textColor: number;
  /** Optional per-spec alpha for the bg pill. Defaults to `0.85`. */
  readonly bgAlpha?: number;
  /** Optional explicit width override (use for BG that hugs multi-line text). */
  readonly minWidth?: number;
  /** Optional left/right padding override per spec. */
  readonly paddingX?: number;
  readonly paddingY?: number;
}

interface PoolEntry {
  readonly container: Container;
  readonly bg: Graphics;
  readonly text: BitmapText;
  lastText: string;
  lastWidth: number;
  lastHeight: number;
  lastBgColor: number;
  lastBgAlpha: number;
}

export class DrawingTextPool {
  private readonly parent: Container;
  private readonly atlasSeed: string;
  private readonly entries: PoolEntry[] = [];
  private readonly bgContextCache = new Map<string, GraphicsContext>();

  private lastFontFamily = "Arial";
  private lastFontSize = 11;
  private destroyed = false;

  constructor(parent: Container, atlasSeed: string = DEFAULT_TEXT_ATLAS_SEED) {
    this.parent = parent;
    this.atlasSeed = atlasSeed;
  }

  /** Sync entries to `specs`. Empty `text` strings hide the corresponding entry. */
  sync(specs: readonly DrawingTextSpec[], theme: Theme): void {
    if (this.destroyed) {
      return;
    }
    this.applyFontIfChanged(theme.fontFamily, theme.fontSize);
    let visibleCount = 0;
    for (const spec of specs) {
      if (spec.text.length === 0) {
        continue;
      }
      const entry = this.acquireEntry(visibleCount);
      this.applyEntry(entry, spec);
      visibleCount += 1;
    }
    for (let i = visibleCount; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e !== undefined) {
        e.container.visible = false;
      }
    }
  }

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

  entryAt(idx: number): {
    readonly position: { readonly x: number; readonly y: number };
    readonly visible: boolean;
    readonly text: string;
  } | null {
    const entry = this.entries[idx];
    if (entry === undefined) {
      return null;
    }
    return {
      position: { x: entry.container.position.x, y: entry.container.position.y },
      visible: entry.container.visible,
      text: entry.lastText,
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private acquireEntry(idx: number): PoolEntry {
    const existing = this.entries[idx];
    if (existing !== undefined) {
      return existing;
    }
    const container = new Container({ label: `drawingText:${String(idx)}`, eventMode: "none" });
    const bg = new Graphics();
    const text = new BitmapText({
      text: "",
      style: {
        fontFamily: this.lastFontFamily,
        fontSize: this.lastFontSize,
        fill: 0xffffff,
      },
    });
    text.text = this.atlasSeed;
    text.text = "";
    container.addChild(bg);
    container.addChild(text);
    container.visible = false;
    this.parent.addChild(container);
    const entry: PoolEntry = {
      container,
      bg,
      text,
      lastText: "",
      lastWidth: 0,
      lastHeight: 0,
      lastBgColor: -1,
      lastBgAlpha: -1,
    };
    this.entries.push(entry);
    return entry;
  }

  private applyEntry(entry: PoolEntry, spec: DrawingTextSpec): void {
    if (entry.lastText !== spec.text) {
      entry.text.text = spec.text;
      entry.lastText = spec.text;
    }
    const padX = spec.paddingX ?? PADDING_X;
    const padY = spec.paddingY ?? PADDING_Y;
    const minW = spec.minWidth ?? 0;
    const w = Math.max(minW, Math.ceil(entry.text.width) + padX * 2);
    const h = Math.ceil(entry.text.height) + padY * 2;
    const bgAlpha = spec.bgAlpha ?? BG_ALPHA;
    if (
      entry.lastWidth !== w ||
      entry.lastHeight !== h ||
      entry.lastBgColor !== spec.bgColor ||
      entry.lastBgAlpha !== bgAlpha
    ) {
      entry.bg.context = this.bgContext(spec.bgColor, bgAlpha, w, h);
      entry.lastWidth = w;
      entry.lastHeight = h;
      entry.lastBgColor = spec.bgColor;
      entry.lastBgAlpha = bgAlpha;
    }
    entry.text.position.set(padX, padY);
    entry.text.style.fill = spec.textColor;
    entry.container.position.set(spec.x, spec.y);
    entry.container.visible = true;
  }

  private bgContext(color: number, alpha: number, w: number, h: number): GraphicsContext {
    const key = `${String(color)}|${alpha.toFixed(3)}|${String(w)}|${String(h)}`;
    const cached = this.bgContextCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const c = new GraphicsContext().roundRect(0, 0, w, h, BG_RADIUS).fill({ color, alpha });
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
      const prev = entry.text.text;
      entry.text.text = this.atlasSeed;
      entry.text.text = prev;
      entry.lastWidth = 0;
      entry.lastHeight = 0;
    }
  }
}
