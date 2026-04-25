/**
 * Shared types for Carta. Exported via `src/index.ts`.
 * Branded units (Time, Interval, Pixel, Price) enforce unit-safety at public
 * API boundaries without runtime cost.
 */

// ─── Branded units ─────────────────────────────────────────────────────────
export type Time = number & { readonly __brand: "Time" };
export type Interval = number & { readonly __brand: "Interval" };
export type Pixel = number & { readonly __brand: "Pixel" };
export type Price = number & { readonly __brand: "Price" };

export const asTime = (n: number): Time => n as Time;
export const asInterval = (n: number): Interval => n as Interval;
export const asPixel = (n: number): Pixel => n as Pixel;
export const asPrice = (n: number): Price => n as Price;

// ─── Record types ──────────────────────────────────────────────────────────
export interface OhlcRecord {
  readonly time: Time;
  readonly open: Price;
  readonly high: Price;
  readonly low: Price;
  readonly close: Price;
  readonly volume?: number;
}

export interface PointRecord {
  readonly time: Time;
  readonly value: Price;
  readonly color?: number;
}

export interface MarkerRecord {
  readonly time: Time;
  readonly position: "above" | "below" | "inBar";
  readonly shape: "circle" | "square" | "arrowUp" | "arrowDown";
  readonly color?: number;
  readonly text?: string;
}

export type DataRecord = OhlcRecord | PointRecord | MarkerRecord;

// ─── Channels ──────────────────────────────────────────────────────────────
export type ChannelKind = "ohlc" | "point" | "marker";

export interface Channel {
  readonly id: string;
  readonly kind: ChannelKind;
}

// ─── Data store options ────────────────────────────────────────────────────
export interface DataCaps {
  readonly ohlc?: number;
  readonly point?: number;
  readonly marker?: number;
}

export interface DataOptions {
  readonly caps?: DataCaps;
  readonly requestThresholdBars?: number;
}

export interface ClearCacheOptions {
  readonly channelId?: string;
  readonly intervalDuration?: number;
}

export interface Range {
  readonly start: number;
  readonly end: number;
}

export interface CacheStats {
  readonly channelId: string;
  readonly kind: ChannelKind;
  readonly intervalsLoaded: readonly number[];
  readonly totalRecords: number;
}

export interface MissingRangesQuery {
  readonly startTime?: Time | number;
  readonly endTime?: Time | number;
  readonly intervalDuration?: Interval | number;
}

// ─── Window & event payloads ───────────────────────────────────────────────
/**
 * Read shape — payload of `window:change`, return of `getWindow()`.
 * `intervalDuration` is denormalized so hosts have the full triple in one place.
 */
export interface ChartWindow {
  readonly startTime: Time;
  readonly endTime: Time;
  readonly intervalDuration: Interval;
}

/** Write shape — input to `setWindow()` / `viewport.applyWindow`. */
export interface WindowInput {
  readonly startTime: Time;
  readonly endTime: Time;
}

export interface DataRequest {
  readonly channelId: string;
  readonly kind: ChannelKind;
  readonly intervalDuration: Interval;
  readonly startTime: Time;
  readonly endTime: Time;
}

export interface IntervalChange {
  readonly previous: Interval | null;
  readonly current: Interval;
}

/**
 * Payload of `crosshair:move`. Shape is stable — fires on both move *and*
 * leave. On leave, `time` / `price` are `null` and `seriesData` is empty;
 * `point` still reflects the last known pixel coordinate so hosts can
 * position UI elements during the transition.
 *
 * `seriesData` is keyed by the host's own `Series` reference (the same
 * instance passed to `chart.addSeries`). Lookup is O(1); iterate for
 * rendering per-series legends.
 */
export interface CrosshairInfo {
  readonly time: Time | null;
  readonly price: Price | null;
  readonly point: {
    readonly x: Pixel;
    readonly y: Pixel;
  };
  readonly seriesData: ReadonlyMap<CrosshairSeriesKey, DataRecord | null>;
}

