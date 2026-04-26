import { Container, Graphics } from "pixi.js";
import {
  asPrice,
  type Logger,
  type PriceDomain,
  type PriceFormatter,
  type PriceScaleFacade,
  type PriceScaleMargins,
  type Theme,
} from "../../types.js";
import { defaultPriceFormatter, PriceAxis } from "../price/PriceAxis.js";
import {
  reducePriceRanges,
  type PriceRange,
  type PriceRangeProvider,
} from "../price/PriceRangeProvider.js";
import { DEFAULT_PRICE_MARGINS, PriceScale } from "../price/PriceScale.js";
import type { PaneId, PaneRect, PriceScaleId, PriceScaleSide } from "./types.js";

const DEFAULT_DOMAIN_MIN = 0;
const DEFAULT_DOMAIN_MAX = 1;

const FROZEN_DEFAULT_DOMAIN: PriceDomain = Object.freeze({
  min: asPrice(DEFAULT_DOMAIN_MIN),
  max: asPrice(DEFAULT_DOMAIN_MAX),
});

export interface PaneConstructionOptions {
  readonly id: PaneId;
  readonly stretchFactor?: number | undefined;
  readonly minHeight?: number | undefined;
  /** When true, this pane owns a `PriceAxis` rendered on the right strip. */
  readonly hasRightAxis?: boolean | undefined;
}

interface PriceScaleSlotState {
  readonly id: PriceScaleId;
  readonly side: PriceScaleSide | "overlay";
  margins: PriceScaleMargins;
  priceDomain: PriceDomain;
  autoScaleEnabled: boolean;
  lastRenderedDomain: PriceDomain;
  readonly providers: Set<PriceRangeProvider>;
  /** Stable facade so external refs survive re-renders. */
  readonly facade: PriceScaleFacade;
}

/**
 * Phase 14 Cycle A — single pane in the multi-pane scene graph. Owns its
 * own `Container` subtree (`paneContainer > [gridLayer, plotClip > [series,
 * overlays, drawings]]`) plus a per-pane `PriceAxis` and a map of price-scale
 * slots keyed by `PriceScaleId`.
 *
 * The primary pane's containers are reachable via `Renderer` getter shims
 * during cycle A so existing test code that pokes `renderer.seriesLayer` /
 * `renderer.plotClip` continues to work — this internal back-compat is
 * removed in cycle B's drag-resize refactor.
 */
export class Pane {
  readonly id: PaneId;
  readonly paneContainer: Container;
  readonly gridLayer: Container;
  readonly plotClip: Container;
  readonly seriesLayer: Container;
  readonly overlaysLayer: Container;
  readonly drawingsLayer: Container;
  readonly priceAxis: PriceAxis | null;

  private readonly clipMask: Graphics;
  private readonly slots = new Map<string, PriceScaleSlotState>();
  private rect: PaneRect = { x: 0, y: 0, w: 0, h: 0 };
  private destroyed = false;

  stretchFactor: number;
  minHeight: number;
  /**
   * Phase 14 Cycle A — when `true`, the pane is excluded from layout (height
   * = 0; subtree `visible = false`). State (price scales, series, etc.) is
   * preserved so unhiding restores the pane in place.
   */
  hidden = false;
  /**
   * Phase 14 Cycle A — explicit pixel height that overrides `stretchFactor`
   * for this pane. Set by `setHeight(px)` (drag-divider, programmatic). When
   * `null`, the pane participates in flex distribution. The chart-resize
   * handler keeps overrides sticky until next resize, mirroring TV LWC.
   */
  heightOverride: number | null = null;
  /**
   * Phase 14 Cycle A — per-pane override of the chart-level price formatter.
   * `null` falls back to the chart's `priceFormatter`. Useful for the volume
   * pane (integer formatting / `K` / `M` suffixes) versus the candle pane
   * (2-decimal price formatting).
   */
  priceFormatterOverride: PriceFormatter | null = null;

