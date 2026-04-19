import { Graphics, Text } from "pixi.js";
import type { Container, TextStyleOptions } from "pixi.js";
import type { PlotRect } from "./Renderer.js";
import type { PriceScale } from "./PriceScale.js";
import { generatePriceTicks, targetTickCountForHeight } from "./priceNaturalStep.js";
import type { Logger, Theme } from "../types.js";

export interface PriceAxisOptions {
  readonly minLabelPx?: number;
  readonly labelPaddingX?: number;
  readonly fontSize?: number;
  readonly fontFamily?: string;
}

export type PriceFormatter = (value: number) => string;

export interface PriceTickInfo {
  readonly value: number;
  readonly y: number;
  readonly label: string;
}

const DEFAULT_MIN_LABEL_PX = 40;
const DEFAULT_LABEL_PADDING_X = 6;
const DEFAULT_FONT_SIZE = 11;
const DEFAULT_FONT_FAMILY = "system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif";
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
 */
export class PriceAxis {
  private readonly gridLayer: Container;
  private readonly axesLayer: Container;
  private readonly options: Required<PriceAxisOptions>;

  private readonly grid = new Graphics();
  private readonly labelPool: LabelSlot[] = [];
  private poolAllocated = false;
  private destroyed = false;

  private lastTicks: readonly PriceTickInfo[] = [];

  constructor(gridLayer: Container, axesLayer: Container, options: PriceAxisOptions = {}) {
    this.gridLayer = gridLayer;
    this.axesLayer = axesLayer;
    this.options = {
      minLabelPx: options.minLabelPx ?? DEFAULT_MIN_LABEL_PX,
      labelPaddingX: options.labelPaddingX ?? DEFAULT_LABEL_PADDING_X,
      fontSize: options.fontSize ?? DEFAULT_FONT_SIZE,
      fontFamily: options.fontFamily ?? DEFAULT_FONT_FAMILY,
    };
    this.gridLayer.addChild(this.grid);
  }

  /**
   * Renders grid + labels for the given scale/plotRect/theme/formatter. Safe
   * on every flush. Catches formatter throws once per render and falls back
   * to the default formatter for the remainder of the frame.
   */
  render(
    scale: PriceScale,
    plotRect: PlotRect,
    theme: Theme,
    formatter: PriceFormatter = defaultPriceFormatter,
    logger?: Logger,
  ): void {
    if (this.destroyed) {
      return;
    }
    this.ensurePool(plotRect.h);
    this.grid.clear();

    if (!scale.valid || plotRect.w <= 0 || plotRect.h <= 0 || scale.pixelHeight <= 0) {
      this.hideAllLabels();
      this.lastTicks = [];
      return;
    }

    const ticks = this.computeTicks(scale, plotRect, formatter, logger);
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

  private ensurePool(currentHeight: number): void {
    if (this.poolAllocated) {
      return;
    }
    this.poolAllocated = true;
    const desired = Math.max(
      POOL_FLOOR,
      Math.ceil(Math.max(0, currentHeight) / this.options.minLabelPx) + 4,
    );
    const style: TextStyleOptions = {
      fontFamily: this.options.fontFamily,
      fontSize: this.options.fontSize,
      fill: 0xffffff,
    };
    for (let i = 0; i < desired; i++) {
      const text = new Text({ text: "", style });
      text.anchor.set(0, 0.5);
      text.visible = false;
      this.axesLayer.addChild(text);
      this.labelPool.push({ text, lastValue: "" });
    }
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
  ): readonly PriceTickInfo[] {
    const target = targetTickCountForHeight(plotRect.h, this.options.minLabelPx);
    const values = generatePriceTicks(scale.effectiveMin, scale.effectiveMax, target);

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
      alpha: 1,
      pixelLine: true,
    });
  }

  private drawLabels(
    ticks: readonly PriceTickInfo[],
    plotRect: PlotRect,
    theme: Theme,
  ): void {
    const labelX = plotRect.x + plotRect.w + this.options.labelPaddingX;
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
