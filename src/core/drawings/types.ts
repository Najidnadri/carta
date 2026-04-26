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
  | "priceDateRange"
  // ─── Phase 13 Cycle C.1 — exotic geometry tools ────────────────────────
  | "pitchfork"
  | "gannFan"
  | "ellipse"
  // ─── Phase 13 Cycle C.2 — fib variants ─────────────────────────────────
  | "fibExtension"
  | "fibTimeZones"
  | "fibFan"
  | "fibArcs"
  // ─── Phase 13 Cycle C.3 — brush + icon ─────────────────────────────────
  | "brush"
  | "icon";

export type HorizontalRayDirection = "left" | "right";

/**
 * Phase 13 Cycle C.1 — pitchfork variant. Three sibling kinds that share
 * anchor count, hit-test, render — they differ only in how the centreline
 * base is computed from `(pivot, reaction1, reaction2)`:
 *
 *   - `'andrews'`: base = midpoint of (reaction1, reaction2).
 *   - `'schiff'`: base = (pivot.time, midpoint of reaction prices).
 *   - `'modifiedSchiff'`: base = (midpoint of reaction times, midpoint of reaction prices).
 */
export type PitchforkVariant = "andrews" | "schiff" | "modifiedSchiff";

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

// ─── Phase 13 Cycle C.1 — exotic geometry tools ────────────────────────────

/**
 * Pitchfork — 3-anchor: `[pivot, reaction1, reaction2]`. The centreline runs
 * from `pivot` through a `variant`-dependent base point; the upper and lower
 * rails run parallel to the centreline through `reaction1` and `reaction2`.
 * `style.extend` defaults to `'right'` (forward-looking trader convention).
 */
export interface PitchforkDrawing extends DrawingCommon {
  readonly kind: "pitchfork";
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor, DrawingAnchor];
  readonly variant: PitchforkVariant;
}

/**
 * Gann fan — 2-anchor: `[pivot, direction]`. Emits 9 rays from `pivot` at
 * Gann slopes `{1/8, 1/4, 1/3, 1/2, 1/1, 2/1, 3/1, 4/1, 8/1}` measured in
 * price-time space (ratio-locked under pan/zoom). The 1×1 line passes
 * through `direction`; the other slopes are integer multiples / divisors.
 * `style.extend` defaults to `'right'`.
 */
export interface GannFanDrawing extends DrawingCommon {
  readonly kind: "gannFan";
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor];
}

/**
 * Ellipse / circle — opposite-corner bbox anchor. `[a, b]` define the
 * axis-aligned bounding rectangle; the ellipse is inscribed. `rx == ry`
 * produces a circle. Rotation is out of scope for v1.
 */
export interface EllipseDrawing extends DrawingCommon {
  readonly kind: "ellipse";
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor];
}

// ─── Phase 13 Cycle C.2 — fib variants ─────────────────────────────────────

/**
 * Fibonacci extension — 3-anchor: `[a, b, c]`.
 *  - `(a, b)` defines the impulse leg span.
 *  - `c` is the extension origin (typical pullback low for an uptrend).
 *
 * Each level renders at price `c.price + level * (b.price - a.price)`. The
 * x-extent of level lines spans `min..max` of the 3 anchor times. Same label
 * placement convention as `fibRetracement` (`'right-of-x'`).
 */
export interface FibExtensionDrawing extends DrawingCommon {
  readonly kind: "fibExtension";
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor, DrawingAnchor];
  readonly levels: readonly FibLevel[];
  readonly showPrices: boolean;
  readonly showPercents: boolean;
}

/**
 * Fibonacci time zones — 1-anchor + chart's `intervalDuration`. Vertical
 * lines render at bar offsets in `offsets` (default Fibonacci sequence).
 * `offsets[i]` projects to `origin.time + offsets[i] * intervalDuration`.
 * The origin (offset = 0) is **not** drawn by default — the anchor handle
 * already marks it.
 */
export interface FibTimeZonesDrawing extends DrawingCommon {
  readonly kind: "fibTimeZones";
  readonly anchors: readonly [DrawingAnchor];
  readonly offsets: readonly number[];
}

/**
 * Fibonacci fan — 2-anchor: `[a, b]`. Rays emanate from `a` through
 * `(b.time, a.price + level * (b.price - a.price))` for each level. Same
 * `extendSegment` clipping as Gann fan.
 */
export interface FibFanDrawing extends DrawingCommon {
  readonly kind: "fibFan";
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor];
  readonly levels: readonly FibLevel[];
}

/**
 * Fibonacci arcs — 2-anchor: `[a, b]`. `a` is the arc center; the radius is
 * computed in **screen space** as `‖proj(b) − proj(a)‖` per frame, then each
 * ring renders at `r * level`. Half-arcs (bottom hemisphere) — TradingView
 * convention. Levels containing `0` skip naturally via the `r < 1` guard.
 *
 * Projection is asymmetric: anchors live in data space, but the radius
 * transitions through screen space each frame. The invariant "A is at the
 * arc center, B is on the level-1 ring" holds because both are recomputed
 * from the same projection per frame.
 */
export interface FibArcsDrawing extends DrawingCommon {
  readonly kind: "fibArcs";
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor];
  readonly levels: readonly FibLevel[];
  /**
   * Phase 13 Cycle C.3 — when `true`, render a percentage label per ring at
   * the `+x` end of the diameter (`'right-of-cx'` placement). Default `false`
   * to preserve the C.2-shipped TradingView-style label-free arcs.
   */
  readonly showRingLabels?: boolean;
}

