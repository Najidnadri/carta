/**
 * Phase 13 — drawing-tools type surface. Anchors live in DATA SPACE
 * (`{ time, price, paneId }`), not pixels — the renderer projects per frame
 * via the existing `TimeScale` / `PriceScale`. Discriminated `Drawing` union
 * lets parsers + renderers exhaustive-switch on `kind` without `as` casts.
 */

import type { Price, Time } from "../../types.js";

export type DrawingId = string & { readonly __brand: "DrawingId" };
export type PaneId = string & { readonly __brand: "PaneId" };

export const asDrawingId = (s: string): DrawingId => s as DrawingId;
export const asPaneId = (s: string): PaneId => s as PaneId;

/** Convention: every Cycle-A anchor has `paneId === MAIN_PANE_ID`. */
export const MAIN_PANE_ID: PaneId = asPaneId("main");

export interface DrawingAnchor {
  readonly time: Time;
  readonly price: Price;
  readonly paneId: PaneId;
}

export type DrawingKind =
  | "trendline"
  | "horizontalLine"
  | "verticalLine"
  | "rectangle"
  | "fibRetracement"
  | "ray"
  | "extendedLine"
  | "horizontalRay"
  | "parallelChannel"
  | "longPosition"
  | "shortPosition"
  | "text"
  | "callout"
  | "arrow"
  | "dateRange"
  | "priceRange"
  | "priceDateRange";

export type HorizontalRayDirection = "left" | "right";

/**
 * Phase 13 Cycle B.2 — display mode for position-tool readouts.
 * `'rr'` shows risk:reward + price delta; `'percent'` shows %; `'price'`
 * shows raw delta; `'ticks'` shows tick count (requires `tickSize`).
 */
export type DisplayMode = "rr" | "percent" | "price" | "ticks";

export type StrokeStyle = "solid" | "dashed" | "dotted";
export type ExtendMode = "none" | "left" | "right" | "both";

export interface DrawingStroke {
  readonly color: number;
  readonly alpha?: number;
  readonly width?: number;
  readonly style?: StrokeStyle;
}

export interface DrawingFill {
  readonly color: number;
  readonly alpha?: number;
}

export interface DrawingTextStyle {
  readonly color: number;
  readonly size?: number;
  readonly weight?: "normal" | "bold";
}

export interface DrawingStyle {
  readonly stroke?: DrawingStroke;
  readonly fill?: DrawingFill;
  readonly text?: DrawingTextStyle;
  readonly extend?: ExtendMode;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

interface DrawingCommon {
  readonly id: DrawingId;
  readonly style: DrawingStyle;
  readonly locked: boolean;
  readonly visible: boolean;
  readonly z: number;
  readonly meta?: Readonly<Record<string, JsonValue>>;
  readonly schemaVersion: 1;
}

export interface TrendlineDrawing extends DrawingCommon {
  readonly kind: "trendline";
  /** [start, end] in data space. */
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor];
}

export interface HorizontalLineDrawing extends DrawingCommon {
  readonly kind: "horizontalLine";
  readonly anchors: readonly [DrawingAnchor];
}

export interface VerticalLineDrawing extends DrawingCommon {
  readonly kind: "verticalLine";
  readonly anchors: readonly [DrawingAnchor];
}

export interface RectangleDrawing extends DrawingCommon {
  readonly kind: "rectangle";
  /** Opposite corners. */
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor];
}

export interface FibLevel {
  readonly value: number;
  readonly color?: number;
  readonly alpha?: number;
  readonly visible?: boolean;
}

export interface FibRetracementDrawing extends DrawingCommon {
  readonly kind: "fibRetracement";
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor];
  readonly levels: readonly FibLevel[];
  readonly showPrices: boolean;
  readonly showPercents: boolean;
}

export interface RayDrawing extends DrawingCommon {
  readonly kind: "ray";
  /** [origin, direction-point]. Visible from `anchors[0]` extended through `anchors[1]`. */
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor];
}

export interface ExtendedLineDrawing extends DrawingCommon {
  readonly kind: "extendedLine";
  /** [a, b]. Line is extended both directions in price/time space, clipped to the plot rect. */
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor];
}

export interface HorizontalRayDrawing extends DrawingCommon {
  readonly kind: "horizontalRay";
  readonly anchors: readonly [DrawingAnchor];
  /** Direction the ray extends from the anchor. */
  readonly direction: HorizontalRayDirection;
}

export interface ParallelChannelDrawing extends DrawingCommon {
  readonly kind: "parallelChannel";
  /**
   * `[a, b, c]` in data space. `(a,b)` defines the trendline; `c` defines the
   * parallel offset (Δprice = c.price - priceOnLineAtTime(c.time)). All three
   * are stored in data space so the channel survives pan/zoom/DPR transitions.
   */
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor, DrawingAnchor];
}

// ─── Phase 13 Cycle B.2 — position / text / callout / arrow / range kinds ──

/**
 * Long-position drawing — 3 anchors that all share `time = entryTime`, plus a
 * kind-specific `endTime` for the right edge of the visible band. Anchor
 * indices: `0 = entry`, `1 = stopLoss`, `2 = takeProfit`. Long invariant:
 * `sl.price < entry.price < tp.price`. Mirror for `ShortPositionDrawing`.
 */