/**
 * Opaque key type for the `CrosshairInfo.seriesData` map. The concrete
 * runtime value is the `Series` instance the host passed to `addSeries`,
 * but the library doesn't export the `Series` class on the type surface
 * — so this brand keeps the map well-typed without leaking internals.
 */
export type CrosshairSeriesKey = object & { readonly __brand: "Series" };

export interface SizeInfo {
  readonly width: number;
  readonly height: number;
}

/**
 * Payload of `tracking:change`. Fires only on actual transitions:
 * `false → true` when tracking mode is entered (long-press OR
 * `enterTrackingMode()`), and `true → false` when exited (tap-outside,
 * `exitTrackingMode()`). Idempotent calls do NOT emit. `destroy()` does NOT
 * emit a final `false`.
 *
 * Ordering relative to `crosshair:move`: `tracking:change` is emitted
 * synchronously *before* the crosshair invalidation, so the next
 * `crosshair:move` payload reflects the new state.
 */
export interface TrackingChange {
  readonly active: boolean;
}

/**
 * Argument to `chart.enterTrackingMode(opts?)`. All fields optional —
 * omitted coordinates default to the plot rectangle's centroid (computed
 * from the current `TimeScale` / `PriceScale`). Non-finite values are
 * warned and replaced with the centroid default.
 */
export interface TrackingModeOptions {
  readonly time?: Time;
  readonly price?: Price;
}

/**
 * Event map for `chart.on` / `off` / `once`. Keys are stable string literals,
 * payload types propagate so handlers get full TS inference.
 */
export interface CartaEventMap extends Record<string, unknown> {
  readonly "window:change": ChartWindow;
  readonly "interval:change": IntervalChange;
  readonly "data:request": DataRequest;
  readonly "crosshair:move": CrosshairInfo;
  readonly "tracking:change": TrackingChange;
  readonly resize: SizeInfo;
}

export type EventKey = keyof CartaEventMap;
export type EventPayload<K extends EventKey> = CartaEventMap[K];
export type CartaEventHandler<K extends EventKey> = (payload: EventPayload<K>) => void;

// ─── Theme ─────────────────────────────────────────────────────────────────
/**
 * Visual constants consumed by every renderer + series. Hosts override at
 * construction (`TimeSeriesChartOptions.theme`) or at runtime via
 * `chart.applyOptions({ theme })` — both shallow-merge against the active
 * theme. Per-series colour options (e.g. `CandlestickSeriesOptions.upColor`)
 * always win over a theme value.
 *
 * Concrete presets ship in `src/core/themes.ts` as `DarkTheme` (the default)
 * and `LightTheme`. The interface stays flat: discoverability via doc-comment
 * grouping below, no nested sections that complicate `Partial<Theme>` merges.
 */
export interface Theme {
  // ─── Surface ─────────────────────────────────────────────────
  readonly background: number;
  readonly grid: number;
  /** Multiplier applied to grid stroke alpha. `1.0` for dark, `0.6` for light. */
  readonly gridAlpha: number;
  readonly frame: number;

  // ─── Text ────────────────────────────────────────────────────
  readonly text: number;
  readonly textMuted: number;

  // ─── Series defaults ─────────────────────────────────────────
  readonly up: number;
  readonly down: number;
  readonly line: number;
  readonly areaTop: number;
  readonly areaBottom: number;
  readonly histogramUp: number;
  readonly histogramDown: number;
  readonly baselinePositiveTop: number;
  readonly baselinePositiveBottom: number;
  readonly baselineNegativeTop: number;
  readonly baselineNegativeBottom: number;

  // ─── Crosshair ───────────────────────────────────────────────
  readonly crosshairLine: number;
  readonly crosshairTagBg: number;
  readonly crosshairTagText: number;

