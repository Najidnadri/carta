import {
  Container,
  Rectangle,
  type FederatedPointerEvent,
} from "pixi.js";
import { PRICE_AXIS_STRIP_WIDTH } from "./PriceAxis.js";
import type { PlotRect } from "../render/Renderer.js";
import { asPrice, type Price, type PriceDomain } from "../../types.js";

export const PRICE_AXIS_STRIP_HIT_LABEL = "priceAxisStripHit";

const DEFAULT_DOUBLE_TAP_WINDOW_MS = 300;
const DEFAULT_DOUBLE_TAP_RADIUS_PX = 6;
const FACTOR_MIN = 0.05;
const FACTOR_MAX = 20;

export interface PriceAxisDragOptions {
  readonly doubleTapWindowMs?: number;
  readonly doubleTapRadiusPx?: number;
}

interface ResolvedOptions {
  readonly doubleTapWindowMs: number;
  readonly doubleTapRadiusPx: number;
}

function resolveOptions(opts: PriceAxisDragOptions | undefined): ResolvedOptions {
  return {
    doubleTapWindowMs:
      opts?.doubleTapWindowMs !== undefined &&
      Number.isFinite(opts.doubleTapWindowMs) &&
      opts.doubleTapWindowMs > 0
        ? opts.doubleTapWindowMs
        : DEFAULT_DOUBLE_TAP_WINDOW_MS,
    doubleTapRadiusPx:
      opts?.doubleTapRadiusPx !== undefined &&
      Number.isFinite(opts.doubleTapRadiusPx) &&
      opts.doubleTapRadiusPx >= 0
        ? opts.doubleTapRadiusPx
        : DEFAULT_DOUBLE_TAP_RADIUS_PX,
  };
}

/**
 * Computes a new price domain from a pointerdown-snapshot domain and a cumulative
 * vertical drag delta. Drag-up (negative Δy) compresses around the center
 * (zoom in); drag-down (positive Δy) stretches (zoom out).
 *
 * Exponential sensitivity: `factor = exp(Δy / plotH)` clamped to [0.05, 20].
 * Returns the original domain unchanged on degenerate inputs so the controller
 * can simply ignore them.
 */
export function computeStretchedDomain(
  start: PriceDomain,
  dyPx: number,
  plotH: number,
): PriceDomain {
  if (!Number.isFinite(dyPx) || !Number.isFinite(plotH) || plotH <= 0) {
    return start;
  }
  const sMin = Number(start.min);
  const sMax = Number(start.max);
  if (!Number.isFinite(sMin) || !Number.isFinite(sMax) || sMin > sMax) {
    return start;
  }
  const center = (sMin + sMax) / 2;
  const halfRange = (sMax - sMin) / 2;
  const rawFactor = Math.exp(dyPx / plotH);
  const factor = Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, rawFactor));
  const newHalf = halfRange * factor;
  return Object.freeze({
    min: asPrice(center - newHalf),
    max: asPrice(center + newHalf),
  });
}

export function recognizeDoubleTap(
  lastTapT: number | null,
  lastTapY: number | null,
  nowT: number,
  nowY: number,
  opts: ResolvedOptions,
): boolean {
  if (lastTapT === null || lastTapY === null) {
    return false;
  }
  if (!Number.isFinite(nowT) || !Number.isFinite(nowY)) {
    return false;
  }
  if (nowT - lastTapT > opts.doubleTapWindowMs || nowT - lastTapT < 0) {
    return false;
  }
  if (Math.abs(nowY - lastTapY) > opts.doubleTapRadiusPx) {
    return false;
  }
  return true;
}

export interface PriceAxisControllerDeps {
  readonly axesLayer: Container;
  readonly plotRect: () => PlotRect;
  readonly getRenderedDomain: () => PriceDomain;
  readonly setManualDomain: (min: Price, max: Price) => void;
  readonly setAutoScale: (on: boolean) => void;
  readonly onGestureStart?: (() => void) | undefined;
  readonly options?: PriceAxisDragOptions | undefined;
  readonly nowFn?: (() => number) | undefined;
}

interface DragState {
  readonly pointerId: number;
  readonly startY: number;
  readonly startDomain: PriceDomain;
}

/**
 * Owns pointer handling for the right-side price-axis strip. Vertical drag
 * stretches the price range around its center (TradingView convention: drag up
 * compresses, drag down stretches). Double-tap flips `autoScale=true`.
 *
 * Implementation notes:
 * - A child `Container` parented to `axesLayer` owns the rectangular hit-area
 *   `[plotW, 0, stripW, plotH]`. `eventMode = 'static'` so Pixi dispatches
 *   `pointerdown` to it before the stage-level `ViewportController` sees it.
 * - `stopPropagation()` on pointerdown ensures the plot's pan gesture doesn't
 *   start when the user clicks the strip.
 * - `globalpointermove` + `pointerupoutside` on stage track drag past the
 *   strip edges (mirrors `ViewportController` idiom).
 */
