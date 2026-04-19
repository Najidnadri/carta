import { Container, Graphics, Text } from "pixi.js";
import type { TimeScale } from "../scales/TimeScale.js";
import { DEFAULT_THEME } from "../types.js";

export interface TimeAxisOptions {
  height: number;
  tickCount: number;
  textColor: number;
  gridColor: number;
}

const DEFAULT_OPTIONS: TimeAxisOptions = {
  height: 24,
  tickCount: 6,
  textColor: DEFAULT_THEME.text,
  gridColor: DEFAULT_THEME.grid,
};

export class TimeAxis {
  readonly container = new Container();
  private grid = new Graphics();
  private labels = new Container();
  private options: TimeAxisOptions;

  constructor(options: Partial<TimeAxisOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.container.addChild(this.grid, this.labels);
  }

  render(scale: TimeScale, chartWidth: number, chartHeight: number): void {
    this.grid.clear();
    this.labels.removeChildren();

    const ticks = this.generateTicks(scale.domain.min, scale.domain.max, this.options.tickCount);
    for (const time of ticks) {
      const x = scale.toPixel(time);
      this.grid.moveTo(x, 0).lineTo(x, chartHeight).stroke({ width: 1, color: this.options.gridColor, alpha: 0.4 });

      const label = new Text({
        text: this.formatTime(time),
        style: { fill: this.options.textColor, fontSize: 11, fontFamily: "monospace" },
      });
      label.x = x - label.width / 2;
      label.y = chartHeight + 4;
      this.labels.addChild(label);
    }

    void chartWidth;
  }

  private generateTicks(min: number, max: number, count: number): number[] {
    const step = (max - min) / (count - 1);
    const ticks: number[] = [];
    for (let i = 0; i < count; i++) {
      ticks.push(min + step * i);
    }
    return ticks;
  }

  private formatTime(ms: number): string {
    const d = new Date(ms);
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  }
}
