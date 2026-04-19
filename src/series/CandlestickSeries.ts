import { Graphics } from "pixi.js";
import { Series, type SeriesContext } from "./Series.js";
import type { Candle } from "../types.js";
import { DEFAULT_THEME } from "../types.js";

export interface CandlestickStyle {
  upColor: number;
  downColor: number;
  wickWidth: number;
  bodyGap: number;
}

const DEFAULT_STYLE: CandlestickStyle = {
  upColor: DEFAULT_THEME.up,
  downColor: DEFAULT_THEME.down,
  wickWidth: 1,
  bodyGap: 1,
};

export class CandlestickSeries extends Series {
  private data: Candle[] = [];
  private graphics = new Graphics();
  private style: CandlestickStyle;

  constructor(style: Partial<CandlestickStyle> = {}) {
    super();
    this.style = { ...DEFAULT_STYLE, ...style };
    this.container.addChild(this.graphics);
  }

  setData(data: Candle[]): void {
    this.data = [...data].sort((a, b) => a.time - b.time);
  }

  render(ctx: SeriesContext): void {
    const g = this.graphics;
    g.clear();
    if (this.data.length === 0) {
      return;
    }

    const candleWidth = this.computeCandleWidth(ctx);
    const half = Math.max(1, candleWidth / 2 - this.style.bodyGap);

    for (const c of this.data) {
      const x = ctx.xScale.toPixel(c.time);
      const yOpen = ctx.yScale.toPixel(c.open);
      const yClose = ctx.yScale.toPixel(c.close);
      const yHigh = ctx.yScale.toPixel(c.high);
      const yLow = ctx.yScale.toPixel(c.low);
      const isUp = c.close >= c.open;
      const color = isUp ? this.style.upColor : this.style.downColor;

      g.moveTo(x, yHigh).lineTo(x, yLow).stroke({ width: this.style.wickWidth, color });

      const top = Math.min(yOpen, yClose);
      const bottom = Math.max(yOpen, yClose);
      const bodyHeight = Math.max(1, bottom - top);
      g.rect(x - half, top, half * 2, bodyHeight).fill(color);
    }
  }

  priceRange(): { min: number; max: number } | null {
    if (this.data.length === 0) {
      return null;
    }
    let min = Infinity;
    let max = -Infinity;
    for (const c of this.data) {
      if (c.low < min) {
        min = c.low;
      }
      if (c.high > max) {
        max = c.high;
      }
    }
    return { min, max };
  }

  timeRange(): { min: number; max: number } | null {
    if (this.data.length === 0) {
      return null;
    }
    const first = this.data[0];
    const last = this.data[this.data.length - 1];
    if (first === undefined || last === undefined) {
      return null;
    }
    return { min: first.time, max: last.time };
  }

  private computeCandleWidth(ctx: SeriesContext): number {
    if (this.data.length < 2) {
      return 8;
    }
    const first = this.data[0];
    const second = this.data[1];
    if (first === undefined || second === undefined) {
      return 8;
    }
    const pxPerCandle = Math.abs(ctx.xScale.toPixel(second.time) - ctx.xScale.toPixel(first.time));
    return Math.max(2, pxPerCandle * 0.7);
  }
}