  constructor(options: PaneConstructionOptions) {
    this.id = options.id;
    this.stretchFactor =
      Number.isFinite(options.stretchFactor) && (options.stretchFactor ?? 0) > 0
        ? (options.stretchFactor ?? 1)
        : 1;
    this.minHeight =
      Number.isFinite(options.minHeight) && (options.minHeight ?? 0) > 0
        ? (options.minHeight ?? 50)
        : 50;

    this.paneContainer = new Container({ label: `pane:${String(options.id)}` });
    this.gridLayer = new Container({ label: `pane:${String(options.id)}:grid` });
    this.plotClip = new Container({ label: `pane:${String(options.id)}:plotClip` });
    this.seriesLayer = new Container({
      label: `pane:${String(options.id)}:series`,
      isRenderGroup: true,
    });
    this.overlaysLayer = new Container({ label: `pane:${String(options.id)}:overlays` });
    this.drawingsLayer = new Container({ label: `pane:${String(options.id)}:drawings` });

    this.clipMask = new Graphics();
    this.plotClip.addChild(this.seriesLayer, this.overlaysLayer, this.drawingsLayer);
    this.plotClip.addChild(this.clipMask);
    this.plotClip.mask = this.clipMask;

    this.paneContainer.addChild(this.gridLayer, this.plotClip);

    this.priceAxis =
      options.hasRightAxis === false
        ? null
        : new PriceAxis(this.gridLayer, this.paneContainer);

    // Default `'right'` slot is always present.
    this.createSlot("right", "right", DEFAULT_PRICE_MARGINS);
  }

  /**
   * Apply pane-level position + clip rect. Called from the chart's flush
   * once per layout pass. Pane-local coords inside the subtree always start
   * at `(0, 0)` regardless of where the pane sits on the canvas.
   */
  applyRect(rect: PaneRect): void {
    if (this.destroyed) {
      return;
    }
    this.rect = rect;
    this.paneContainer.position.set(rect.x, rect.y);
    this.paneContainer.visible = !this.hidden && rect.h > 0;
    const safeW = Math.max(0, rect.w);
    const safeH = Math.max(0, rect.h);
    this.clipMask.clear().rect(0, 0, safeW, safeH).fill(0xffffff);
  }

