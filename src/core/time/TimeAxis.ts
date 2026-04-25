import { Graphics, Text } from "pixi.js";
import type { Container, TextStyleOptions } from "pixi.js";
import type { PlotRect } from "../render/Renderer.js";
import type { TimeScale } from "./TimeScale.js";
import { generateTickCandidates, pickNaturalStep } from "./naturalStep.js";
import { dayKeyOf, formatAxisLabel } from "./timeFormat.js";
import type { FormatContext } from "./timeFormat.js";
import type { Interval, Theme, Time } from "../../types.js";

export interface TimeAxisOptions {
  readonly minLabelPx?: number;
  readonly labelPaddingY?: number;
  readonly fontSize?: number;
  readonly fontFamily?: string;
  readonly formatContext?: FormatContext;
}

export interface TickInfo {
  readonly time: Time;
  readonly x: number;
  readonly label: string;
  readonly isDayBoundary: boolean;
}

const DEFAULT_MIN_LABEL_PX = 80;
const DEFAULT_LABEL_PADDING_Y = 6;
const POOL_FLOOR = 64;

interface LabelSlot {
  readonly text: Text;
  lastValue: string;
}

/**
 * Owns vertical grid Graphics on `gridLayer` and a pool of `Text` labels on
 * `axesLayer`. Redraws on `layout | viewport | size | theme` dirty. Pool is
 * allocated once and never shrinks; extras are hidden via `visible = false`.
 *
 * Phase 10: `fontFamily` / `fontSize` come from the theme at render time when
 * the constructor didn't supply explicit overrides. A change to either across
 * a render call updates every pooled label's style in place.
 */
export class TimeAxis {
  private readonly gridLayer: Container;
  private readonly axesLayer: Container;
  /** Constructor-supplied overrides — when set, beat `theme.fontFamily`/`fontSize`. */
  private readonly fontFamilyOverride: string | undefined;
  private readonly fontSizeOverride: number | undefined;
  private readonly minLabelPx: number;
  private readonly labelPaddingY: number;
  private readonly formatContext: FormatContext | undefined;

  private readonly grid = new Graphics();
  private readonly labelPool: LabelSlot[] = [];
  private poolAllocated = false;
  private destroyed = false;
  private lastFontFamily = "";
  private lastFontSize = 0;

  private lastTicks: readonly TickInfo[] = [];

  constructor(gridLayer: Container, axesLayer: Container, options: TimeAxisOptions = {}) {
    this.gridLayer = gridLayer;
    this.axesLayer = axesLayer;
    this.minLabelPx = options.minLabelPx ?? DEFAULT_MIN_LABEL_PX;
    this.labelPaddingY = options.labelPaddingY ?? DEFAULT_LABEL_PADDING_Y;
    this.fontFamilyOverride = options.fontFamily;
    this.fontSizeOverride = options.fontSize;
    this.formatContext = options.formatContext;
    this.gridLayer.addChild(this.grid);
  }

  /**
   * Renders the grid and labels for the current `(scale, plotRect, theme)`.
   * Safe to call on every flush; internally hides labels + clears grid when
   * the scale is invalid or the plot rect collapses.
   */
  render(scale: TimeScale, plotRect: PlotRect, theme: Theme): void {
    if (this.destroyed) {
      return;
    }
    const effectiveFontFamily = this.fontFamilyOverride ?? theme.fontFamily;
    const effectiveFontSize = this.fontSizeOverride ?? theme.fontSize;
    this.ensurePool(plotRect.w, effectiveFontFamily, effectiveFontSize);
    this.applyFontIfChanged(effectiveFontFamily, effectiveFontSize);
    this.grid.clear();

    if (!scale.valid || plotRect.w <= 0 || plotRect.h <= 0 || scale.barSpacingPx <= 0) {
      this.hideAllLabels();
      this.lastTicks = [];
      return;
    }

    const ticks = this.computeTicks(scale);
    this.lastTicks = ticks;

    this.drawGrid(ticks, plotRect, theme);
    this.drawLabels(ticks, plotRect, theme);
  }

  /** Exposes the most-recent tick list (after `render`). Useful for tests. */
  ticks(): readonly TickInfo[] {
    return this.lastTicks;
  }

  /** Current label pool capacity. Constant after first `render`. */
  poolSize(): number {
    return this.labelPool.length;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.grid.destroy();
    for (const slot of this.labelPool) {
      slot.text.destroy();
    }
    this.labelPool.length = 0;
    this.lastTicks = [];
  }

