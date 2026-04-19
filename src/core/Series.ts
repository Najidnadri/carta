import { Container } from "pixi.js";
import type { DataStore } from "./DataStore.js";
import type { PriceRange, PriceRangeProvider } from "./PriceRangeProvider.js";
import type { PriceScale } from "./PriceScale.js";
import type { TimeScale } from "./TimeScale.js";
import type {
  ChannelKind,
  Interval,
  Theme,
  Time,
} from "../types.js";

export interface SeriesRenderContext {
  readonly startTime: Time;
  readonly endTime: Time;
  readonly intervalDuration: Interval;
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly timeScale: TimeScale;
  readonly priceScale: PriceScale;
  readonly dataStore: DataStore;
  readonly theme: Theme;
}

export interface SeriesQueryContext {
  readonly dataStore: DataStore;
  readonly getInterval: () => number;
}

/**
 * Abstract base for every chart series. Series are channel-bound and
 * store-backed — they never hold their own data arrays. Two invocation
 * points:
 *
 * - `priceRangeInWindow(start, end)` is called during
 *   `TimeSeriesChart.flush()` before scales finalise. Reads from the
 *   injected `SeriesQueryContext`; returns `null` when no data is in the
 *   window so auto-scale retains the prior domain.
 * - `render(ctx)` paints into the series' own `container` using the fully
 *   resolved `TimeScale` / `PriceScale` in `ctx`.
 *
 * Series implements `PriceRangeProvider` so `chart.addSeries(s)` registers
 * it as a provider directly — no separate provider list.
 */
export abstract class Series implements PriceRangeProvider {
  readonly container: Container;
  readonly channel: string;
  readonly kind: ChannelKind;
  protected query: SeriesQueryContext | null = null;

  protected constructor(channel: string, kind: ChannelKind, label: string) {
    this.channel = channel;
    this.kind = kind;
    this.container = new Container({ label });
  }

  /** Called by `TimeSeriesChart.addSeries`; binds the store + interval getter. */
  setQueryContext(query: SeriesQueryContext): void {
    this.query = query;
  }

  abstract priceRangeInWindow(startTime: Time, endTime: Time): PriceRange | null;
  abstract render(ctx: SeriesRenderContext): void;

  /** Attach the series' container under the stage's `seriesLayer`. */
  attach(parent: Container): void {
    if (this.container.parent !== parent) {
      parent.addChild(this.container);
    }
  }

  /**
   * Detach from the scene graph and release GPU resources. Subclasses
   * override to destroy their pools, then `super.destroy()` at the end.
   */
  destroy(): void {
    this.container.parent?.removeChild(this.container);
    this.container.destroy({ children: true });
    this.query = null;
  }
}
