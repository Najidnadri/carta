import { Graphics } from "pixi.js";
import { Series, type SeriesContext } from "./Series.js";
import type { LinePoint } from "../types.js";
import { DEFAULT_THEME } from "../types.js";

export interface LineStyle {
  color: number;
  width: number;
}

const DEFAULT_STYLE: LineStyle = {
  color: DEFAULT_THEME.line,
  width: 1.5,
};

export class LineSeries extends Series {
  private data: LinePoint[] = [];
  private graphics = new Graphics();
  private style: LineStyle;

  constructor(style: Partial<LineStyle> = {}) {
    super();
    this.style = { ...DEFAULT_STYLE, ...style };
    this.container.addChild(this.graphics);
  }

  setData(data: LinePoint[]): void {
    this.data = [...data].sort((a, b) => a.time - b.time);
  }

  render(ctx: SeriesContext): void {
    const g = this.graphics;
    g.clear();
    if (this.data.length < 2) {
      return;
    }

    const first = this.data[0];
    if (first === undefined) {
      return;
    }
    g.moveTo(ctx.xScale.toPixel(first.time), ctx.yScale.toPixel(first.value));
    for (let i = 1; i < this.data.length; i++) {
      const p = this.data[i];
      if (p === undefined) {
        continue;
      }
      g.lineTo(ctx.xScale.toPixel(p.time), ctx.yScale.toPixel(p.value));
    }
    g.stroke({ width: this.style.width, color: this.style.color });
  }

  priceRange(): { min: number; max: number } | null {
    if (this.data.length === 0) {
      return null;
    }
    let min = Infinity;
    let max = -Infinity;
    for (const p of this.data) {
      if (p.value < min) {
        min = p.value;
      }
      if (p.value > max) {
        max = p.value;
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
}
