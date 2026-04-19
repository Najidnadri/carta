import { Container, Graphics, Text } from "pixi.js";
import type { LinearScale } from "../scales/LinearScale.js";
import { DEFAULT_THEME } from "../types.js";

export interface PriceAxisOptions {
  width: number;
  tickCount: number;
  textColor: number;
  gridColor: number;
}

const DEFAULT_OPTIONS: PriceAxisOptions = {
  width: 60,
  tickCount: 6,
  textColor: DEFAULT_THEME.text,
  gridColor: DEFAULT_THEME.grid,
};

export class PriceAxis {
  readonly container = new Container();
  private grid = new Graphics();
  private labels = new Container();
  private options: PriceAxisOptions;

  constructor(options: Partial<PriceAxisOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.container.addChild(this.grid, this.labels);
  }

  render(scale: LinearScale, chartWidth: number, chartHeight: number): void {
    this.grid.clear();
    this.labels.removeChildren();

    const ticks = this.generateTicks(scale.domain.min, scale.domain.max, this.options.tickCount);
    for (const value of ticks) {
      const y = scale.toPixel(value);
      this.grid.moveTo(0, y).lineTo(chartWidth, y).stroke({ width: 1, color: this.options.gridColor, alpha: 0.4 });

      const label = new Text({
        text: this.formatPrice(value),
        style: { fill: this.options.textColor, fontSize: 11, fontFamily: "monospace" },
      });
      label.x = chartWidth + 4;
      label.y = y - label.height / 2;
      this.labels.addChild(label);
    }

    void chartHeight;
  }

  private generateTicks(min: number, max: number, count: number): number[] {
    const step = (max - min) / (count - 1);
    const ticks: number[] = [];
    for (let i = 0; i < count; i++) {
      ticks.push(min + step * i);
    }
    return ticks;
  }

  private formatPrice(value: number): string {
    return value.toFixed(2);
  }
}