export interface LongPositionDrawing extends DrawingCommon {
  readonly kind: "longPosition";
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor, DrawingAnchor];
  readonly endTime: Time;
  readonly qty: number;
  readonly displayMode: DisplayMode;
  readonly tickSize?: number;
}

export interface ShortPositionDrawing extends DrawingCommon {
  readonly kind: "shortPosition";
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor, DrawingAnchor];
  readonly endTime: Time;
  readonly qty: number;
  readonly displayMode: DisplayMode;
  readonly tickSize?: number;
}

export interface TextDrawing extends DrawingCommon {
  readonly kind: "text";
  readonly anchors: readonly [DrawingAnchor];
  readonly text: string;
}

export interface CalloutDrawing extends DrawingCommon {
  readonly kind: "callout";
  /** `[pin, labelCenter]`. Leader runs from pin to nearest label-bbox edge. */
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor];
  readonly text: string;
}

export interface ArrowDrawing extends DrawingCommon {
  readonly kind: "arrow";
  /** `[start, end]`. Filled triangular arrowhead at `end`. */
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor];
}

export interface DateRangeDrawing extends DrawingCommon {
  readonly kind: "dateRange";
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor];
}

export interface PriceRangeDrawing extends DrawingCommon {
  readonly kind: "priceRange";
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor];
}

export interface PriceDateRangeDrawing extends DrawingCommon {
  readonly kind: "priceDateRange";
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor];
}

export type Drawing =
  | TrendlineDrawing
  | HorizontalLineDrawing
  | VerticalLineDrawing
  | RectangleDrawing
  | FibRetracementDrawing
  | RayDrawing
  | ExtendedLineDrawing
  | HorizontalRayDrawing
  | ParallelChannelDrawing
  | LongPositionDrawing
  | ShortPositionDrawing
  | TextDrawing
  | CalloutDrawing
  | ArrowDrawing
  | DateRangeDrawing
  | PriceRangeDrawing
  | PriceDateRangeDrawing;

/** Default fib levels. Matches TradingView defaults. */
export const DEFAULT_FIB_LEVELS: readonly FibLevel[] = Object.freeze([
  Object.freeze({ value: 0 }),
  Object.freeze({ value: 0.236 }),
  Object.freeze({ value: 0.382 }),
  Object.freeze({ value: 0.5 }),
  Object.freeze({ value: 0.618 }),
  Object.freeze({ value: 0.786 }),
  Object.freeze({ value: 1 }),
]);

// ─── Persistence ───────────────────────────────────────────────────────────

export interface DrawingsSnapshot {
  readonly schemaVersion: 1;
  readonly drawings: readonly Drawing[];
}

export interface DrawingScope {
  readonly symbol: string;
  readonly chartId?: string;
  readonly intervalDuration?: number;
}

export interface DrawingsStorageAdapter {
  load(scope: DrawingScope): Promise<DrawingsSnapshot | null>;
  save(scope: DrawingScope, snapshot: DrawingsSnapshot): Promise<void>;
  list?: () => Promise<readonly DrawingScope[]>;
  remove?: (scope: DrawingScope) => Promise<void>;
}

// ─── Event payloads ────────────────────────────────────────────────────────

export interface DrawingsChangedPayload {
  readonly drawing: Drawing;
}

export interface DrawingsRemovedPayload {
  readonly id: DrawingId;
  readonly kind: DrawingKind;
}

export interface DrawingsSelectedPayload {
  readonly drawing: Drawing | null;
}

export interface DrawingEditPayload {
  readonly drawing: Drawing;
}

export interface DrawingContextMenuPayload {
  readonly drawing: Drawing;
  readonly screen: {
    readonly x: number;
    readonly y: number;
  };
  readonly source: "long-press" | "right-click";
}

// ─── Public API options ────────────────────────────────────────────────────

export interface BeginCreateOptions {
  readonly style?: DrawingStyle;
  readonly z?: number;
  readonly meta?: Readonly<Record<string, JsonValue>>;
  readonly levels?: readonly FibLevel[];
  readonly showPrices?: boolean;
  readonly showPercents?: boolean;
  /** Default direction for `horizontalRay`. Defaults to `'right'`. */
  readonly direction?: HorizontalRayDirection;
  // ─── Phase 13 Cycle B.2 ───
  /** Initial text content for `text` / `callout`. Defaults to `''`. */
  readonly text?: string;
  /** Position-tool quantity (positive finite). Defaults to 1. */
  readonly qty?: number;
  /** Position-tool tick size (positive finite). Omit for percent-mode readouts. */
  readonly tickSize?: number;
  /** Position-tool readout mode. Defaults to `'rr'`. */
  readonly displayMode?: DisplayMode;
  /**
   * Position-tool right-edge time. When omitted, controller fills it on
   * materialize using the second anchor's time (if 4 clicks placed) or
   * `entryTime + 12 * intervalDuration` (legacy 3-click flow).
   */
  readonly endTime?: number;
}
