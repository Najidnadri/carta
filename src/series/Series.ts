import { Container } from "pixi.js";
import type { LinearScale } from "../scales/LinearScale.js";
import type { TimeScale } from "../scales/TimeScale.js";

export interface SeriesContext {
  xScale: TimeScale;
  yScale: LinearScale;
  width: number;
  height: number;
}

export abstract class Series {
  readonly container = new Container();

  abstract render(ctx: SeriesContext): void;

  abstract priceRange(): { min: number; max: number } | null;

  abstract timeRange(): { min: number; max: number } | null;

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
