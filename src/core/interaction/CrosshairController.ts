import {
  BitmapText,
  Container,
  Graphics,
  type FederatedPointerEvent,
} from "pixi.js";
import type { DataStore } from "../data/DataStore.js";
import { MAIN_PANE_ID, type PaneId } from "../drawings/types.js";
import type { EventBus } from "../infra/EventBus.js";
import type { PaneRect } from "../pane/types.js";
import type { PlotRect } from "../render/Renderer.js";
import type { PriceScale } from "../price/PriceScale.js";
import type { Series } from "../series/Series.js";
import type { TimeScale } from "../time/TimeScale.js";
import { formatAxisLabel } from "../time/timeFormat.js";
import {
  asPixel,
  asPrice,
  asTime,
  type CartaEventMap,
  type CrosshairInfo,
  type CrosshairSeriesKey,
  type DataRecord,
  type Logger,
  type PriceFormatter,
  type Theme,
  type Time,
} from "../../types.js";

/** Pixel padding inside tag backgrounds. */
const TAG_PADDING_X = 6;
const TAG_PADDING_Y = 3;
const TAG_CORNER_RADIUS = 3;
/** Bootstrap font used until the first redraw threads a theme through. */
const BOOTSTRAP_FONT_FAMILY = "Arial";
const BOOTSTRAP_FONT_SIZE_PX = 11;
/** A string wide enough to pre-seed the BitmapText atlas on construction. */
const ATLAS_SEED = "0123456789-:., ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export interface CrosshairRenderContext {
  readonly plotRect: PlotRect;
  readonly timeScale: TimeScale;
  readonly priceScale: PriceScale;
  readonly theme: Theme;
  readonly dataStore: DataStore;
  readonly series: readonly Series[];
  readonly intervalDuration: number;
  readonly priceFormatter: PriceFormatter;
  /**
   * Phase 09 — when `true`, an out-of-plot pointer (e.g. finger drifted over
   * the price-axis strip) clamps to the plot edges instead of hiding the
   * crosshair. The persistent "tracking-mode" crosshair stays glued to a
   * real bar regardless of finger position.
   */
  readonly inTrackingMode?: boolean;
  /**
   * Phase 14 Cycle A — top-to-bottom list of pane rects. Single-pane
   * charts pass `[{id: MAIN_PANE_ID, rect: plotRect}]`; multi-pane charts
   * pass one entry per pane. Used to compute active-pane membership for
   * the `paneId` payload + per-pane price-tag positioning.
   */
  readonly paneRects?: readonly { readonly id: PaneId; readonly rect: PaneRect }[];
  /**
   * Phase 14 Cycle A — per-pane price scales for tag price readouts. Keyed
   * by `PaneId`. When omitted (legacy callers), every pane reads from the
   * single `priceScale` field above.
   */
  readonly priceScalesByPane?: ReadonlyMap<PaneId, PriceScale>;
}

export interface CrosshairControllerDeps {
  readonly stage: Container;
  readonly canvas: HTMLCanvasElement;
  readonly linesLayer: Container;
  readonly tagsLayer: Container;
  readonly eventBus: EventBus<CartaEventMap>;
  readonly logger: Logger;
  /** Schedule a crosshair redraw on next RAF. */
  readonly invalidate: () => void;
}

interface PendingState {
  readonly kind: "move" | "leave";
  readonly localX: number;
  readonly localY: number;
}

interface Tag {
  readonly container: Container;
  readonly bg: Graphics;
  readonly text: BitmapText;
  lastText: string;
  lastWidth: number;
  lastHeight: number;
  lastBgColor: number;
}

/**
 * Owns the crosshair feature end-to-end: pointer listeners, hair-line + tag
 * rendering, and `crosshair:move` emission. Mouse/pen only — touch is phase 09.
 *
 * Flow per pointer event:
 * 1. `globalpointermove` handler filters non-mouse/pen pointers, converts the
 *    event to plot-local coords, stores `pendingState`, and calls `invalidate()`.
 * 2. `TimeSeriesChart.flush` sees the `'crosshair'` dirty reason, either alone
 *    (fast path) or alongside viewport/data, and calls `redraw(ctx)`.
 * 3. `redraw` snaps the pointer X to a bar centre (magnet-X), redraws the hair
 *    lines + axis tags, and emits exactly one `crosshair:move` event.
 *
 * `crosshair:move` always has a stable shape — on leave, `time` and `price`
 * are `null` and `seriesData` is empty, but `point` still reflects the last
 * known pixel coords.
 */
