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
  | "parallelChannel";

export type HorizontalRayDirection = "left" | "right";

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

export type Drawing =
  | TrendlineDrawing
  | HorizontalLineDrawing
  | VerticalLineDrawing
  | RectangleDrawing
  | FibRetracementDrawing
  | RayDrawing
  | ExtendedLineDrawing
  | HorizontalRayDrawing
  | ParallelChannelDrawing;

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
}
