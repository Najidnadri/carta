import { Container, Graphics } from "pixi.js";
import {
  asPrice,
  type Logger,
  type PriceDomain,
  type PriceFormatter,
  type PriceScaleFacade,
  type PriceScaleMargins,
  type PriceScaleMode,
  type Theme,
} from "../../types.js";
import { defaultPriceFormatter, PriceAxis } from "../price/PriceAxis.js";
import {
  reducePriceRanges,
  type PriceRange,
  type PriceRangeProvider,
} from "../price/PriceRangeProvider.js";
import { DEFAULT_PRICE_MARGINS, PriceScale } from "../price/PriceScale.js";
import type { PaneId, PaneOptions, PaneRect, PriceScaleId, PriceScaleSide } from "./types.js";

const DEFAULT_DOMAIN_MIN = 0;
const DEFAULT_DOMAIN_MAX = 1;

const FROZEN_DEFAULT_DOMAIN: PriceDomain = Object.freeze({
  min: asPrice(DEFAULT_DOMAIN_MIN),
  max: asPrice(DEFAULT_DOMAIN_MAX),
});

/**
 * Phase 14 Cycle B — chart-side delegate that owns reorder + post-mutation
 * notification on this pane's behalf. Wired by `chart.addPane`. When
 * `null` (the pane is detached or constructed for a unit test), `pane.moveTo`
 * logs a warn and no-ops; `applyOptions` still mutates state but the chart
 * never sees the change so no events fire.
 */
export interface PaneOwner {
  /** Move the calling pane to `newIndex`. Owner enforces clamping + primary-pin. */
  movePaneTo(pane: Pane, newIndex: number): void;
  /**
   * Notify the chart that `applyOptions` mutated this pane. The chart
   * invalidates `'layout'` and emits `pane:resize` / `pane:visibility`
   * events for any field that changed. The patch is the original input;
   * the chart compares against pre-patch state for diff detection.
   */
  paneOptionsApplied(pane: Pane, patch: Partial<PaneOptions>, prePatchSnapshot: PrePatchPaneSnapshot): void;
}

/**
 * Phase 14 Cycle B — pre-applyOptions snapshot the chart uses to detect
 * which fields actually changed (so `pane:resize` / `pane:visibility` only
 * emit on real transitions).
 */
export interface PrePatchPaneSnapshot {
  readonly heightOverride: number | null;
  readonly hidden: boolean;
}