export class CrosshairController {
  private readonly deps: CrosshairControllerDeps;
  private readonly vertLine: Graphics;
  private readonly horzLine: Graphics;
  private readonly priceTag: Tag;
  /**
   * Phase 14 Cycle A — extra price tags for non-primary panes. Lazy-allocated
   * on first render of each pane; released by `releasePaneTag(id)` when a
   * pane is removed.
   */
  private readonly extraPriceTags = new Map<PaneId, Tag>();
  private readonly timeTag: Tag;
  private readonly attachedListeners: (() => void)[] = [];

  private pending: PendingState | null = null;
  private bgRedrawCount = 0;
  private emitCount = 0;
  private atlasSeedCount = 0;
  private lastFontFamily = BOOTSTRAP_FONT_FAMILY;
  private lastFontSize = BOOTSTRAP_FONT_SIZE_PX;
  private disposed = false;

  constructor(deps: CrosshairControllerDeps) {
    this.deps = deps;

    this.vertLine = new Graphics();
    this.vertLine.visible = false;
    this.horzLine = new Graphics();
    this.horzLine.visible = false;
    deps.linesLayer.addChild(this.vertLine);
    deps.linesLayer.addChild(this.horzLine);

    this.priceTag = this.createTag("priceTag");
    this.timeTag = this.createTag("timeTag");
    deps.tagsLayer.addChild(this.priceTag.container);
    deps.tagsLayer.addChild(this.timeTag.container);

    // Seed BitmapText atlases so the first live move doesn't pay a one-shot
    // glyph-generation hitch (observed ~200ms on SwiftShader in phase 07).
    this.priceTag.text.text = ATLAS_SEED;
    this.timeTag.text.text = ATLAS_SEED;
    this.priceTag.text.text = "";
    this.timeTag.text.text = "";

    this.attachListeners();
  }

  /**
   * Called from `TimeSeriesChart.flush` when `'crosshair'` is in the dirty
   * set. Redraws hair lines + tags based on the current pending state and
   * emits exactly one `crosshair:move` event for this frame.
   */
  redraw(ctx: CrosshairRenderContext): void {
    if (this.disposed) {
      return;
    }
    // Phase 10 — propagate the theme's typography to the BitmapText pool. A
    // font change re-seeds the atlas so the first post-swap draw doesn't pay
    // a one-shot glyph-generation hitch.
    this.applyFontIfChanged(ctx.theme.fontFamily, ctx.theme.fontSize);
    const pending = this.pending;
    if (pending === null) {
      // Idle — no pointer interaction has occurred. Stay hidden; do not emit.
      return;
    }
    if (pending.kind === "leave") {
      this.hideVisuals();
      this.emitLeave(pending, ctx);
      return;
    }
    this.drawActive(pending, ctx);
  }

  /**
   * Phase 10 — when the theme's `fontFamily` / `fontSize` change, mutate both
   * tag text styles in place and re-run the atlas seed against the new family
   * so the first post-swap pointer move doesn't stall on glyph generation.
   */
  private applyFontIfChanged(fontFamily: string, fontSize: number): void {
    if (fontFamily === this.lastFontFamily && fontSize === this.lastFontSize) {
      return;
    }
    this.priceTag.text.style.fontFamily = fontFamily;
    this.priceTag.text.style.fontSize = fontSize;
    this.timeTag.text.style.fontFamily = fontFamily;
    this.timeTag.text.style.fontSize = fontSize;
    // Re-seed the atlas under the new style. Setting `.text` on a BitmapText
    // with a new fontFamily forces Pixi v8 to lazily generate glyphs for the
    // seeded characters; clearing back to "" keeps the tag invisible until
    // the next move.
    this.priceTag.text.text = ATLAS_SEED;
    this.timeTag.text.text = ATLAS_SEED;
    this.priceTag.text.text = "";
    this.timeTag.text.text = "";
    this.priceTag.lastText = "";
    this.timeTag.lastText = "";
    this.priceTag.lastWidth = 0;
    this.priceTag.lastHeight = 0;
    this.timeTag.lastWidth = 0;
    this.timeTag.lastHeight = 0;
    this.lastFontFamily = fontFamily;
    this.lastFontSize = fontSize;
    this.atlasSeedCount += 1;
  }