  // ─── Typography ──────────────────────────────────────────────
  /**
   * CSS font-family stack used for axis labels, crosshair tags, and marker
   * labels. A theme swap re-rasterizes every visible label on the next flush.
   */
  readonly fontFamily: string;
  /** Base font size in CSS px, applied uniformly to axes / crosshair / markers. */
  readonly fontSize: number;
}

// ─── Logger ────────────────────────────────────────────────────────────────
export interface Logger {
  debug(msg: string, ...args: readonly unknown[]): void;
  info(msg: string, ...args: readonly unknown[]): void;
  warn(msg: string, ...args: readonly unknown[]): void;
  error(msg: string, ...args: readonly unknown[]): void;
}

// ─── Price axis / scale options ────────────────────────────────────────────
export interface PriceScaleMargins {
  readonly top: number;
  readonly bottom: number;
}

export type PriceScaleMode = "linear";

export interface PriceScaleOptions {
  readonly margins?: PriceScaleMargins;
  readonly mode?: PriceScaleMode;
}

export interface PriceAxisOptions {
  readonly minLabelPx?: number;
  readonly labelPaddingX?: number;
  readonly fontSize?: number;
  readonly fontFamily?: string;
}

export type PriceFormatter = (value: number) => string;

export interface PriceDomain {
  readonly min: Price;
  readonly max: Price;
}

export interface PriceScaleFacade {
  setDomain(min: Price | number, max: Price | number): void;
  getDomain(): PriceDomain;
  isAutoScale(): boolean;
  setAutoScale(on: boolean): void;
}

// ─── Viewport options ──────────────────────────────────────────────────────
export interface KineticOptions {
  readonly decayPerSec?: number;
  readonly minFlingVelocityPxPerMs?: number;
}

export interface ViewportOptions {
  readonly minIntervalDuration?: number;
  readonly maxWindowDuration?: number;
  readonly zoomFactor?: number;
  readonly shiftPanFraction?: number;
  readonly kinetic?: KineticOptions;
}

// ─── Public options ────────────────────────────────────────────────────────
export interface TimeSeriesChartOptions {
  readonly container: HTMLElement;
  readonly startTime: Time | number;
  readonly endTime: Time | number;
  readonly intervalDuration: Interval | number;
  readonly width?: number;
  readonly height?: number;
  readonly autoResize?: boolean;
  readonly devicePixelRatio?: number;
  readonly theme?: Partial<Theme>;
  readonly logger?: Logger;
  readonly viewport?: ViewportOptions;
  readonly priceScale?: PriceScaleOptions;
  readonly priceAxis?: PriceAxisOptions;
  readonly priceFormatter?: PriceFormatter;
  readonly data?: DataOptions;
}

export interface ApplyOptions {
  readonly theme?: Partial<Theme>;
  readonly priceFormatter?: PriceFormatter;
}

// ─── Series options ────────────────────────────────────────────────────────
export interface CandlestickSeriesOptions {
  readonly channel: string;
  readonly upColor?: number;
  readonly downColor?: number;
  readonly wickWidth?: number;
  readonly bodyGapPx?: number;
}

export interface OhlcBarSeriesOptions {
  readonly channel: string;
  /** Colour for bars where `close >= open`. Defaults to `theme.up`. */
  readonly upColor?: number;
  /** Colour for bars where `close < open`. Defaults to `theme.down`. */
  readonly downColor?: number;
  /** Stroke width for the vertical and tick lines in pixels. Defaults to 1. */
  readonly tickWidth?: number;
  /**
   * Collapse every stroke to 1 pixel with `pixelLine: true`. When enabled
   * overrides `tickWidth`. Useful in very dense windows where tick glyphs
   * would otherwise render thicker than the wick. Defaults to `false`.
   */
  readonly thinBars?: boolean;
}

export interface HeikinAshiSeriesOptions {
  readonly channel: string;
  readonly upColor?: number;
  readonly downColor?: number;
  readonly wickWidth?: number;
  readonly bodyGapPx?: number;
}

