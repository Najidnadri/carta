import {
  BitmapText,
  Container,
  Graphics,
  type FederatedPointerEvent,
} from "pixi.js";
import type { DataStore } from "./DataStore.js";
import type { EventBus } from "./EventBus.js";
import type { PlotRect } from "./Renderer.js";
import type { PriceScale } from "./PriceScale.js";
import type { Series } from "./Series.js";
import type { TimeScale } from "./TimeScale.js";
import { formatAxisLabel } from "./timeFormat.js";
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
} from "../types.js";

/** Pixel padding inside tag backgrounds. */
const TAG_PADDING_X = 6;
const TAG_PADDING_Y = 3;
const TAG_CORNER_RADIUS = 3;
const TAG_FONT_FAMILY = "Arial";
const TAG_FONT_SIZE_PX = 11;
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
  private readonly timeTag: Tag;
  private readonly attachedListeners: (() => void)[] = [];

  private pending: PendingState | null = null;
  private bgRedrawCount = 0;
  private emitCount = 0;
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
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private createTag(label: string): Tag {
    const container = new Container({ label, eventMode: "none" });
    const bg = new Graphics();
    const text = new BitmapText({
      text: "",
      style: {
        fontFamily: TAG_FONT_FAMILY,
        fontSize: TAG_FONT_SIZE_PX,
        fill: 0xffffff,
      },
    });
    text.position.set(TAG_PADDING_X, TAG_PADDING_Y);
    container.addChild(bg);
    container.addChild(text);
    container.visible = false;
    return { container, bg, text, lastText: "", lastWidth: 0, lastHeight: 0 };
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
    };
    this.emitCount += 1;
    this.deps.eventBus.emit("crosshair:move", payload);
    this.pending = null;
  }

  private drawActive(pending: PendingState, ctx: CrosshairRenderContext): void {
    const { plotRect, timeScale, priceScale, theme } = ctx;
    const rawLocalX = pending.localX - plotRect.x;
    const rawLocalY = pending.localY - plotRect.y;

    // Phase 09 — in tracking mode the persistent crosshair must not flicker
    // off when the finger drifts over the price-axis strip or the time-axis
    // gutter. Clamp to plot bounds and continue drawing at the clamped point.
    if (plotRect.w <= 0 || plotRect.h <= 0) {
      this.hideVisuals();
      this.emitLeave(pending, ctx);
      return;
    }
    const inTracking = ctx.inTrackingMode === true;
    const localX = inTracking
      ? Math.max(0, Math.min(plotRect.w, rawLocalX))
      : rawLocalX;
    const localY = inTracking
      ? Math.max(0, Math.min(plotRect.h, rawLocalY))
      : rawLocalY;

    const outside =
      !inTracking &&
      (rawLocalX < 0 || rawLocalX > plotRect.w || rawLocalY < 0 || rawLocalY > plotRect.h);

    if (outside) {
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

    // Cycle B — clamp the raw slot snap to the visible-window data range so
    // the hair sticks to the last/first data bar when the cursor drifts into
    // an empty future-or-past gutter. No-op when the cursor is already inside
    // the data range or when no non-marker series in this window has any data.
    const effectiveTime = this.clampSnappedTimeToDataRange(snap.time, ctx);
    const snappedTime = effectiveTime;
    // Single source of truth for the hair's pixel X. Using `timeToPixel`
    // regardless of whether the clamp kicked in avoids a 1 px flicker at the
    // boundary when `snap.x` (possibly integer-rounded) disagrees with a
    // fresh `timeToPixel(effectiveTime)` by a sub-pixel.
    const snappedX = Number(timeScale.timeToPixel(effectiveTime));
    const rawPrice = Number(priceScale.pixelToValue(asPixel(localY)));
    const finitePrice = Number.isFinite(rawPrice) ? rawPrice : null;

    // Hair lines (stage-root container; draw using plotRect-global coords).
    this.vertLine.visible = true;
    this.vertLine
      .clear()
      .moveTo(plotRect.x + snappedX, plotRect.y)
      .lineTo(plotRect.x + snappedX, plotRect.y + plotRect.h)
      .stroke({ color: theme.crosshairLine, width: 1, pixelLine: true });

    this.horzLine.visible = true;
    this.horzLine
      .clear()
      .moveTo(plotRect.x, plotRect.y + localY)
      .lineTo(plotRect.x + plotRect.w, plotRect.y + localY)
      .stroke({ color: theme.crosshairLine, width: 1, pixelLine: true });

    // Tags.
    const timeLabel = this.formatTime(snappedTime, ctx.intervalDuration);
    this.updateTag(
      this.timeTag,
      timeLabel,
      plotRect.x + snappedX,
      plotRect.y + plotRect.h,
      theme,
      "centerX-topY",
    );
    const priceLabel = finitePrice !== null ? this.formatPrice(finitePrice, ctx.priceFormatter) : "—";
    this.updateTag(
      this.priceTag,
      priceLabel,
      plotRect.x + plotRect.w,
      plotRect.y + localY,
      theme,
      "leftX-centerY",
    );

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
      point: { x: asPixel(localX), y: asPixel(localY) },
      seriesData,
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

    if (boxW !== tag.lastWidth || boxH !== tag.lastHeight || tag.lastText === "") {
      tag.bg
        .clear()
        .roundRect(0, 0, boxW, boxH, TAG_CORNER_RADIUS)
        .fill(theme.crosshairTagBg);
      tag.lastWidth = boxW;
      tag.lastHeight = boxH;
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

