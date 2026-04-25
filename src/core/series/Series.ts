import { Container } from "pixi.js";
import type { DataStore } from "../data/DataStore.js";
import type { PriceRange, PriceRangeProvider } from "../price/PriceRangeProvider.js";
import type { PriceScale } from "../price/PriceScale.js";
import type { TimeScale } from "../time/TimeScale.js";
import type {
  ChannelKind,
  Interval,
  Theme,
  Time,
} from "../../types.js";

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
  /**
   * Trigger a re-render after a state change that originates from inside the
   * series (e.g. `applyOptions`). Optional in test setups where the series
   * is exercised without a chart; `TimeSeriesChart.addSeries` always wires it.
   */
  readonly invalidate?: () => void;
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
   * Apply a partial patch over the series' constructor options without
   * re-creating the series. Implementations shallow-merge the patch using
   * `mergeOptions` (which pins immutable identifiers like `channel`) and
   * call `requestInvalidate()` so the next flush picks up the new style.
   *
   * The patch type is the series' own options interface. Hosts get
   * autocomplete on every option except the channel (a channel change is
   * silently dropped — see `mergeOptions` rationale).
   */
  abstract applyOptions(patch: object): void;

  /**
   * Shallow-merge `patch` into `current` while pinning fields that must not
   * change after construction (`channel`, and `priceReference.channel` for
   * marker overlays). Returns a new options object — the caller assigns it
   * back to its own `opts` field.
   */
  protected mergeOptions<O extends { readonly channel: string }>(
    current: O,
    patch: Partial<O>,
  ): O {
    const next: O = { ...current, ...patch };
    // Pin the channel — changing it post-construction would silently break
    // the data-store binding registered by `chart.addSeries`.
    (next as { channel: string }).channel = current.channel;
    return next;
  }

  /** Fire the chart's invalidator if a query context with one is bound. */
  protected requestInvalidate(): void {
    this.query?.invalidate?.();
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
