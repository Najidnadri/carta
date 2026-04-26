/**
 * Phase 14 Cycle A — pane primitives. Multi-pane layouts split the chart's
 * vertical area into N stacked panes that share a single time axis. Each
 * pane owns its own plot rect, price scale(s), and price axis.
 *
 * `PaneId` is brand-aliased from `core/drawings/types` so phase-13 drawings
 * (whose anchors carry `paneId`) and phase-14 panes share the same id space.
 */

import { type PaneId, asPaneId, MAIN_PANE_ID } from "../drawings/types.js";
import type { PriceScaleMargins } from "../../types.js";

export { asPaneId, MAIN_PANE_ID };
export type { PaneId };

/**
 * Pixel-space rect occupied by a single pane in canvas-local coords.
 * Returned by `PaneLayout.computePaneRects`.
 */
export interface PaneRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Options accepted by `chart.addPane(opts?)` and the internal primary-pane
 * constructor. Cycle A surface — extended in cycle B with `header`,
 * `priceScales`, `showTimeAxis`. Pre-1.0 so missing fields are not breaking.
 */
export interface PaneOptions {
  readonly id?: PaneId;
  readonly stretchFactor?: number;
  readonly minHeight?: number;
}

/**
 * Public pane-id sentinel for the canonical overlay scale. Empty string is
 * the TradingView LWC convention for "this series renders against an overlay
 * scale rather than a real left/right axis." Cycle A wires it up only for
 * the volume-overlay recipe; cycle B opens overlay ids to hosts.
 */
export const OVERLAY_SCALE_ID = "" as const;
export type OverlayScaleId = typeof OVERLAY_SCALE_ID;

/**
 * Stable string ids for the two real axis slots. Overlay scales use any other
 * string (typically `''` per TV LWC convention).
 */
export type PriceScaleSide = "right" | "left";
export type PriceScaleId = PriceScaleSide | OverlayScaleId | (string & {});

/**
 * Per-pane price-scale slot. Cycle A creates only the `'right'` slot by
 * default + lazy overlay slots when a series binds to one. Cycle B adds
 * `'left'`, `'bounded'` mode, etc.
 */
export interface PriceScaleSlot {
  readonly id: PriceScaleId;
  readonly margins: PriceScaleMargins;
}