  /**
   * Introspection hook for unit + Playwright tests. Counts the number of
   * times a tag background was rebuilt (width changed). Should stay flat
   * once the tag text width stabilises.
   */
  getBgRedrawCount(): number {
    return this.bgRedrawCount;
  }

  /** Introspection hook: total `crosshair:move` emissions since construction. */
  getEmitCount(): number {
    return this.emitCount;
  }

  /**
   * Phase 10 introspection: how many times the BitmapText atlas has been
   * re-seeded due to a theme `fontFamily` / `fontSize` change. Stays at `0`
   * across same-font theme swaps; bumps once per font transition.
   */
  getAtlasSeedCount(): number {
    return this.atlasSeedCount;
  }

  /** Introspection: is the crosshair currently visible? */
  isVisible(): boolean {
    return this.vertLine.visible;
  }

  /**
   * Phase 09 — drives the crosshair from a touch pointer that bypasses the
   * `globalpointermove` mouse/pen filter. Coordinates are in stage-root
   * pixels (i.e. canvas-global, the same space as `e.global` in pointer
   * events). Used by `TimeSeriesChart` while in tracking mode.
   */
  setTrackingMove(globalX: number, globalY: number): void {
    if (this.disposed) {
      return;
    }
    this.pending = { kind: "move", localX: globalX, localY: globalY };
    this.deps.invalidate();
  }

  /**
   * Phase 09 — public exit hook. Hides the hair lines + tags immediately and
   * clears any pending state so the next flush is a no-op. Used by
   * `TimeSeriesChart.exitTrackingInternal`.
   */
  hide(): void {
    if (this.disposed) {
      return;
    }
    this.pending = null;
    this.hideVisuals();
  }

  destroy(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const off of this.attachedListeners) {
      off();
    }
    this.attachedListeners.length = 0;
    this.pending = null;
    // Children are owned by `linesLayer` / `tagsLayer`, which are owned by
    // `Renderer`. Remove + destroy our own nodes so renderer.destroy() isn't
    // double-destroying.
    this.vertLine.parent?.removeChild(this.vertLine);
    this.vertLine.destroy();
    this.horzLine.parent?.removeChild(this.horzLine);
    this.horzLine.destroy();
    this.priceTag.container.parent?.removeChild(this.priceTag.container);
    this.priceTag.container.destroy({ children: true });
    this.timeTag.container.parent?.removeChild(this.timeTag.container);
    this.timeTag.container.destroy({ children: true });
    for (const tag of this.extraPriceTags.values()) {
      tag.container.parent?.removeChild(tag.container);
      tag.container.destroy({ children: true });
    }
    this.extraPriceTags.clear();
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private createTag(label: string): Tag {
    const container = new Container({ label, eventMode: "none" });
    const bg = new Graphics();
    const text = new BitmapText({
      text: "",
      style: {
        fontFamily: BOOTSTRAP_FONT_FAMILY,
        fontSize: BOOTSTRAP_FONT_SIZE_PX,
        fill: 0xffffff,
      },
    });
    text.position.set(TAG_PADDING_X, TAG_PADDING_Y);
    container.addChild(bg);
    container.addChild(text);
    container.visible = false;
    return { container, bg, text, lastText: "", lastWidth: 0, lastHeight: 0, lastBgColor: -1 };
  }

  private attachListeners(): void {
    const onMove = (e: FederatedPointerEvent): void => {
      if (this.disposed) {
        return;
      }
      const ptype = e.pointerType;
      if (ptype !== "mouse" && ptype !== "pen") {
        return;
      }
      // plotRect starts at (0, 0) today; using e.global is equivalent to a
      // `linesLayer.toLocal` call since the layer is at stage root. We'll
      // re-apply the plotRect offset in `redraw` so nothing breaks if the
      // plot is moved later.
      this.pending = {
        kind: "move",
        localX: e.global.x,
        localY: e.global.y,
      };
      this.deps.invalidate();
    };
    const onLeave = (): void => {
      if (this.disposed) {
        return;
      }
      const prev = this.pending;
      // If no move ever landed (e.g. touch-only interaction that we filtered
      // out, or the cursor never entered the plot), a leave is a no-op —
      // don't invalidate and don't emit a spurious null-payload event.
      if (prev === null || prev.kind === "leave") {
        return;
      }
      this.pending = {
        kind: "leave",
        localX: prev.localX,
        localY: prev.localY,
      };
      this.deps.invalidate();
    };

    this.deps.stage.on("globalpointermove", onMove);
    this.deps.canvas.addEventListener("pointerleave", onLeave);

    this.attachedListeners.push(() => {
      this.deps.stage.off("globalpointermove", onMove);
    });
    this.attachedListeners.push(() => {
      this.deps.canvas.removeEventListener("pointerleave", onLeave);
    });
  }