export interface PaneConstructionOptions {
  readonly id: PaneId;
  readonly stretchFactor?: number | undefined;
  readonly minHeight?: number | undefined;
  /** When true, this pane owns a `PriceAxis` rendered on the right strip. */
  readonly hasRightAxis?: boolean | undefined;
  /** Phase 14 Cycle B — diagnostic logger; defaults to a noop. */
  readonly logger?: Logger | undefined;
  /**
   * Phase 14 Cycle B — chart-side delegate for reorder operations. Wired by
   * `chart.addPane`; tests that construct `Pane` directly without a chart
   * pass `undefined` and `moveTo` becomes a warn-and-noop.
   */
  readonly paneOwner?: PaneOwner | undefined;
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
  /**
   * Phase 14 Cycle B — slot mode. Defaults to `{ kind: 'auto' }` *only*
   * after `setAutoScale(true)` is called; the pre-cycle-B default was
   * "manual with priceDomain `[0, 1]` until first setDomain", and we
   * preserve that behavior by initializing to `{ kind: 'manual', min: 0,
   * max: 1 }` at construction. `setMode` is the single source of truth.
   * `setDomain` / `setAutoScale` are sugar that delegate.
   */
  mode: PriceScaleMode;
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
  private readonly logger: Logger | null;
  private readonly paneOwner: PaneOwner | null;

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
    this.logger = options.logger ?? null;
    this.paneOwner = options.paneOwner ?? null;
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
      this.logger?.warn(
        `[carta] pane.setHeight: non-finite or negative px (${String(px)}) — ignored`,
      );
      return;
    }
    // Phase 14 Cycle B fix-up F-2 — cap at 65535 px (way beyond any real
    // display). Without this cap, `applyOptions({ height: MAX_SAFE_INTEGER })`
    // produces a 9e15-px-tall pane rect that overflows the price-tick
    // generator's inner loop. Warn at the boundary so the host sees the
    // degenerate input.
    const PANE_HEIGHT_CEILING = 65535;
    if (px > PANE_HEIGHT_CEILING) {
      this.logger?.warn(
        `[carta] pane.setHeight: ${String(px)} exceeds ceiling ${String(PANE_HEIGHT_CEILING)} — clamping`,
      );
    }
    const clamped = Math.min(PANE_HEIGHT_CEILING, Math.floor(px));
    this.heightOverride = Math.max(this.minHeight, clamped);
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
      // Phase 14 Cycle B — initial mode is `manual` with the default
      // [0, 1] domain so the pre-cycle-B behavior is unchanged for hosts
      // that only call `setDomain` then `setAutoScale(true)`.
      mode: { kind: "manual", min: DEFAULT_DOMAIN_MIN, max: DEFAULT_DOMAIN_MAX },
    };
    const logger = this.logger;
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
        // Bounded mode: keep mode object intact (the bound bracket survives
        // a `setDomain`); auto / manual modes flip to manual semantics.
        if (slot.mode.kind !== "bounded") {
          slot.mode = { kind: "manual", min: rawMin, max: rawMax };
        } else if (rawMin < slot.mode.min || rawMax > slot.mode.max) {
          logger?.warn(
            `[carta] bounded scale: setDomain(${String(rawMin)}, ${String(rawMax)}) clipped to bounds [${String(slot.mode.min)}, ${String(slot.mode.max)}]`,
          );
        }
      },
      getDomain: (): PriceDomain => slot.lastRenderedDomain,
      isAutoScale: (): boolean => slot.autoScaleEnabled,
      setAutoScale: (on: boolean): void => {
        slot.autoScaleEnabled = on;
        // Mirror the mode toggle for bookkeeping; bounded mode keeps its
        // bracket but autoScale is a separate axis (bounded + auto is the
        // RSI recipe; bounded + manual is the RSI-frozen-zoom recipe).
        if (slot.mode.kind !== "bounded") {
          slot.mode = on ? { kind: "auto" } : slot.mode.kind === "manual" ? slot.mode : { kind: "manual", min: DEFAULT_DOMAIN_MIN, max: DEFAULT_DOMAIN_MAX };
        }
      },
      setMode: (mode: PriceScaleMode): void => {
        const sanitized = sanitizePriceScaleMode(mode, logger);
        if (sanitized === null) {
          return;
        }
        slot.mode = sanitized;
        if (sanitized.kind === "manual") {
          slot.priceDomain = Object.freeze({
            min: asPrice(sanitized.min),
            max: asPrice(sanitized.max),
          });
          slot.autoScaleEnabled = false;
        } else if (sanitized.kind === "auto") {
          slot.autoScaleEnabled = true;
        }
        // Bounded keeps the existing autoScale flag (bounded + auto is
        // legal — autoscale runs first, then clamp).
      },
      getMode: (): PriceScaleMode => slot.mode,
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
   *
   * Phase 14 Cycle B — bounded slots run autoscale (or use the manual
   * priceDomain) first, then intersect the result with `[mode.min,
   * mode.max]` (with optional fractional `pad` widening on both sides).
   * RSI's `[0, 100]` autoscale output passes through unchanged; a buggy
   * `[0, 999]` gets clamped to `[0, 100]` and the spike is clipped by
   * `plotClip`.
   */
  reconcileEachScale(startTime: number, endTime: number): void {
    for (const slot of this.slots.values()) {
      let next: PriceDomain;
      if (!slot.autoScaleEnabled) {
        next = slot.priceDomain;
      } else {
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
        next = Object.freeze({ min: reduced.min, max: reduced.max });
      }
      if (slot.mode.kind === "bounded") {
        next = clampDomainToBounded(next, slot.mode);
      }
      slot.lastRenderedDomain = next;
    }
  }

  /**
   * Phase 14 Cycle B — declarative patch for pane state. Routes each
   * known field to its setter and emits at most one layout invalidation
   * (the chart's `invalidator` deduplicates `'layout'` reasons across
   * multiple `setHeight` / `setHidden` calls). `id` is immutable and
   * triggers a `logger.warn` if patched. Unknown keys are warned + ignored
   * (forward-compat for plugins).
   *
   * Precedence: when both `height` and `stretchFactor` are present in the
   * patch, `height` wins (sticky via `heightOverride`). Stretch is applied
   * first, then height.
   *
   * `applyOptions({})` is a silent no-op — no events, no invalidation.
   * Callers (the chart) own invalidation; this method only mutates state.
   */
  applyOptions(patch: Partial<PaneOptions>): void {
    if (this.destroyed) {
      return;
    }
    if (Object.keys(patch).length === 0) {
      return;
    }
    const prePatch: PrePatchPaneSnapshot = {
      heightOverride: this.heightOverride,
      hidden: this.hidden,
    };
    const knownKeys = new Set([
      "id",
      "stretchFactor",
      "minHeight",
      "height",
      "hidden",
      "priceFormatter",
      "priceScales",
    ]);
    for (const key of Object.keys(patch)) {
      if (!knownKeys.has(key)) {
        this.logger?.warn(`[carta] pane.applyOptions: unknown key '${key}' ignored`);
      }
    }
    if (patch.id !== undefined) {
      this.logger?.warn(
        `[carta] pane.applyOptions: 'id' is immutable; ignored`,
      );
    }
    if (patch.stretchFactor !== undefined) {
      const sf = patch.stretchFactor;
      if (Number.isFinite(sf) && sf > 0) {
        this.stretchFactor = sf;
      } else {
        this.logger?.warn(
          `[carta] pane.applyOptions: stretchFactor must be a positive number; got ${String(patch.stretchFactor)}`,
        );
      }
    }
    if (patch.minHeight !== undefined) {
      const mh = patch.minHeight;
      if (Number.isFinite(mh) && mh > 0) {
        this.minHeight = Math.max(30, Math.floor(mh));
      } else {
        this.logger?.warn(
          `[carta] pane.applyOptions: minHeight must be a positive number; got ${String(patch.minHeight)}`,
        );
      }
    }
    if (patch.height !== undefined) {
      this.setHeight(patch.height);
    }
    if (patch.hidden !== undefined) {
      this.setHidden(patch.hidden);
    }
    if (patch.priceFormatter !== undefined) {
      this.setPriceFormatter(patch.priceFormatter);
    }
    if (patch.priceScales !== undefined) {
      if (patch.priceScales.right?.mode !== undefined) {
        this.priceScale("right").setMode(patch.priceScales.right.mode);
      }
      if (patch.priceScales.left?.mode !== undefined) {
        this.priceScale("left").setMode(patch.priceScales.left.mode);
      }
    }
    this.paneOwner?.paneOptionsApplied(this, patch, prePatch);
  }

  /**
   * Phase 14 Cycle B — request the chart to move this pane to `newIndex`
   * (insertion semantics: existing panes shift to make room; primary pane
   * is pinned to index 0). When constructed without an owner (test setup),
   * logs a warn and no-ops.
   */
  moveTo(newIndex: number): void {
    if (this.destroyed) {
      return;
    }
    if (this.paneOwner === null) {
      this.logger?.warn(
        `[carta] pane.moveTo: pane '${String(this.id)}' has no chart owner; ignored`,
      );
      return;
    }
    this.paneOwner.movePaneTo(this, newIndex);
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
    // Phase 14 Cycle B — bounded mode with `pad` widens the rendered
    // domain by `pad · (max - min)` on both sides so the data doesn't
    // sit flush against the pane frame. Applied as an effective domain
    // expansion (NOT via the existing `margins` field which uses
    // headroom-additive semantics that would compound with `pad`).
    let effectiveMin = slot.lastRenderedDomain.min;
    let effectiveMax = slot.lastRenderedDomain.max;
    if (slot.mode.kind === "bounded") {
      const pad = sanitizePad(slot.mode.pad, this.logger);
      if (pad > 0) {
        const span = slot.mode.max - slot.mode.min;
        const widen = span * pad;
        effectiveMin = asPrice(Math.min(Number(effectiveMin), slot.mode.min - widen));
        effectiveMax = asPrice(Math.max(Number(effectiveMax), slot.mode.max + widen));
      }
    }
    return new PriceScale({
      domainMin: effectiveMin,
      domainMax: effectiveMax,
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
    // Phase 14 Cycle B fix-up F-1 — bounded slots emit a tick envelope so
    // the axis labels include the boundary values (e.g. 0 and 100 for
    // RSI). Without this, small-pane viewports collapse to a single
    // boundary-misaligned tick.
    const rightSlot = this.slots.get("right");
    const tickEnvelope =
      rightSlot?.mode.kind === "bounded"
        ? { min: rightSlot.mode.min, max: rightSlot.mode.max }
        : null;
    this.priceAxis.render(
      scale,
      { x: 0, y: 0, w: this.rect.w, h: this.rect.h },
      theme,
      effective,
      logger,
      tickEnvelope,
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

/**
 * Phase 14 Cycle B — validate + freeze a `PriceScaleMode` patch. Returns
 * `null` on invalid input (caller treats as no-op). Bounded mode requires
 * finite `min < max`; equal/inverted bounds are rejected with `logger.warn`.
 */
export function sanitizePriceScaleMode(
  mode: PriceScaleMode,
  logger: Logger | null,
): PriceScaleMode | null {
  if (mode.kind === "auto") {
    return Object.freeze({ kind: "auto" });
  }
  if (mode.kind === "manual") {
    const { min, max } = mode;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      logger?.warn(
        `[carta] PriceScaleMode 'manual' requires finite min <= max; got [${String(mode.min)}, ${String(mode.max)}]`,
      );
      return null;
    }
    return Object.freeze({ kind: "manual", min, max });
  }
  // bounded
  const { min, max } = mode;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    logger?.warn(
      `[carta] PriceScaleMode 'bounded' requires finite min < max; got [${String(mode.min)}, ${String(mode.max)}]`,
    );
    return null;
  }
  const pad = mode.pad === undefined ? 0 : sanitizePad(mode.pad, logger);
  return Object.freeze({ kind: "bounded", min, max, pad });
}

/**
 * Phase 14 Cycle B — clamp `pad` to `[0, 1]`. Negative or non-finite values
 * warn and resolve to 0; values >= 1 clamp to 1.
 */
function sanitizePad(pad: number | undefined, logger: Logger | null): number {
  if (pad === undefined) {
    return 0;
  }
  const n = pad;
  if (!Number.isFinite(n)) {
    logger?.warn(
      `[carta] bounded scale: non-finite pad (${String(pad)}) — treating as 0`,
    );
    return 0;
  }
  if (n < 0) {
    logger?.warn(
      `[carta] bounded scale: negative pad (${String(pad)}) — treating as 0`,
    );
    return 0;
  }
  if (n > 1) {
    return 1;
  }
  return n;
}

/**
 * Phase 14 Cycle B — intersect a `PriceDomain` with the bounded mode's
 * `[min, max]` interval. Used inside `reconcileEachScale` after autoscale
 * (or the manual `priceDomain`) is computed. Pad is NOT applied here —
 * the domain stays inside the mathematical bounds; padding is a renderer
 * concern that widens the visible space without the data leaving its bounds.
 */
function clampDomainToBounded(
  domain: PriceDomain,
  mode: { readonly kind: "bounded"; readonly min: number; readonly max: number },
): PriceDomain {
  const dMin = domain.min as number;
  const dMax = domain.max as number;
  const cMin = Math.max(mode.min, Math.min(dMin, mode.max));
  const cMax = Math.max(mode.min, Math.min(dMax, mode.max));
  if (cMin === dMin && cMax === dMax) {
    return domain;
  }
  return Object.freeze({ min: asPrice(cMin), max: asPrice(cMax) });
}
