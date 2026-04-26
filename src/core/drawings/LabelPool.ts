/**
 * Phase 13 Cycle C.2 — generalized label pool. Supersedes the cycle B.1
 * `FibLabelPool`. Same atlas-seed / pill-render / theme-swap path as before;
 * the only addition is a discriminated `LabelSpec` that carries the placement
 * mode each kind emits:
 *
 *   - `'right-of-x'` — fib retracement / extension labels at `(xRight, snappedY)`
 *     with edge-flip when the right placement overflows `plotWidth`.
 *   - `'top-of-x'` — fib time-zone index labels at top of each vertical line,
 *     centered + clamped to plot edges.
 *   - `'end-of-ray'` — fib fan ray labels at the visible-segment endpoint,
 *     clamped to plot edges.
 *
 * The pool itself is placement-agnostic: each spec resolves its own (x, y)
 * position via the spec's geometry + the measured label width / height.
 */

import { BitmapText, Container, Graphics, GraphicsContext } from "pixi.js";
import type { Theme } from "../../types.js";

const ATLAS_SEED = "0123456789-.%, ";
const PADDING_X = 4;
const PADDING_Y = 2;
const LABEL_X_OFFSET = 4;

export type LabelPlacement = "right-of-x" | "top-of-x" | "end-of-ray" | "right-of-cx";

interface LabelSpecBase {
  readonly text: string;
  readonly placement: LabelPlacement;
}

export interface RightOfXLabelSpec extends LabelSpecBase {
  readonly placement: "right-of-x";
  /** Right edge of the level region; label renders at `xRight + 4` (or flipped). */
  readonly xRight: number;
  /** Vertical center of the label (typically a fib level's `snappedY`). */
  readonly y: number;
}

export interface TopOfXLabelSpec extends LabelSpecBase {
  readonly placement: "top-of-x";
  /** X center of the vertical line; label centered horizontally. */
  readonly x: number;
  /** Top y in plot-local px (typically `2`). */
  readonly y: number;
}

export interface EndOfRayLabelSpec extends LabelSpecBase {
  readonly placement: "end-of-ray";
  /** Point at the end of the visible ray segment. */
  readonly x: number;
  readonly y: number;
}

/**
 * Phase 13 Cycle C.3 — fib-arc ring label placement. Labels stack along the
 * `+x` diameter axis at `(cx + r + offset, cy)` so the percentages read like
 * a ring legend. Right-edge clamp keeps them inside the plot.
 */
export interface RightOfCxLabelSpec extends LabelSpecBase {
  readonly placement: "right-of-cx";
  /** Center x of the arc / ellipse. */
  readonly cx: number;
  /** Center y. */
  readonly cy: number;
  /** Ring radius in screen px. Label sits at `(cx + r + offset, cy)`. */
  readonly r: number;
}

export type LabelSpec = RightOfXLabelSpec | TopOfXLabelSpec | EndOfRayLabelSpec | RightOfCxLabelSpec;

interface LabelEntry {
  readonly container: Container;
  readonly bg: Graphics;
  readonly text: BitmapText;
  lastText: string;
  lastWidth: number;
  lastHeight: number;
  lastBgColor: number;
}

export interface LabelSyncContext {
  readonly theme: Theme;
  /** Plot width in CSS px — used for edge-flip / clamping in every placement mode. */
  readonly plotWidth: number;
}

export class LabelPool {
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
   * Sync labels to `specs`. Pool grows monotonically — extras are hidden.
   * Specs are processed in order; an empty `text` is skipped (the entry
   * stays hidden so the visible count matches non-empty specs).
   */
  sync(specs: readonly LabelSpec[], ctx: LabelSyncContext): void {
    if (this.destroyed) {
      return;
    }
    this.applyFontIfChanged(ctx.theme.fontFamily, ctx.theme.fontSize);
    let visibleCount = 0;
    for (const spec of specs) {
      if (spec.text.length === 0) {
        continue;
      }
      const entry = this.acquireEntry(visibleCount);
      this.applyEntry(entry, spec, ctx);
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
    const container = new Container({ label: `label:${String(idx)}`, eventMode: "none" });
    const bg = new Graphics();
    const text = new BitmapText({
      text: "",
      style: {
        fontFamily: this.lastFontFamily,
        fontSize: this.lastFontSize,
        fill: 0xffffff,
      },
    });
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

  private applyEntry(entry: LabelEntry, spec: LabelSpec, ctx: LabelSyncContext): void {
    if (entry.lastText !== spec.text) {
      entry.text.text = spec.text;
      entry.lastText = spec.text;
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
    const { x, y } = resolvePlacement(spec, w, h, ctx.plotWidth);
    entry.container.position.set(x, y);
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
      const prev = entry.text.text;
      entry.text.text = ATLAS_SEED;
      entry.text.text = prev;
      entry.lastWidth = 0;
      entry.lastHeight = 0;
    }
  }
}

/**
 * Resolve final `(x, y)` for a label given its measured `(w, h)` and the
 * current `plotWidth`. Each placement mode encodes its own clamp / flip
 * rule; positions are top-left of the label container.
 */
function resolvePlacement(
  spec: LabelSpec,
  w: number,
  h: number,
  plotWidth: number,
): { x: number; y: number } {
  switch (spec.placement) {
    case "right-of-x": {
      // Default: 4px to the right of `xRight`, vertically centered on `y`.
      // G11: flip to the left when right placement would overflow plot,
      // last-resort: clamp to plot edge.
      const rightX = spec.xRight + LABEL_X_OFFSET;
      let placedX = rightX;
      if (Number.isFinite(plotWidth) && rightX + w > plotWidth) {
        const leftX = spec.xRight - LABEL_X_OFFSET - w;
        if (leftX >= 0) {
          placedX = leftX;
        } else {
          placedX = Math.max(0, plotWidth - w);
        }
      }
      return { x: placedX, y: spec.y - h / 2 };
    }
    case "top-of-x": {
      // Centered horizontally on `spec.x`, clamped to plot edges.
      let placedX = spec.x - w / 2;
      if (Number.isFinite(plotWidth)) {
        if (placedX < 0) {
          placedX = 0;
        } else if (placedX + w > plotWidth) {
          placedX = Math.max(0, plotWidth - w);
        }
      }
      return { x: placedX, y: spec.y };
    }
    case "end-of-ray": {
      // Anchor at the visible-segment endpoint, with a small inward offset
      // so the label doesn't sit exactly on the line. Clamp to plot edges.
      let placedX = spec.x + LABEL_X_OFFSET;
      if (Number.isFinite(plotWidth)) {
        if (placedX + w > plotWidth) {
          placedX = Math.max(0, spec.x - LABEL_X_OFFSET - w);
        }
        if (placedX < 0) {
          placedX = 0;
        }
      }
      return { x: placedX, y: spec.y - h / 2 };
    }
    case "right-of-cx": {
      // Default placement: `(cx + r + 4, cy)` (label centered on the +x ring
      // intersection). On overflow, flip to the left of the diameter
      // intersection at `(cx - r - 4 - w, cy)`, then last-resort clamp.
      const rightX = spec.cx + spec.r + LABEL_X_OFFSET;
      let placedX = rightX;
      if (Number.isFinite(plotWidth) && rightX + w > plotWidth) {
        const leftX = spec.cx - spec.r - LABEL_X_OFFSET - w;
        if (leftX >= 0) {
          placedX = leftX;
        } else {
          placedX = Math.max(0, plotWidth - w);
        }
      }
      return { x: placedX, y: spec.cy - h / 2 };
    }
  }
}