  private hideVisuals(): void {
    this.vertLine.visible = false;
    this.horzLine.visible = false;
    this.priceTag.container.visible = false;
    this.timeTag.container.visible = false;
    for (const tag of this.extraPriceTags.values()) {
      tag.container.visible = false;
    }
  }

  /**
   * Phase 14 Cycle A — destroy a pane's price tag when the pane is removed.
   * Called by `TimeSeriesChart.removePane`. Idempotent.
   */
  releasePaneTag(paneId: PaneId): void {
    const tag = this.extraPriceTags.get(paneId);
    if (tag === undefined) {
      return;
    }
    tag.container.destroy({ children: true });
    this.extraPriceTags.delete(paneId);
  }

  private getOrCreateExtraTag(paneId: PaneId): Tag {
    const existing = this.extraPriceTags.get(paneId);
    if (existing !== undefined) {
      return existing;
    }
    const tag = this.createTag(`priceTag:${String(paneId)}`);
    this.deps.tagsLayer.addChild(tag.container);
    this.extraPriceTags.set(paneId, tag);
    return tag;
  }

  private emitLeave(pending: PendingState, ctx: CrosshairRenderContext): void {
    const lastX = pending.localX;
    const lastY = pending.localY;
    const payload: CrosshairInfo = {
      time: null,
      price: null,
      point: {
        x: asPixel(lastX - ctx.plotRect.x),
        y: asPixel(lastY - ctx.plotRect.y),
      },
      seriesData: new Map<CrosshairSeriesKey, DataRecord | null>(),
      paneId: null,
    };
    this.emitCount += 1;
    this.deps.eventBus.emit("crosshair:move", payload);
    this.pending = null;
  }

  /**
   * Phase 14 Cycle A — find the pane whose rect contains the given canvas-Y
   * coordinate. Returns `null` when y lies outside every pane (time-axis
   * gutter, separator gap in cycle B, or off-canvas).
   */
  private activePaneAt(
    canvasY: number,
    paneRects: readonly { id: PaneId; rect: PaneRect }[] | undefined,
  ): { id: PaneId; rect: PaneRect } | null {
    if (paneRects === undefined || paneRects.length === 0) {
      return null;
    }
    for (const entry of paneRects) {
      const r = entry.rect;
      if (canvasY >= r.y && canvasY < r.y + r.h) {
        return entry;
      }
    }
    return null;
  }