// ─── Phase 13 Cycle C.3 — brush + icon ─────────────────────────────────────

/**
 * Brush / freehand stroke. Variable-arity: `points` carries the
 * RDP-simplified polyline (≥ 2 points), while `anchors` is a 2-tuple bbox
 * (start + end of the simplified polyline) so existing helpers that expect a
 * fixed `anchors.length` keep working. Body-drag translates both arrays from
 * a snapshot taken at drag-start; intermediate-point editing is out of scope
 * for v1 (delete + redraw).
 */
export interface BrushDrawing extends DrawingCommon {
  readonly kind: "brush";
  readonly anchors: readonly [DrawingAnchor, DrawingAnchor];
  readonly points: readonly DrawingAnchor[];
}

/**
 * Icon glyph identifier — one of the 10 silhouettes shipped in `IconAtlas`.
 * Hosts that need a richer set must wait for phase 16 (plugin architecture).
 */
export type IconGlyph =
  | "arrowUp"
  | "arrowDown"
  | "flag"
  | "target"
  | "cross"
  | "check"
  | "star"
  | "exclaim"
  | "dollar"
  | "comment";

/** Default catalog — single row, deterministic order. Render-time atlas reads from this list. */
export const DEFAULT_ICON_GLYPHS: readonly IconGlyph[] = Object.freeze([
  "arrowUp",
  "arrowDown",
  "flag",
  "target",
  "cross",
  "check",
  "star",
  "exclaim",
  "dollar",
  "comment",
]);

/**
 * Icon stamp — single anchor in data space, rendered as a tinted sprite from
 * the runtime-built atlas. `size` controls the rendered CSS-px size; default
 * 32. `tint` overrides the default `theme.text` color.
 */
export interface IconDrawing extends DrawingCommon {
  readonly kind: "icon";
  readonly anchors: readonly [DrawingAnchor];
  readonly glyph: IconGlyph;
  /** Rendered CSS-px size (square). Defaults to 32. */
  readonly size?: number;
  /** Hex color (0xRRGGBB). Defaults to `theme.text`. */
  readonly tint?: number;
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
  | PriceDateRangeDrawing
  | PitchforkDrawing
  | GannFanDrawing
  | EllipseDrawing
  | FibExtensionDrawing
  | FibTimeZonesDrawing
  | FibFanDrawing
  | FibArcsDrawing
  | BrushDrawing
  | IconDrawing;

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

/**
 * Default fib-extension levels. Subset of TradingView's full set, chosen to
 * minimize label collision on default viewports. Hosts override via
 * `BeginCreateOptions.levels`.
 */
export const DEFAULT_FIB_EXTENSION_LEVELS: readonly FibLevel[] = Object.freeze([
  Object.freeze({ value: 0 }),
  Object.freeze({ value: 0.382 }),
  Object.freeze({ value: 0.618 }),
  Object.freeze({ value: 1 }),
  Object.freeze({ value: 1.272 }),
  Object.freeze({ value: 1.618 }),
  Object.freeze({ value: 2.618 }),
]);

/** Default fib-fan levels — canonical 5-ray TradingView set. */
export const DEFAULT_FIB_FAN_LEVELS: readonly FibLevel[] = Object.freeze([
  Object.freeze({ value: 0 }),
  Object.freeze({ value: 0.382 }),
  Object.freeze({ value: 0.5 }),
  Object.freeze({ value: 0.618 }),
  Object.freeze({ value: 1 }),
]);

/** Default fib-arc levels — 8 rings, TradingView convention. */
export const DEFAULT_FIB_ARC_LEVELS: readonly FibLevel[] = Object.freeze([
  Object.freeze({ value: 0.236 }),
  Object.freeze({ value: 0.382 }),
  Object.freeze({ value: 0.5 }),
  Object.freeze({ value: 0.618 }),
  Object.freeze({ value: 0.786 }),
  Object.freeze({ value: 1 }),
  Object.freeze({ value: 1.272 }),
  Object.freeze({ value: 1.618 }),
]);

/**
 * Default fib-time-zones offsets — Fibonacci sequence starting at 1. Offset 0
 * is intentionally omitted (the anchor handle marks the origin).
 */
export const DEFAULT_FIB_TIME_ZONE_OFFSETS: readonly number[] = Object.freeze([
  1, 2, 3, 5, 8, 13, 21, 34, 55, 89,
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

/**
 * Phase 13 Cycle B.3 — multi-select payload shape.  `drawings` carries the
 * full selection set (length 0 = nothing selected, length 1 = single-select,
 * length ≥ 2 = multi).  `primary` is the most recently clicked / focused
 * drawing — convenience for hosts that want the singular "active" entry
 * without doing `drawings.length === 1 ? drawings[0] : null`.  Pre-1.0
 * breaking change from the cycle-A singular `drawing` field; master-plan
 * §5 explicitly authorizes the migration.
 */
export interface DrawingsSelectedPayload {
  readonly drawings: readonly Drawing[];
  readonly primary: Drawing | null;
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
  // ─── Phase 13 Cycle C.1 ───
  /** Pitchfork variant. Defaults to `'andrews'`. Ignored for non-pitchfork kinds. */
  readonly variant?: PitchforkVariant;
  // ─── Phase 13 Cycle C.3 ───
  /** Icon glyph. Required when `beginCreate('icon')`. Defaults to `'flag'`. */
  readonly glyph?: IconGlyph;
  /** Icon size override (CSS px). Defaults to 32. */
  readonly size?: number;
  /** Icon tint override. Defaults to `theme.text`. */
  readonly tint?: number;
}
