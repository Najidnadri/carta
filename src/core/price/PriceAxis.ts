import { Graphics, Text } from "pixi.js";
import type { Container, TextStyleOptions } from "pixi.js";
import type { PlotRect } from "../render/Renderer.js";
import type { PriceScale } from "./PriceScale.js";
import { generatePriceTicks, targetTickCountForHeight } from "./priceNaturalStep.js";
import type { Logger, Theme } from "../../types.js";

export interface PriceAxisOptions {
  readonly minLabelPx?: number;
  readonly labelPaddingX?: number;
  readonly fontSize?: number;
  readonly fontFamily?: string;
}

/** CSS-pixel width of the right-hand price-axis strip, used by the chart's
 *  plot-rect math and by `PriceAxisController`'s hit-area. */
export const PRICE_AXIS_STRIP_WIDTH = 64;

export type PriceFormatter = (value: number) => string;

export interface PriceTickInfo {
  readonly value: number;
  readonly y: number;
  readonly label: string;
}

/**
 * Phase 14 Cycle B fix-up F-1 — anchors tick generation to a bounded
 * envelope so the axis labels include the boundaries (e.g. `0` and `100`
 * for RSI) regardless of where the natural-step algorithm would otherwise
 * place ticks. `min` and `max` are the bounded mode's bounds; the tick
 * generator runs against this range and the boundaries are pinned post-hoc
 * if the natural step skipped them.
 */
export interface TickEnvelope {
  readonly min: number;
  readonly max: number;
}

const DEFAULT_MIN_LABEL_PX = 80;
const DEFAULT_LABEL_PADDING_X = 6;
const POOL_FLOOR = 32;

export const defaultPriceFormatter: PriceFormatter = (v) => v.toFixed(2);

interface LabelSlot {
  readonly text: Text;
  lastValue: string;
}

/**
 * Owns horizontal grid Graphics on `gridLayer` and a pool of `Text` labels
 * on `axesLayer` on the right side of the plot. Mirrors the pattern of
 * `TimeAxis`: allocated once, never shrinks; extras hidden via
 * `visible = false`. Clears grid and hides labels when the scale is invalid
 * or the plot rect collapses.
 *
 * Phase 10: `fontFamily` / `fontSize` come from the theme at render time when
 * the constructor didn't supply explicit overrides; theme changes update every
 * pooled label's style in place on the next render.
 */
export class PriceAxis {
  private readonly gridLayer: Container;
  private readonly axesLayer: Container;
  private readonly minLabelPx: number;
  private readonly labelPaddingX: number;
  private readonly fontFamilyOverride: string | undefined;
  private readonly fontSizeOverride: number | undefined;

  private readonly grid = new Graphics();
  private readonly labelPool: LabelSlot[] = [];
  private poolAllocated = false;
  private destroyed = false;
  private lastFontFamily = "";
  private lastFontSize = 0;

  private lastTicks: readonly PriceTickInfo[] = [];

  constructor(gridLayer: Container, axesLayer: Container, options: PriceAxisOptions = {}) {
    this.gridLayer = gridLayer;
    this.axesLayer = axesLayer;
    this.minLabelPx = options.minLabelPx ?? DEFAULT_MIN_LABEL_PX;
    this.labelPaddingX = options.labelPaddingX ?? DEFAULT_LABEL_PADDING_X;
    this.fontFamilyOverride = options.fontFamily;
    this.fontSizeOverride = options.fontSize;
    this.gridLayer.addChild(this.grid);
  }

  /**
   * Renders grid + labels for the given scale/plotRect/theme/formatter. Safe
   * on every flush. Catches formatter throws once per render and falls back
   * to the default formatter for the remainder of the frame.
   *
   * Phase 14 Cycle B fix-up F-1 — when `tickEnvelope` is provided (bounded
   * scale modes), tick generation runs against the envelope's `[min, max]`
   * rather than the projection scale's effective domain, AND both boundary
   * values are pinned to the tick list if the natural-step generator
   * skipped them. This guarantees RSI's `0`/`100`, Stochastic's `0`/`100`,
   * Z-score's `±3`, etc. always render as visible axis labels even when
   * the pane height forces the natural step to a value larger than the
   * bounded range.
   */
  render(
    scale: PriceScale,
    plotRect: PlotRect,
    theme: Theme,
    formatter: PriceFormatter = defaultPriceFormatter,
    logger?: Logger,
    tickEnvelope?: TickEnvelope | null,
  ): void {
    if (this.destroyed) {
      return;
    }
    const effectiveFontFamily = this.fontFamilyOverride ?? theme.fontFamily;
    const effectiveFontSize = this.fontSizeOverride ?? theme.fontSize;
    this.ensurePool(plotRect.h, effectiveFontFamily, effectiveFontSize);
    this.applyFontIfChanged(effectiveFontFamily, effectiveFontSize);
    this.grid.clear();

    if (!scale.valid || plotRect.w <= 0 || plotRect.h <= 0 || scale.pixelHeight <= 0) {
      this.hideAllLabels();
      this.lastTicks = [];
      return;
    }

    const ticks = this.computeTicks(scale, plotRect, formatter, logger, tickEnvelope ?? null);
    this.lastTicks = ticks;

    this.drawGrid(ticks, plotRect, theme);
    this.drawLabels(ticks, plotRect, theme);
  }