  private drawActive(pending: PendingState, ctx: CrosshairRenderContext): void {
    const { plotRect, timeScale, theme } = ctx;
    const rawLocalX = pending.localX - plotRect.x;

    if (plotRect.w <= 0 || plotRect.h <= 0) {
      this.hideVisuals();
      this.emitLeave(pending, ctx);
      return;
    }

    // Phase 14 Cycle A — paneRects defaults to the single primary pane when
    // the chart hasn't supplied them (test helpers, legacy callers).
    const paneRects =
      ctx.paneRects && ctx.paneRects.length > 0
        ? ctx.paneRects
        : [{ id: MAIN_PANE_ID, rect: plotRect }];
    const stackTop = paneRects[0]?.rect.y ?? plotRect.y;
    const stackBottomEntry = paneRects[paneRects.length - 1];
    const stackBottom = (stackBottomEntry?.rect.y ?? plotRect.y) + (stackBottomEntry?.rect.h ?? plotRect.h);
    const inTracking = ctx.inTrackingMode === true;

    // Active pane: which rect contains the canvas-Y of the pointer? Tracking
    // mode falls back to the primary pane when the finger drifts off-stack.
    const canvasY = pending.localY;
    let activePane = this.activePaneAt(canvasY, paneRects);
    if (activePane === null && inTracking) {
      activePane = paneRects[0] ?? null;
    }

    const localX = inTracking
      ? Math.max(0, Math.min(plotRect.w, rawLocalX))
      : rawLocalX;
    const outsideX = !inTracking && (rawLocalX < 0 || rawLocalX > plotRect.w);
    if (outsideX || activePane === null) {
      this.hideVisuals();
      this.emitLeave(pending, ctx);
      return;
    }

    const snap = timeScale.snapToBarPixel(localX, plotRect.w);
    if (snap === null) {
      this.hideVisuals();
      this.emitLeave(pending, ctx);
      return;
    }

    const effectiveTime = this.clampSnappedTimeToDataRange(snap.time, ctx);
    const snappedTime = effectiveTime;
    const snappedX = Number(timeScale.timeToPixel(effectiveTime));

    // Active pane's local Y inside its own rect.
    const activeRect = activePane.rect;
    const activeLocalY = inTracking
      ? Math.max(0, Math.min(activeRect.h, canvasY - activeRect.y))
      : canvasY - activeRect.y;

    // Vertical hair line: spans the full pane stack.
    this.vertLine.visible = true;
    this.vertLine
      .clear()
      .moveTo(plotRect.x + snappedX, stackTop)
      .lineTo(plotRect.x + snappedX, stackBottom)
      .stroke({ color: theme.crosshairLine, width: 1, pixelLine: true });

    // Horizontal hair line: drawn inside the active pane only.
    this.horzLine.visible = true;
    this.horzLine
      .clear()
      .moveTo(plotRect.x, activeRect.y + activeLocalY)
      .lineTo(plotRect.x + activeRect.w, activeRect.y + activeLocalY)
      .stroke({ color: theme.crosshairLine, width: 1, pixelLine: true });

    // Time tag at the bottom of the pane stack.
    const timeLabel = this.formatTime(snappedTime, ctx.intervalDuration);
    this.updateTag(
      this.timeTag,
      timeLabel,
      plotRect.x + snappedX,
      stackBottom,
      theme,
      "centerX-topY",
    );

    // Per-pane price tags. Each pane reads its own scale; the active pane's
    // tag follows the cursor's local Y, all other panes' tags hide.
    const priceScalesByPane = ctx.priceScalesByPane;
    const activePriceScale =
      priceScalesByPane?.get(activePane.id) ?? ctx.priceScale;
    const rawPrice = Number(activePriceScale.pixelToValue(asPixel(activeLocalY)));
    const finitePrice = Number.isFinite(rawPrice) ? rawPrice : null;

    // Update the primary pane's bound `priceTag` if it IS the active one;
    // otherwise hide it and show the appropriate extra tag.
    if (activePane.id === MAIN_PANE_ID) {
      const priceLabel = finitePrice !== null ? this.formatPrice(finitePrice, ctx.priceFormatter) : "—";
      this.updateTag(
        this.priceTag,
        priceLabel,
        plotRect.x + activeRect.w,
        activeRect.y + activeLocalY,
        theme,
        "leftX-centerY",
      );
      // Hide non-primary tags.
      for (const tag of this.extraPriceTags.values()) {
        tag.container.visible = false;
      }
    } else {
      this.priceTag.container.visible = false;
      // Hide every extra tag first, then show the active one.
      for (const tag of this.extraPriceTags.values()) {
        tag.container.visible = false;
      }
      const tag = this.getOrCreateExtraTag(activePane.id);
      const priceLabel = finitePrice !== null ? this.formatPrice(finitePrice, ctx.priceFormatter) : "—";
      this.updateTag(
        tag,
        priceLabel,
        plotRect.x + activeRect.w,
        activeRect.y + activeLocalY,
        theme,
        "leftX-centerY",
      );
    }

    // Collect seriesData.
    const seriesData = this.collectSeriesData(
      ctx.series,
      ctx.dataStore,
      ctx.intervalDuration,
      snappedTime,
    );

    const payload: CrosshairInfo = {
      time: snappedTime,
      price: finitePrice === null ? null : asPrice(finitePrice),
      point: { x: asPixel(localX), y: asPixel(activeLocalY) },
      seriesData,
      paneId: activePane.id,
    };
    this.emitCount += 1;
    this.deps.eventBus.emit("crosshair:move", payload);
  }