  // ─── Private ──────────────────────────────────────────────────────────────
  private ensurePool(currentWidth: number, fontFamily: string, fontSize: number): void {
    if (this.poolAllocated) {
      return;
    }
    this.poolAllocated = true;
    const desired = Math.max(
      POOL_FLOOR,
      Math.ceil(Math.max(0, currentWidth) / this.minLabelPx) + 4,
    );
    const style: TextStyleOptions = {
      fontFamily,
      fontSize,
      fill: 0xffffff,
    };
    for (let i = 0; i < desired; i++) {
      const text = new Text({ text: "", style });
      text.anchor.set(0.5, 0);
      text.visible = false;
      this.axesLayer.addChild(text);
      this.labelPool.push({ text, lastValue: "" });
    }
    this.lastFontFamily = fontFamily;
    this.lastFontSize = fontSize;
  }

  /**
   * Phase 10 — when the theme's fontFamily / fontSize change, mutate every
   * pooled label's style in place. Pixi v8 re-rasterizes on the next render.
   */
  private applyFontIfChanged(fontFamily: string, fontSize: number): void {
    if (fontFamily === this.lastFontFamily && fontSize === this.lastFontSize) {
      return;
    }
    for (const slot of this.labelPool) {
      slot.text.style.fontFamily = fontFamily;
      slot.text.style.fontSize = fontSize;
    }
    this.lastFontFamily = fontFamily;
    this.lastFontSize = fontSize;
  }

  private hideAllLabels(): void {
    for (const slot of this.labelPool) {
      if (slot.text.visible) {
        slot.text.visible = false;
      }
    }
  }

  private computeTicks(scale: TimeScale): readonly TickInfo[] {
    if (scale.slotCount === 0) {
      return [];
    }
    const intervalMs = Number(scale.intervalDuration);
    const step = pickNaturalStep(
      scale.barSpacingPx,
      intervalMs,
      this.minLabelPx,
    );

    const firstSlot = scale.firstSlotMs;
    const startMs = Number(scale.startTime);
    const endMs = Number(scale.endTime);
    const candidates = generateTickCandidates(startMs, endMs, intervalMs, step, firstSlot);

    const ctx = this.formatContext;
    const ticks: TickInfo[] = [];
    let prevDayKey: string | null = null;

    for (const candidate of candidates) {
      const currentDayKey = dayKeyOf(candidate.time, ctx);
      const isDayBoundary = prevDayKey !== null && currentDayKey !== prevDayKey;
      prevDayKey = currentDayKey;
      const label = formatAxisLabel(candidate.time, step, isDayBoundary, ctx);
      const x = Number(scale.timeToPixel(candidate.time));
      ticks.push({ time: candidate.time, x, label, isDayBoundary });
    }
    return ticks;
  }

  private drawGrid(
    ticks: readonly TickInfo[],
    plotRect: PlotRect,
    theme: Theme,
  ): void {
    if (ticks.length === 0) {
      return;
    }
    for (const tick of ticks) {
      const x = plotRect.x + tick.x;
      if (x < plotRect.x - 0.5 || x > plotRect.x + plotRect.w + 0.5) {
        continue;
      }
      this.grid.moveTo(x, plotRect.y).lineTo(x, plotRect.y + plotRect.h);
    }
    this.grid.stroke({
      width: 1,
      color: theme.grid,
      alpha: theme.gridAlpha,
      pixelLine: true,
    });
  }

  private drawLabels(
    ticks: readonly TickInfo[],
    plotRect: PlotRect,
    theme: Theme,
  ): void {
    const labelY = plotRect.y + plotRect.h + this.labelPaddingY;
    const pool = this.labelPool;
    const count = Math.min(ticks.length, pool.length);
    const plotRight = plotRect.x + plotRect.w;

    for (let i = 0; i < count; i++) {
      const tick = ticks[i];
      const slot = pool[i];
      if (tick === undefined || slot === undefined) {
        continue;
      }
      const text = slot.text;

      if (slot.lastValue !== tick.label) {
        text.text = tick.label;
        slot.lastValue = tick.label;
      }
      text.style.fill = tick.isDayBoundary ? theme.text : theme.textMuted;
      const x = plotRect.x + tick.x;
      text.position.set(x, labelY);
      // Anchor is (0.5, 0) — hide labels whose centered bounding box would
      // spill into the right-hand price-axis strip (the corner square).
      const halfWidth = text.width / 2;
      const overflowsRight = x + halfWidth > plotRight;
      const overflowsLeft = x - halfWidth < plotRect.x;
      const shouldShow = !overflowsRight && !overflowsLeft;
      if (text.visible !== shouldShow) {
        text.visible = shouldShow;
      }
    }

    for (let i = count; i < pool.length; i++) {
      const slot = pool[i];
      if (slot === undefined) {
        continue;
      }
      if (slot.text.visible) {
        slot.text.visible = false;
      }
    }
  }
}

export type { Interval };
