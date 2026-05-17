/**
 * Phase 15 Cycle A — declarative save/load + PNG export public types.
 *
 * `ChartSaveState` captures intent (window, interval, theme overrides,
 * series options + channel bindings, drawings, pane heights). The host
 * is responsible for re-supplying data via the existing `data:request`
 * event after `chart.load(state)`; Carta does not persist cached records.
 */

import type {
  AreaSeriesOptions,
  BaselineSeriesOptions,
  CandlestickSeriesOptions,
  HeikinAshiSeriesOptions,
  HistogramSeriesOptions,
  Interval,
  LineSeriesOptions,
  MarkerOverlayOptions,
  OhlcBarSeriesOptions,
  PriceScaleOptions,
  Theme,
  Time,
} from "../../types.js";
import type {
  DrawingsSnapshot,
  PaneId,
} from "../drawings/types.js";
import type { PaneHeaderOptions } from "../pane/types.js";

/**
 * Current `ChartSaveState.schemaVersion`. Bumped when the on-disk shape
 * changes in a way that requires a migration. Hosts can read this constant
 * to branch on save-format versions; carta-side, the migrator chain in
 * `migrate.ts` knows how to walk older versions up to this one.
 */
export const CARTA_SCHEMA_VERSION = 1 as const;

/**
 * Discriminated union of series save entries. The `kind` field matches the
 * concrete series class; `channel` is the channel binding; `paneId` /
 * `priceScaleId` / `scaleMargins` are the routing fields the chart uses to
 * re-attach the series to the right pane + scale slot on load. `options`
 * carries the rest of the series' constructor options (everything except
 * the routing fields, since those are top-level here for backward
 * compatibility with future migrations that may want to reroute series
 * without touching the options blob).
 */
export type SeriesSaveEntry =
  | { readonly kind: "candle"; readonly channel: string; readonly options: Readonly<CandlestickSeriesOptions> }
  | { readonly kind: "ohlcBar"; readonly channel: string; readonly options: Readonly<OhlcBarSeriesOptions> }
  | { readonly kind: "heikinAshi"; readonly channel: string; readonly options: Readonly<HeikinAshiSeriesOptions> }
  | { readonly kind: "line"; readonly channel: string; readonly options: Readonly<LineSeriesOptions> }
  | { readonly kind: "area"; readonly channel: string; readonly options: Readonly<AreaSeriesOptions> }
  | { readonly kind: "histogram"; readonly channel: string; readonly options: Readonly<HistogramSeriesOptions> }
  | { readonly kind: "baseline"; readonly channel: string; readonly options: Readonly<BaselineSeriesOptions> }
  | { readonly kind: "markerOverlay"; readonly channel: string; readonly options: Readonly<MarkerOverlayOptions> };

export type SeriesKind = SeriesSaveEntry["kind"];

export const SERIES_KINDS: readonly SeriesKind[] = Object.freeze([
  "candle",
  "ohlcBar",
  "heikinAshi",
  "line",
  "area",
  "histogram",
  "baseline",
  "markerOverlay",
]);

/**
 * Per-pane save entry. Captures the pane's id + identity (height,
 * hidden, collapsed, header) plus a per-slot price-scale mode snapshot so
 * RSI / Stochastic / Z-score panes with `bounded` modes restore correctly.
 *
 * `priceFormatter` is intentionally omitted — it's a function, not
 * serializable. Hosts must reapply via `pane.applyOptions({ priceFormatter })`
 * after load.
 */
export interface PaneSaveEntry {
  readonly id: PaneId;
  readonly stretchFactor?: number;
  readonly minHeight?: number;
  readonly heightOverride?: number | null;
  readonly hidden?: boolean;
  readonly collapsed?: boolean;
  readonly header?: PaneHeaderOptions | false;
  readonly priceScales?: {
    readonly right?: PriceScaleOptions;
    readonly left?: PriceScaleOptions;
  };
}

/**
 * Watermark configuration for `chart.exportPNG`. Cycle A landed the text
 * branch; cycle C added the image branch (loaded via PixiJS `Assets.load`).
 *
 * If both `text` and `image` are supplied, the image branch wins —
 * traders who paste a logo URL almost always mean it as the primary mark
 * and text as a fallback.
 */
export interface WatermarkConfig {
  readonly text?: string;
  readonly position?: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
  readonly color?: number;
  readonly opacity?: number;
  readonly fontSize?: number;
  readonly fontFamily?: string;
  /**
   * Cycle C — image watermark. `url` is the only required field; sizing
   * defaults to a fit-inside-25%-of-canvas box, preserving intrinsic
   * aspect ratio.
   */
  readonly image?: {
    readonly url: string;
    readonly scale?: number;
    readonly maxWidth?: number;
    readonly maxHeight?: number;
  };
}

/**
 * Versioned chart save state. Round-trips through `JSON.stringify` /
 * `JSON.parse` with byte-equal output.
 */
export interface ChartSaveState {
  readonly schemaVersion: typeof CARTA_SCHEMA_VERSION;
  readonly savedAt: string; // ISO-8601
  readonly app?: { readonly name: string; readonly version: string };

  readonly window: { readonly startTime: Time; readonly endTime: Time };
  readonly intervalDuration: Interval;
  readonly chartType: SeriesKind;

  readonly theme?: {
    readonly name: "light" | "dark" | "custom";
    readonly overrides?: Partial<Theme>;
  };

  readonly primaryChannelId: string;
  readonly primarySymbol?: string;