  private updateTag(
    tag: Tag,
    label: string,
    anchorX: number,
    anchorY: number,
    theme: Theme,
    mode: "centerX-topY" | "leftX-centerY",
  ): void {
    if (tag.text.text !== label) {
      tag.text.text = label;
    }
    const textW = Math.ceil(tag.text.width);
    const textH = Math.ceil(tag.text.height);
    const boxW = textW + TAG_PADDING_X * 2;
    const boxH = textH + TAG_PADDING_Y * 2;

    // Phase 10 — also refill on bg color change so a theme swap repaints the
    // rounded-rect even when boxW/boxH didn't change. Without this trigger,
    // the crosshair tag bg stays at its previous theme's color until the next
    // dimension change.
    if (
      boxW !== tag.lastWidth ||
      boxH !== tag.lastHeight ||
      tag.lastText === "" ||
      tag.lastBgColor !== theme.crosshairTagBg
    ) {
      tag.bg
        .clear()
        .roundRect(0, 0, boxW, boxH, TAG_CORNER_RADIUS)
        .fill(theme.crosshairTagBg);
      tag.lastWidth = boxW;
      tag.lastHeight = boxH;
      tag.lastBgColor = theme.crosshairTagBg;
      this.bgRedrawCount += 1;
    }
    tag.lastText = label;
    tag.text.tint = theme.crosshairTagText;

    if (mode === "centerX-topY") {
      tag.container.position.set(Math.round(anchorX - boxW / 2), Math.round(anchorY));
    } else {
      tag.container.position.set(Math.round(anchorX), Math.round(anchorY - boxH / 2));
    }
    tag.container.visible = true;
  }

  private formatTime(t: Time, intervalDuration: number): string {
    // Use the axis formatter with `isDayBoundary = false` so we get intraday
    // precision at an intraday interval, and date-granularity at >= 1d.
    // Pick a step at-or-below the interval so the label has the needed tier.
    const step = intervalDuration > 0 ? intervalDuration : 60_000;
    try {
      return formatAxisLabel(t, step, false);
    } catch {
      return "";
    }
  }

  private formatPrice(price: number, formatter: PriceFormatter): string {
    try {
      return formatter(price);
    } catch {
      return "";
    }
  }

  /**
   * Clamp a raw slot-snapped `Time` to the window-scoped data range across
   * every series in `ctx.series`. When the cursor lands past the latest data
   * bar in the visible window, returns that latest time; symmetric for the
   * earliest. When no series has any cached data in the window, returns
   * `raw` unchanged — preserves cycle A behavior for fresh/empty charts.
   */
  private clampSnappedTimeToDataRange(
    raw: Time,
    ctx: CrosshairRenderContext,
  ): Time {
    const winStart = Number(ctx.timeScale.startTime);
    const winEnd = Number(ctx.timeScale.endTime);
    if (!Number.isFinite(winStart) || !Number.isFinite(winEnd) || winStart > winEnd) {
      return raw;
    }
    let minT = Number.POSITIVE_INFINITY;
    let maxT = Number.NEGATIVE_INFINITY;
    for (const s of ctx.series) {
      // Markers are annotations on a sparse time grid — including them in
      // the clamp union would pin the hair to marker times even when the
      // primary price series has nothing in the window. Skip them.
      if (s.kind === "marker") {
        continue;
      }
      const first = ctx.dataStore.earliestTimeInWindow(
        s.channel,
        ctx.intervalDuration,
        winStart,
        winEnd,
      );
      const last = ctx.dataStore.latestTimeInWindow(
        s.channel,
        ctx.intervalDuration,
        winStart,
        winEnd,
      );
      if (first !== null && first < minT) {
        minT = first;
      }
      if (last !== null && last > maxT) {
        maxT = last;
      }
    }
    if (minT === Number.POSITIVE_INFINITY || maxT === Number.NEGATIVE_INFINITY) {
      return raw;
    }
    const t = Number(raw);
    if (t > maxT) {
      return asTime(maxT);
    }
    if (t < minT) {
      return asTime(minT);
    }
    return raw;
  }

  private collectSeriesData(
    series: readonly Series[],
    dataStore: DataStore,
    intervalDuration: number,
    time: Time,
  ): ReadonlyMap<CrosshairSeriesKey, DataRecord | null> {
    const map = new Map<CrosshairSeriesKey, DataRecord | null>();
    for (const s of series) {
      const key = s as unknown as CrosshairSeriesKey;
      const rec = dataStore.getBar(s.channel, intervalDuration, Number(time));
      map.set(key, rec ?? null);
    }
    return map;
  }
}

