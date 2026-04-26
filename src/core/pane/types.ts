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
 * Phase 14 Cycle C — pane header configuration. Headers are off by default
 * (`addPane({ ... })` without a `header` field renders no strip). Hosts opt
 * in by passing a `PaneHeaderOptions` object; passing `false` (or omitting)
 * keeps the pane headerless.
 *
 * The primary pane is implicitly headerless — it's the canonical price
 * chart and any chevron / gear / × there would clutter the dominant view.
 * `addPane({ header })` on the primary pane warns and is ignored.
 *
 * Minimal surface for now — `title` is shown left-aligned in the strip;
 * `visible` lets hosts hide the strip without losing the title for a
 * future re-show. Cycle C does not add per-pane button toggles.
 */
export interface PaneHeaderOptions {
  /** Title shown at the left of the strip. Empty string hides the title. */
  readonly title?: string;
  /** When `false`, strip is not rendered (treated as `header: false`). */
  readonly visible?: boolean;
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
   * Phase 14 Cycle C — collapsed state. A collapsed pane shows only its
   * header strip (24 CSS px) — the plot region clamps to 0 px. Distinct
   * from `hidden`, which removes the pane (header included) entirely.
   * Toggled by the chevron in the header strip; programmatic via
   * `chart.setPaneCollapsed(id, bool)`. The pane's prior `heightOverride`
   * is preserved so re-expansion restores the size from before the
   * collapse.
   *
   * Setting `collapsed: true` on a pane without a header is allowed
   * (the pane vanishes visually, since neither plot nor header renders),
   * but is rarely useful — hosts who want that effect should use
   * `hidden: true`.
   */
  readonly collapsed?: boolean;
  /**
   * Phase 14 Cycle C — header strip configuration. `false` (default)
   * renders no header. An options object opts the pane in. Primary pane
   * may not have a header — passing one warns and is ignored.
   */
  readonly header?: PaneHeaderOptions | false;
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