  /** Most-recent tick list from `render`. Dev/test hook. */
  ticks(): readonly PriceTickInfo[] {
    return this.lastTicks;
  }

  /** Label pool capacity (constant after first render). Dev/test hook. */
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

  private ensurePool(currentHeight: number, fontFamily: string, fontSize: number): void {
    if (this.poolAllocated) {
      return;
    }
    this.poolAllocated = true;
    const desired = Math.max(
      POOL_FLOOR,
      Math.ceil(Math.max(0, currentHeight) / this.minLabelPx) + 4,
    );
    const style: TextStyleOptions = {
      fontFamily,
      fontSize,
      fill: 0xffffff,
    };
    for (let i = 0; i < desired; i++) {
      const text = new Text({ text: "", style });
      text.anchor.set(0, 0.5);
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

  private computeTicks(
    scale: PriceScale,
    plotRect: PlotRect,
    formatter: PriceFormatter,
    logger: Logger | undefined,
    tickEnvelope: TickEnvelope | null,
  ): readonly PriceTickInfo[] {
    const target = targetTickCountForHeight(plotRect.h, this.minLabelPx);
    // Phase 14 Cycle B fix-up F-1 — when bounded, generate ticks against
    // the bounded envelope so the natural-step picks "nice" subdivisions
    // of `[min, max]` (e.g. 0/25/50/75/100 for RSI), not subdivisions of
    // the wider effective domain that could place 0 and 100 outside the
    // chosen step's grid.
    const generatorMin = tickEnvelope !== null ? tickEnvelope.min : scale.effectiveMin;
    const generatorMax = tickEnvelope !== null ? tickEnvelope.max : scale.effectiveMax;
    let values = generatePriceTicks(generatorMin, generatorMax, target);
    if (tickEnvelope !== null) {
      values = pinBoundaryTicks(values, tickEnvelope.min, tickEnvelope.max);
    }

    let activeFormatter = formatter;
    let formatterFailed = false;

    const out: PriceTickInfo[] = [];
    for (const value of values) {
      let label: string;
      try {
        label = activeFormatter(value);
        if (typeof label !== "string") {
          label = defaultPriceFormatter(value);
        }
      } catch (err) {
        if (!formatterFailed) {
          formatterFailed = true;
          logger?.warn(
            "[carta] priceFormatter threw — falling back to default for the rest of this frame",
            err,
          );
          activeFormatter = defaultPriceFormatter;
        }
        label = defaultPriceFormatter(value);
      }
      const y = Number(scale.valueToPixel(value));
      out.push({ value, y, label });
    }
    return out;
  }

  private drawGrid(
    ticks: readonly PriceTickInfo[],
    plotRect: PlotRect,
    theme: Theme,
  ): void {
    if (ticks.length === 0) {
      return;
    }
    const left = plotRect.x;
    const right = plotRect.x + plotRect.w;
    for (const tick of ticks) {
      const y = plotRect.y + tick.y;
      if (y < plotRect.y - 0.5 || y > plotRect.y + plotRect.h + 0.5) {
        continue;
      }
      this.grid.moveTo(left, y).lineTo(right, y);
    }
    this.grid.stroke({
      width: 1,
      color: theme.grid,
      alpha: theme.gridAlpha,
      pixelLine: true,
    });
  }

  private drawLabels(
    ticks: readonly PriceTickInfo[],
    plotRect: PlotRect,
    theme: Theme,
  ): void {
    const labelX = plotRect.x + plotRect.w + this.labelPaddingX;
    const pool = this.labelPool;
    const count = Math.min(ticks.length, pool.length);

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
      text.style.fill = theme.textMuted;
      text.position.set(labelX, plotRect.y + tick.y);
      if (!text.visible) {
        text.visible = true;
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

/**
 * Phase 14 Cycle B fix-up F-1 — given the natural-step generator output and a
 * bounded envelope, return a tick list that includes both `min` and `max`. If
 * the generator already includes them (within float tolerance), the result is
 * unchanged. Otherwise, the boundary values are spliced in at the
 * appropriate position so the final list stays monotonically increasing.
 *
 * Boundary pinning is critical for bounded scales (RSI 0/100, Stochastic
 * 0/100, Z-score ±3 …) because traders read the boundary lines as decision
 * thresholds, not as decoration.
 */
export function pinBoundaryTicks(
  values: readonly number[],
  min: number,
  max: number,
): readonly number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    return values;
  }
  const tol = (max - min) * 1e-9;
  const has = (target: number): boolean =>
    values.some((v) => Math.abs(v - target) <= tol);
  const out: number[] = [...values];
  if (!has(min)) {
    out.push(min);
  }
  if (!has(max)) {
    out.push(max);
  }
  out.sort((a, b) => a - b);
  // Dedupe with float tolerance.
  const unique: number[] = [];
  for (const v of out) {
    const last = unique.length > 0 ? unique[unique.length - 1] : undefined;
    if (last === undefined || Math.abs(v - last) > tol) {
      unique.push(v);
    }
  }
  return unique;
}