  /**
   * Phase 14 Cycle A — programmatic visibility toggle. Hidden panes occupy
   * 0 px of layout space and their subtree is invisible; series + scale
   * state are preserved. Caller must invalidate `'layout'` after a flip.
   */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
  }

  /**
   * Phase 14 Cycle A — set a per-pane price formatter override (e.g.,
   * integer formatting for the volume pane). Pass `null` to fall back to
   * the chart's `priceFormatter`.
   */
  setPriceFormatter(formatter: PriceFormatter | null): void {
    this.priceFormatterOverride = formatter;
  }

  /**
   * Phase 14 Cycle A — pin this pane's height to `px`. `null` clears the
   * override and lets the pane flex via `stretchFactor`. Used by drag-divider
   * + programmatic `pane.setHeight`. Caller invalidates layout.
   */
  setHeight(px: number | null): void {
    if (px === null) {
      this.heightOverride = null;
      return;
    }
    if (!Number.isFinite(px) || px < 0) {
      return;
    }
    this.heightOverride = Math.max(this.minHeight, Math.floor(px));
  }

  /** Current pane rect in canvas coords (set by `applyRect`). */
  getRect(): PaneRect {
    return this.rect;
  }

  /**
   * Lookup or lazy-create a price-scale slot. The default `'right'` slot is
   * created in the constructor; any other id (including the empty-string
   * overlay sentinel) is created on first reference.
   */
  ensureSlot(scaleId: PriceScaleId, marginsHint?: PriceScaleMargins): PriceScaleSlotState {
    const key = String(scaleId);
    const existing = this.slots.get(key);
    if (existing !== undefined) {
      if (marginsHint !== undefined) {
        existing.margins = Object.freeze({
          top: Number.isFinite(marginsHint.top) ? marginsHint.top : DEFAULT_PRICE_MARGINS.top,
          bottom: Number.isFinite(marginsHint.bottom)
            ? marginsHint.bottom
            : DEFAULT_PRICE_MARGINS.bottom,
        });
      }
      return existing;
    }
    const side: PriceScaleSide | "overlay" =
      key === "right" ? "right" : key === "left" ? "left" : "overlay";
    return this.createSlot(scaleId, side, marginsHint ?? DEFAULT_PRICE_MARGINS);
  }

  private createSlot(
    id: PriceScaleId,
    side: PriceScaleSide | "overlay",
    margins: PriceScaleMargins,
  ): PriceScaleSlotState {
    const slot: PriceScaleSlotState = {
      id,
      side,
      margins: Object.freeze({ top: margins.top, bottom: margins.bottom }),
      priceDomain: FROZEN_DEFAULT_DOMAIN,
      autoScaleEnabled: false,
      lastRenderedDomain: FROZEN_DEFAULT_DOMAIN,
      providers: new Set(),
      facade: {} as PriceScaleFacade, // backfilled below
    };
    (slot as { facade: PriceScaleFacade }).facade = {
      setDomain: (min, max): void => {
        const rawMin = Number(min);
        const rawMax = Number(max);
        const next: PriceDomain = Object.freeze({
          min: asPrice(rawMin),
          max: asPrice(rawMax),
        });
        slot.priceDomain = next;
        slot.autoScaleEnabled = false;
      },
      getDomain: (): PriceDomain => slot.lastRenderedDomain,
      isAutoScale: (): boolean => slot.autoScaleEnabled,
      setAutoScale: (on: boolean): void => {
        slot.autoScaleEnabled = on;
      },
    };
    this.slots.set(String(id), slot);
    return slot;
  }

  /**
   * Public facade for the requested scale slot. Lazy-creates the slot if it
   * doesn't exist yet (default `'right'` is always present).
   */
  priceScale(scaleId: PriceScaleId = "right"): PriceScaleFacade {
    return this.ensureSlot(scaleId).facade;
  }

  /** Slot iterator — chart's flush walks every slot per pane. */
  scales(): readonly PriceScaleSlotState[] {
    return Array.from(this.slots.values());
  }

  /**
   * Register a series (or any `PriceRangeProvider`) on a scale slot.
   * Optionally adopts custom margins for the slot — used by the volume-overlay
   * recipe to set `{ top: 0.8, bottom: 0 }` on first attach.
   */
  addSeriesToScale(
    provider: PriceRangeProvider,
    scaleId: PriceScaleId,
    marginsHint?: PriceScaleMargins,
  ): void {
    const slot = this.ensureSlot(scaleId, marginsHint);
    slot.providers.add(provider);
  }

  removeSeriesFromScale(provider: PriceRangeProvider, scaleId: PriceScaleId): void {
    const slot = this.slots.get(String(scaleId));
    slot?.providers.delete(provider);
  }

  /**
   * Per-flush reconciliation. For each slot: if auto-scale is on, query its
   * providers and update `lastRenderedDomain`; otherwise mirror the manual
   * `priceDomain`.
   */
  reconcileEachScale(startTime: number, endTime: number): void {
    for (const slot of this.slots.values()) {
      if (!slot.autoScaleEnabled) {
        slot.lastRenderedDomain = slot.priceDomain;
        continue;
      }
      // Cast through `unknown` — the auto-scale path runs against the chart's
      // window times which arrive as plain numbers; the reducer reads them
      // back via `Number(...)` so the brand is irrelevant at runtime.
      const reduced: PriceRange | null = reducePriceRanges(
        slot.providers,
        startTime as never,
        endTime as never,
      );
      if (reduced === null) {
        // Retain prior rendered domain — don't collapse to [0, 1].
        continue;
      }
      slot.lastRenderedDomain = Object.freeze({ min: reduced.min, max: reduced.max });
    }
  }

  /**
   * Construct a fresh `PriceScale` for the requested slot using the pane's
   * current pixel height. Mirrors the prior `currentPriceScaleForRect` path.
   *
   * Phase 14 Cycle A — overlay slots interpret `scaleMargins` using the
   * TradingView Lightweight-Charts convention (absolute fractions of pane
   * height: `top=0.8, bottom=0` ⇒ data fills the bottom 20 % of the pane).
   * Carta's underlying `PriceScale` uses headroom-additive fractions, so we
   * translate `tv → carta` here. Right / left slots keep the existing
   * headroom semantics so phase 04+ behavior is unchanged.
   */
  currentPriceScaleForSlot(scaleId: PriceScaleId = "right"): PriceScale {
    const slot = this.ensureSlot(scaleId);
    const margins = slot.side === "overlay" ? translateOverlayMargins(slot.margins) : slot.margins;
    return new PriceScale({
      domainMin: slot.lastRenderedDomain.min,
      domainMax: slot.lastRenderedDomain.max,
      pixelHeight: this.rect.h,
      margins,
    });
  }

  /**
   * Renders the pane's `PriceAxis` (when present) against the primary
   * `'right'` scale. Cycle A — only the right axis renders; left + overlay
   * axes are cycle B.
   */
  renderPriceAxis(
    theme: Theme,
    formatter: PriceFormatter = defaultPriceFormatter,
    logger?: Logger,
  ): void {
    if (this.priceAxis === null) {
      return;
    }
    const scale = this.currentPriceScaleForSlot("right");
    // Phase 14 Cycle A — per-pane formatter wins over the chart-level one.
    const effective = this.priceFormatterOverride ?? formatter;
    this.priceAxis.render(
      scale,
      { x: 0, y: 0, w: this.rect.w, h: this.rect.h },
      theme,
      effective,
      logger,
    );
  }

  /**
   * Force the slot's `lastRenderedDomain` to a manual value. Used by the
   * `PriceAxisController` drag handler — the controller mutates only the
   * primary `'right'` slot via its facade, but keeps the prior call
   * pattern (`applyManualDomain`) for symmetry with phase 04.
   */
  applyManualDomain(scaleId: PriceScaleId, domain: PriceDomain): void {
    const slot = this.ensureSlot(scaleId);
    slot.priceDomain = Object.freeze({ min: domain.min, max: domain.max });
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.plotClip.mask = null;
    this.priceAxis?.destroy();
    this.paneContainer.parent?.removeChild(this.paneContainer);
    this.paneContainer.destroy({ children: true });
    this.slots.clear();
  }
}

/**
 * Convert TradingView Lightweight-Charts absolute-fraction margins to Carta
 * headroom-additive margins. TV LWC interprets `top=0.8, bottom=0` as "data
 * fills the bottom 20 % of the pane"; Carta interprets the same numbers as
 * "add 80 % of the data range as headroom above v_max".
 *
 * Math: `data` slice fills `[paneH * top, paneH * (1 - bottom)]`. To map
 * Carta's `(t = (effectiveMax - rawValue) / span * paneH)` projection so the
 * data lands in that slice, we set `cartaTop = top / (1 - top - bottom)` and
 * `cartaBottom = bottom / (1 - top - bottom)`. Falls back to the input when
 * `top + bottom >= 1` (degenerate; the TV recipe never sums to 1).
 */
function translateOverlayMargins(tv: PriceScaleMargins): PriceScaleMargins {
  const t = Number.isFinite(tv.top) && tv.top >= 0 ? tv.top : 0;
  const b = Number.isFinite(tv.bottom) && tv.bottom >= 0 ? tv.bottom : 0;
  const denom = 1 - t - b;
  if (denom <= 0) {
    return tv;
  }
  return Object.freeze({ top: t / denom, bottom: b / denom });
}