  readonly series: readonly SeriesSaveEntry[];
  readonly drawings?: DrawingsSnapshot;
  readonly panes?: readonly PaneSaveEntry[];

  readonly ui?: {
    readonly trackingMode?: boolean;
    readonly watermark?: WatermarkConfig;
  };
}

/**
 * Options accepted by `chart.load(state, opts?)`. `fetchTimeoutMs`
 * defaults to 5_000 — see `state:loaded` / `state:partial-loaded` events.
 * `preserveWindow` skips the window/interval apply step so a host can
 * "load my drawings/series into the current viewport" without snapping.
 */
export interface LoadOptions {
  readonly fetchTimeoutMs?: number;
  readonly preserveWindow?: boolean;
  /** AbortSignal — caller-side cancellation. `chart.destroy()` aborts implicitly. */
  readonly signal?: AbortSignal;
}

/**
 * Options accepted by `chart.exportPNG(opts?)`.
 */
export interface PngExportOptions {
  /** Logical width in CSS px. Defaults to the chart's current width. */
  readonly width?: number;
  /** Logical height in CSS px. Defaults to the chart's current height. */
  readonly height?: number;
  /** Texel multiplier. Defaults to 2 (retina-grade). */
  readonly scale?: number;
  /** MIME type for the resulting Blob. Defaults to `'image/png'`. */
  readonly format?: "image/png" | "image/webp" | "image/jpeg";
  /** Encoder quality for lossy formats (webp/jpeg). Ignored for png. */
  readonly quality?: number;
  /** Watermark overlay. Omit for none. */
  readonly watermark?: WatermarkConfig;
  /**
   * Max time (ms) to defer the export waiting for a gesture to end.
   * Rejects with `EBUSY` after this. Default 2_000.
   */
  readonly deferTimeoutMs?: number;
}

/**
 * Thrown synchronously by `chart.load(state)` when the input doesn't
 * match the schema (validator failure) or carries an unsupported
 * `schemaVersion` (no migration registered).
 */
export class CartaSchemaError extends Error {
  override readonly name = "CartaSchemaError";
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

/**
 * Rejection reason for `chart.exportPNG()`. Surfaces alongside the
 * `'export:failed'` event so hosts can decide whether to retry, surface
 * a banner, etc.
 */
export class ExportError extends Error {
  override readonly name = "ExportError";
  readonly code: "EBUSY" | "CANCELLED" | "GENERIC" | "WATERMARK_FAILED";
  constructor(code: "EBUSY" | "CANCELLED" | "GENERIC" | "WATERMARK_FAILED", message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Rejection reason for an in-flight `chart.load()` or `chart.exportPNG()`
 * when the chart is destroyed mid-operation.
 */
export class OperationCanceledError extends Error {
  override readonly name = "OperationCanceledError";
  constructor(message = "operation canceled") {
    super(message);
  }
}

// ─── Phase 15 Cycle B — CSV export + URL permalink ─────────────────────────

/** Time-format mode for `chart.exportCSV()`. */
export type CsvTimeFormat = "iso" | "epoch-ms";

/**
 * Options accepted by `chart.exportCSV(opts?)`. All fields are optional and
 * have Excel-friendly defaults: comma delimiter, period decimal, CRLF line
 * endings, UTF-8 BOM, ISO time format, precision 2.
 *
 * `channelId` defaults to the chart's primary channel (the first OHLC-kind
 * series or, failing that, the first registered series). `range` defaults to
 * the chart's current visible window. Marker channels throw synchronously
 * with `ExportError('GENERIC', ...)` — CSV is OHLC/point only.
 */
export interface CsvExportOptions {
  readonly channelId?: string;
  readonly range?: { readonly startTime: number; readonly endTime: number };
  readonly timeFormat?: CsvTimeFormat;
  readonly decimal?: "." | ",";
  readonly delimiter?: "," | ";" | "\t";
  readonly precision?: number;
  readonly includeBOM?: boolean;
  readonly lineEnding?: "\r\n" | "\n";
}

/** Tier discriminator for `chart.permalink({tier})`. `'auto'` is the default. */
export type PermalinkTier = "minimal" | "full";

/**
 * Options accepted by `chart.permalink(opts?)`. When `tier` is omitted (or
 * `'auto'`), Carta picks `'minimal'` for "shareable control protocol" states
 * (≤ 1 series, no drawings, no extra panes, theme is a preset, no overrides)
 * and `'full'` otherwise — the trader who hits Share with 30 drawings gets a
 * Tier 2 link instead of silently losing them.
 *
 * `maxEncodedLength` caps the encoded fragment length; encoder throws
 * `PermalinkTooLargeError` past the limit. Default 8192 matches the RFC-7230
 * URL-length guidance.
 */
export interface PermalinkOptions {
  readonly tier?: PermalinkTier | "auto";
  readonly maxEncodedLength?: number;
}

/**
 * Thrown by `chart.permalink()` when the encoded Tier 2 fragment exceeds the
 * configured limit. Surfaces the actual length + the limit so hosts can
 * decide whether to retry with a trimmed state or warn the user.
 */
export class PermalinkTooLargeError extends Error {
  override readonly name = "PermalinkTooLargeError";
  readonly encodedLength: number;
  readonly limit: number;
  constructor(encodedLength: number, limit: number, message?: string) {
    super(message ?? `permalink ${encodedLength} chars exceeds limit ${limit}`);
    this.encodedLength = encodedLength;
    this.limit = limit;
  }
}