export type LineStyle = "solid" | "dashed" | "dotted";
export type LineType = "simple" | "stepped";

export interface LineSeriesOptions {
  readonly channel: string;
  readonly color?: number;
  readonly lineWidth?: number;
  /** Defaults to `'solid'`. `'dashed'` renders 6-on / 3-off px, `'dotted'` 1-on / 3-off. */
  readonly lineStyle?: LineStyle;
  /** Defaults to `'simple'`. `'stepped'` holds the previous value until the next point's x, then jumps. */
  readonly lineType?: LineType;
}

export interface AreaSeriesOptions {
  readonly channel: string;
  /** Gradient-top color (near the polyline). Defaults to `theme.areaTop`. */
  readonly topColor?: number;
  /** Gradient-bottom color (at the baseline). Defaults to `theme.areaBottom`. */
  readonly bottomColor?: number;
  /** Gradient-top alpha in [0, 1]. Defaults to 0.45. */
  readonly topAlpha?: number;
  /** Gradient-bottom alpha in [0, 1]. Defaults to 0. */
  readonly bottomAlpha?: number;
  /** Stroke color for the polyline on top of the fill. Defaults to `topColor`. */
  readonly lineColor?: number;
  readonly lineWidth?: number;
  /**
   * Price value that the fill extends to at the bottom. Defaults to the
   * effective price-scale minimum for the visible window (visible bottom).
   */
  readonly baseline?: number;
}

export interface HistogramSeriesOptions {
  readonly channel: string;
  /** Default color for bars without a per-record `color` override. Defaults to `theme.line`. */
  readonly color?: number;
  /** Price value the bars grow from. Defaults to 0. */
  readonly base?: number;
  /**
   * Whether this series' data influences the chart's auto-scale domain via
   * `priceRangeInWindow`. Volume overlays on a shared price scale should set
   * this to `false` so the base + value range doesn't widen the domain.
   * Defaults to `true`.
   */
  readonly participatesInAutoScale?: boolean;
}

export type MarkerShape = MarkerRecord["shape"];
export type MarkerPosition = MarkerRecord["position"];
export type MarkerPriceField = "high" | "low" | "close" | "value";

export interface MarkerPriceReference {
  /** Channel id providing the Y-anchor. Must be an `ohlc` or `point` channel. */
  readonly channel: string;
  /** Field to read on the referenced record. Only applies to `above`/`below` positions. */
  readonly field?: MarkerPriceField;
}

export interface MarkerOverlayOptions {
  readonly channel: string;
  /** Channel-and-field that provides the Y anchor for each marker. */
  readonly priceReference: MarkerPriceReference;
  /** Default tint when a record has no `color`. Defaults to `theme.line`. */
  readonly defaultColor?: number;
  /** Glyph size in CSS px (radius / half-side / half-height). Defaults to 12. */
  readonly defaultSize?: number;
  /** Font family for `BitmapText` labels. Defaults to `'Arial'`. */
  readonly textFontFamily?: string;
  /** Font size in CSS px for `BitmapText` labels. Defaults to 11. */
  readonly textFontSize?: number;
}

export type BaselineMode = number | "first" | "average";

export interface BaselineSeriesOptions {
  readonly channel: string;
  /** Baseline price. Numeric, or `'first'` / `'average'` of visible finite values. Defaults to 0. */
  readonly baseline?: BaselineMode;
  readonly positiveTopColor?: number;
  readonly positiveBottomColor?: number;
  readonly negativeTopColor?: number;
  readonly negativeBottomColor?: number;
  /** Alpha for the top color stop in each fill. Defaults to 0.45. */
  readonly fillTopAlpha?: number;
  /** Alpha for the bottom color stop in each fill. Defaults to 0.05. */
  readonly fillBottomAlpha?: number;
  readonly lineColor?: number;
  readonly lineWidth?: number;
}
