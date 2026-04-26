/**
 * Phase 14 Cycle A — pane primitives. Multi-pane layouts split the chart's
 * vertical area into N stacked panes that share a single time axis. Each
 * pane owns its own plot rect, price scale(s), and price axis.
 *
 * `PaneId` is brand-aliased from `core/drawings/types` so phase-13 drawings
 * (whose anchors carry `paneId`) and phase-14 panes share the same id space.
 */

import { type PaneId, asPaneId, MAIN_PANE_ID } from "../drawings/types.js";
import type { PriceFormatter, PriceScaleMargins, PriceScaleOptions } from "../../types.js";

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
 * constructor. Pre-1.0 so missing fields are not breaking.
 *
 * Cycle B-extended fields (`height`, `hidden`, `priceFormatter`,
 * `priceScales`) are also accepted by `pane.applyOptions(patch)`; the
 * patcher routes them to the matching `set*` methods. `id` is read on
 * `addPane` only — passing `id` to `applyOptions` warns and ignores.
 */
export interface PaneOptions {
  readonly id?: PaneId;
  readonly stretchFactor?: number;
  readonly minHeight?: number;
  /**
   * Phase 14 Cycle B — pinned pixel height. When set, the pane is
   * subtracted from `availableHeight` first and the remainder is
   * distributed by `stretchFactor` across remaining flex panes. `null`
   * clears the pin. `applyOptions` precedence: when both `height` and
   * `stretchFactor` are present in a patch, `height` wins (sticky via
   * `heightOverride`).
   */
  readonly height?: number | null;
  /**
   * Phase 14 Cycle B — pane visibility. Hidden panes occupy 0 px of
   * layout; subtree state (series, scales, drawings) is preserved.
   */
  readonly hidden?: boolean;
  /**
   * Phase 14 Cycle B — per-pane price formatter override. `null` falls
   * back to the chart's `priceFormatter`. Useful for the volume pane's
   * `12.5K` / `1.4M` formatting versus the candle pane's 2-decimal price.
   */
  readonly priceFormatter?: PriceFormatter | null;
  /**
   * Phase 14 Cycle B — per-slot scale options patch. Cycle B routes only
   * the `mode` sub-field through `applyOptions` (margins are set on slot
   * creation via `addSeriesToScale`'s `marginsHint`). Future cycles may
   * widen this.
   */
  readonly priceScales?: {
    readonly right?: PriceScaleOptions;
    readonly left?: PriceScaleOptions;
  };
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