export class PriceAxisController {
  private readonly axesLayer: Container;
  private readonly plotRect: () => PlotRect;
  private readonly getRenderedDomain: () => PriceDomain;
  private readonly setManualDomain: (min: Price, max: Price) => void;
  private readonly setAutoScale: (on: boolean) => void;
  private readonly onGestureStart: (() => void) | undefined;
  private readonly options: ResolvedOptions;
  private readonly now: () => number;

  private readonly hit = new Container({ label: PRICE_AXIS_STRIP_HIT_LABEL });
  private drag: DragState | null = null;
  private lastTapT: number | null = null;
  private lastTapY: number | null = null;
  private disposed = false;

  constructor(deps: PriceAxisControllerDeps) {
    this.axesLayer = deps.axesLayer;
    this.plotRect = deps.plotRect;
    this.getRenderedDomain = deps.getRenderedDomain;
    this.setManualDomain = deps.setManualDomain;
    this.setAutoScale = deps.setAutoScale;
    this.onGestureStart = deps.onGestureStart;
    this.options = resolveOptions(deps.options);
    this.now = deps.nowFn ?? ((): number => performance.now());

    this.hit.eventMode = "static";
    this.hit.cursor = "ns-resize";
    this.syncHitArea();
    this.axesLayer.addChild(this.hit);

    this.hit.on("pointerdown", this.onPointerDown);
  }

  /** Refresh hit-rect after a resize. Caller passes the current plot rect. */
  syncHitArea(): void {
    if (this.disposed) {
      return;
    }
    const rect = this.plotRect();
    const w = Math.max(0, PRICE_AXIS_STRIP_WIDTH);
    const h = Math.max(0, rect.h);
    this.hit.hitArea = new Rectangle(rect.x + rect.w, rect.y, w, h);
  }

  destroy(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detachStageListeners();
    this.hit.off("pointerdown", this.onPointerDown);
    if (this.hit.parent !== null) {
      this.hit.parent.removeChild(this.hit);
    }
    this.hit.destroy();
    this.drag = null;
  }

  private readonly onPointerDown = (e: FederatedPointerEvent): void => {
    if (this.disposed) {
      return;
    }
    e.stopPropagation();

    const nowT = this.now();
    const nowY = e.global.y;
    if (recognizeDoubleTap(this.lastTapT, this.lastTapY, nowT, nowY, this.options)) {
      this.lastTapT = null;
      this.lastTapY = null;
      this.setAutoScale(true);
      return;
    }
    this.lastTapT = nowT;
    this.lastTapY = nowY;

    this.onGestureStart?.();

    const snapshot = this.getRenderedDomain();
    this.setAutoScale(false);
    this.drag = {
      pointerId: e.pointerId,
      startY: nowY,
      startDomain: snapshot,
    };

    const stage = this.stageOrNull();
    if (stage === null) {
      return;
    }
    stage.on("globalpointermove", this.onPointerMove);
    stage.on("pointerup", this.onPointerEnd);
    stage.on("pointerupoutside", this.onPointerEnd);
    stage.on("pointercancel", this.onPointerEnd);
  };

  private readonly onPointerMove = (e: FederatedPointerEvent): void => {
    if (this.disposed || this.drag === null) {
      return;
    }
    if (e.pointerId !== this.drag.pointerId) {
      return;
    }
    const dy = e.global.y - this.drag.startY;
    const plot = this.plotRect();
    const next = computeStretchedDomain(this.drag.startDomain, dy, plot.h);
    this.setManualDomain(next.min, next.max);
  };

  private readonly onPointerEnd = (e: FederatedPointerEvent): void => {
    if (this.disposed) {
      return;
    }
    if (this.drag !== null && e.pointerId !== this.drag.pointerId) {
      return;
    }
    this.drag = null;
    this.detachStageListeners();
  };

  private detachStageListeners(): void {
    const stage = this.stageOrNull();
    if (stage === null) {
      return;
    }
    stage.off("globalpointermove", this.onPointerMove);
    stage.off("pointerup", this.onPointerEnd);
    stage.off("pointerupoutside", this.onPointerEnd);
    stage.off("pointercancel", this.onPointerEnd);
  }

  private stageOrNull(): Container | null {
    let cursor: Container = this.axesLayer;
    while (cursor.parent !== null) {
      cursor = cursor.parent;
    }
    return cursor;
  }
}
