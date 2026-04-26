/**
 * DrawingsController — owns the drawings model, the create/select/edit FSM,
 * the chart-level hit-tester wiring, the per-frame projection + render call,
 * and the public `chart.drawings` facade. Hand-shakes with `ViewportController`
 * via `onPointerDownIntercept` so drawings get first dibs on pointerdown
 * without modifying viewport pan internals.
 *
 * Render lifecycle (mirrors `Series` pattern):
 * - On `'drawings'` flush: `render(ctx)` is called by `TimeSeriesChart.flush`.
 * - We project all drawings, redraw their pooled `Graphics`, sync handle
 *   graphics for the selected drawing.
 *
 * Keyboard handler is canvas-scoped + focus-gated — selection-click calls
 * `canvas.focus()` so subsequent keydowns route here. Cleanup detaches every
 * listener in `destroy()`.
 */

import { Graphics, type Container, type FederatedPointerEvent } from "pixi.js";
import type { EventBus } from "../infra/EventBus.js";
import type { PlotRect, Renderer } from "../render/Renderer.js";
import type { PriceScale } from "../price/PriceScale.js";
import type { TimeScale } from "../time/TimeScale.js";
import {
  asPrice,
  asTime,
  type CartaEventMap,
  type Logger,
  type MagnetMode,
  type OhlcRecord,
  type PriceFormatter,
  type Theme,
} from "../../types.js";
import {
  asDrawingId,
  DEFAULT_FIB_LEVELS,
  MAIN_PANE_ID,
  type BeginCreateOptions,
  type DisplayMode,
  type Drawing,
  type DrawingAnchor,
  type DrawingId,
  type DrawingKind,
  type DrawingScope,
  type DrawingsSnapshot,
  type DrawingsStorageAdapter,
  type DrawingStyle,
  type FibLevel,
} from "./types.js";
import {
  clampLongPosition,
  clampShortPosition,
  computePositionStats,
  formatPositionLine,
  type PositionPrices,
} from "./positionInvariant.js";
import { DrawingTextPool, type DrawingTextSpec } from "./DrawingTextPool.js";
import { formatDuration } from "../time/timeFormat.js";
import type {
  LongPositionDrawing,
  ShortPositionDrawing,
} from "./types.js";
import { applyMagnet } from "./magnet.js";
import { FibLabelPool } from "./FibLabelPool.js";
import {
  defaultTolerancesFor,
  hitTestDrawings,
  type PointerKind,
} from "./hitTest.js";
import { projectDrawing, unprojectPoint, type ScreenGeom } from "./project.js";
import {
  HandleContextCache,
  handleSpecsFor,
  redrawDrawing,
  syncHandleGraphics,
  type HandleKey,
} from "./render.js";
import { parseSnapshot } from "./parsers.js";
import { StorageBinding } from "./storage.js";

const SOFT_DRAWING_LIMIT = 500;
const DRAG_THRESHOLD_PX = 6;

interface DraggingState {
  readonly id: DrawingId;
  readonly mode: "handle" | "body";
  readonly handleKey: HandleKey | null;
  readonly pointerId: number;
  readonly startAnchors: readonly DrawingAnchor[];
  readonly startGlobalX: number;
  readonly startGlobalY: number;
  readonly startTime: number;
  readonly startPrice: number;
  /** Position-only: snapshot of `endTime` at drag start so the time-end puller can be diffed. */
  readonly startEndTime: number | null;
  shiftConstrain: boolean;
  committed: boolean;
}

interface CreatingState {
  readonly kind: DrawingKind;
  readonly options: BeginCreateOptions;
  placedAnchors: DrawingAnchor[];
}

export interface DrawingsControllerDeps {
  readonly stage: Container;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: Renderer;
  readonly eventBus: EventBus<CartaEventMap>;
  readonly logger: Logger;
  readonly invalidate: () => void;
  readonly plotRect: () => PlotRect;
  readonly currentTimeScale: () => TimeScale;
  readonly currentPriceScale: () => PriceScale;
  readonly currentTheme: () => Theme;
  readonly currentDpr: () => number;
  /**
   * Phase 13 Cycle B1 — magnet snap. Reads `ConfigState.magnet`. When the
   * mode is non-off, drawing creation + handle drag snap anchor.time to the
   * nearest bar centre and anchor.price to nearest of `{H,L}` (weak) or
   * `{O,H,L,C}` (strong). Default returns `'off'`.
   */
  readonly currentMagnetMode?: () => MagnetMode;
  /**
   * Look up the OHLC bar at a given snapped time. Returns `null` when the
   * chart has no `ohlc` channel registered or the bar isn't cached.
   */
  readonly getOhlcAtTime?: (time: number) => OhlcRecord | null;
  /** Format function for fib level price labels; defaults to `(v) => v.toFixed(2)`. */
  readonly priceFormatter?: () => PriceFormatter;
  /** ID generator. Default = `crypto.randomUUID()` with a counter fallback. */
  readonly newId?: () => DrawingId;
  /** Test hooks. */
  readonly setTimeout?: (cb: () => void, ms: number) => number;
  readonly clearTimeout?: (id: number) => void;
}

export interface DrawingsRenderContext {
  readonly plotRect: PlotRect;
  readonly timeScale: TimeScale;
  readonly priceScale: PriceScale;
  readonly theme: Theme;
  readonly dpr: number;
}

let idCounter = 0;
function fallbackId(): DrawingId {
  idCounter += 1;
  return asDrawingId(`drw-${String(Date.now())}-${String(idCounter)}`);
}
function defaultNewId(): DrawingId {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) {
    return asDrawingId(c.randomUUID());
  }
  return fallbackId();
}

/**
 * Public facade exposed as `chart.drawings`. Hides the controller's internal
 * methods (FSM, hit-test plumbing, render lifecycle) so hosts only see the
 * imperative model API.
 */
export interface DrawingsFacade {
  beginCreate(kind: DrawingKind, options?: BeginCreateOptions): void;
  cancelCreate(): void;
  isCreating(): boolean;
  list(): readonly Drawing[];
  getById(id: DrawingId | string): Drawing | null;
  add(drawing: Drawing): void;
  update<K extends Drawing>(id: DrawingId | string, patch: Partial<Omit<K, "id" | "kind" | "schemaVersion">>): boolean;
  remove(id: DrawingId | string): boolean;
  clear(): void;
  getSelectedId(): DrawingId | null;
  select(id: DrawingId | string | null): void;
  getSnapshot(): DrawingsSnapshot;
  loadSnapshot(snapshot: unknown): { droppedCount: number; droppedKinds: readonly string[] };
  attachStorage(adapter: DrawingsStorageAdapter, scope: DrawingScope): void;
  detachStorage(): void;
}

export class DrawingsController {
  private readonly deps: DrawingsControllerDeps;
  private readonly drawings = new Map<DrawingId, Drawing>();
  private readonly graphicsByDrawing = new Map<DrawingId, Graphics>();
  private readonly fibLabelPools = new Map<DrawingId, FibLabelPool>();
  private readonly handleGraphicsPool: Graphics[] = [];
  private readonly handleCache = new HandleContextCache();
  private readonly handlesContainer: Container;
  private readonly handleHitParent: { addChild: (g: Graphics) => Graphics };
  private warnedMissingOhlcChannel = false;

  private readonly storage: StorageBinding;

  private selectedId: DrawingId | null = null;
  private hoveredId: DrawingId | null = null;
  private hoveredHandle: HandleKey | null = null;
  /** Phase 13 Cycle B.2 — generic per-drawing text pool for text/callout/range/position readouts. */
  private readonly textPools = new Map<DrawingId, DrawingTextPool>();
  private creating: CreatingState | null = null;
  private dragging: DraggingState | null = null;
  private bulkLoadDepth = 0;
  private warnedSoftLimit = false;
  private destroyed = false;

  private readonly newId: () => DrawingId;
  private readonly facade: DrawingsFacade;

  constructor(deps: DrawingsControllerDeps) {
    this.deps = deps;
    this.handlesContainer = deps.renderer.drawingsHandlesLayer;
    // Position handle layer to plot rect on each render; default to plotRect now.
    const initialPlot = deps.plotRect();
    this.handlesContainer.position.set(initialPlot.x, initialPlot.y);
    this.handleHitParent = { addChild: (g: Graphics): Graphics => this.handlesContainer.addChild(g) };
    this.newId = deps.newId ?? defaultNewId;
    this.storage = new StorageBinding({
      logger: deps.logger,
      applySnapshot: (snap): void => { this.applySnapshotInternal(snap); },
      takeSnapshot: (): DrawingsSnapshot => this.takeSnapshotInternal(),
      ...(deps.setTimeout !== undefined ? { setTimeout: deps.setTimeout } : {}),
      ...(deps.clearTimeout !== undefined ? { clearTimeout: deps.clearTimeout } : {}),
    });

    deps.stage.on("globalpointermove", this.onGlobalPointerMove);
    deps.stage.on("pointerup", this.onPointerUp);
    deps.stage.on("pointerupoutside", this.onPointerUp);
    deps.stage.on("pointercancel", this.onPointerCancel);
    deps.canvas.addEventListener("keydown", this.onKeyDown);
    deps.canvas.addEventListener("contextmenu", this.onContextMenu);
    deps.canvas.addEventListener("dblclick", this.onDoubleClick);

    this.facade = this.buildFacade();
  }

  /** Pointer-claim hook handed to `ViewportController.deps.onPointerDownIntercept`. */
  readonly onPointerDownIntercept = (e: FederatedPointerEvent): boolean => {
    if (this.destroyed) {
      return false;
    }
    const local = this.toLocal(e);
    if (local === null) {
      return false;
    }
    const pType = (e.pointerType as PointerKind | undefined) ?? "mouse";
    const tols = defaultTolerancesFor(pType, this.deps.currentDpr());
    const ctxScale = this.makeProjectionContext();
    if (ctxScale === null) {
      return false;
    }
    // Creating mode: every click while creating is a new anchor.
    if (this.creating !== null) {
      this.acceptCreatePoint(local.x, local.y);
      return true;
    }
    const projected = this.projectAll(ctxScale);
    const hit = hitTestDrawings(local.x, local.y, projected, this.selectedId === null ? null : String(this.selectedId), tols);
    if (hit === null) {
      // Empty area — deselect if anything was selected; otherwise let viewport pan.
      if (this.selectedId !== null) {
        this.setSelected(null);
        return true;
      }
      return false;
    }
    // Hit on selected drawing's handle → start handle drag.
    if (hit.part === "handle" && hit.handle !== undefined) {
      this.beginDrag(hit.drawing, "handle", hit.handle, e, local.x, local.y);
      this.deps.canvas.focus();
      return true;
    }
    // Hit on the selected drawing → start body translate.
    if (this.selectedId !== null && hit.drawing.id === this.selectedId) {
      this.beginDrag(hit.drawing, "body", null, e, local.x, local.y);
      this.deps.canvas.focus();
      return true;
    }
    // Click selects.
    this.setSelected(hit.drawing.id);
    this.deps.canvas.focus();
    return true;
  };

  /** Called by `TimeSeriesChart.flush` when `'drawings'` is dirty. */
  render(ctx: DrawingsRenderContext): void {
    if (this.destroyed) {
      return;
    }
    this.handlesContainer.position.set(ctx.plotRect.x, ctx.plotRect.y);
    const projected = this.projectAll({ timeScale: ctx.timeScale, priceScale: ctx.priceScale, plotRect: ctx.plotRect });
    // Redraw drawings into pooled graphics + fib label pool sync.
    const seen = new Set<DrawingId>();
    const formatter = this.deps.priceFormatter?.() ?? ((v: number): string => v.toFixed(2));
    const intervalDuration = Number(ctx.timeScale.intervalDuration);
    for (const entry of projected) {
      const g = this.ensureGraphicsFor(entry.drawing.id);
      redrawDrawing(g, entry.drawing, entry.geom, ctx.theme, ctx.dpr);
      seen.add(entry.drawing.id);
      if (entry.drawing.kind === "fibRetracement" && entry.geom.kind === "fibRetracement") {
        const pool = this.ensureFibLabelPool(entry.drawing.id);
        if (entry.drawing.visible) {
          pool.sync(entry.geom.levels, {
            theme: ctx.theme,
            priceFormatter: formatter,
            showPrices: entry.drawing.showPrices,
            showPercents: entry.drawing.showPercents,
            xRight: entry.geom.xMax,
            plotWidth: ctx.plotRect.w,
          });
        } else {
          pool.hideAll();
        }
      }
      // Phase 13 Cycle B.2 — generic text pool sync for kinds with readouts.
      const textSpecs = computeTextSpecs(entry.drawing, entry.geom, ctx, formatter, intervalDuration);
      if (textSpecs !== null) {
        const pool = this.ensureTextPool(entry.drawing.id);
        if (entry.drawing.visible) {
          pool.sync(textSpecs, ctx.theme);
        } else {
          pool.hideAll();
        }
      }
    }
    // Hide graphics whose drawings vanished.
    for (const [id, g] of this.graphicsByDrawing) {
      if (!seen.has(id)) {
        g.visible = false;
      }
    }
    for (const [id, pool] of this.fibLabelPools) {
      if (!seen.has(id)) {
        pool.hideAll();
      }
    }
    for (const [id, pool] of this.textPools) {
      if (!seen.has(id)) {
        pool.hideAll();
      }
    }
    // Sync handles for selected drawing.
    const selected = this.selectedId === null ? null : this.drawings.get(this.selectedId);
    if (selected !== undefined && selected !== null) {
      const geom = projected.find((e) => e.drawing.id === selected.id)?.geom;
      if (geom !== undefined) {
        const draggingHandle = this.dragging?.id === selected.id ? this.dragging.handleKey : null;
        const hoveredHandle = this.hoveredId === selected.id ? this.hoveredHandle : null;
        const specs = handleSpecsFor(geom, hoveredHandle, draggingHandle, { w: ctx.plotRect.w, h: ctx.plotRect.h });
        syncHandleGraphics(this.handleGraphicsPool, specs, this.handleCache, ctx.theme, ctx.dpr, this.handleHitParent);
        return;
      }
    }
    syncHandleGraphics(this.handleGraphicsPool, [], this.handleCache, ctx.theme, ctx.dpr, this.handleHitParent);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.deps.stage.off("globalpointermove", this.onGlobalPointerMove);
    this.deps.stage.off("pointerup", this.onPointerUp);
    this.deps.stage.off("pointerupoutside", this.onPointerUp);
    this.deps.stage.off("pointercancel", this.onPointerCancel);
    this.deps.canvas.removeEventListener("keydown", this.onKeyDown);
    this.deps.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.deps.canvas.removeEventListener("dblclick", this.onDoubleClick);
    for (const g of this.graphicsByDrawing.values()) {
      g.parent?.removeChild(g);
      g.destroy();
    }
    this.graphicsByDrawing.clear();
    for (const g of this.handleGraphicsPool) {
      g.parent?.removeChild(g);
      g.destroy();
    }
    this.handleGraphicsPool.length = 0;
    this.handleCache.destroy();
    for (const pool of this.fibLabelPools.values()) {
      pool.destroy();
    }
    this.fibLabelPools.clear();
    for (const pool of this.textPools.values()) {
      pool.destroy();
    }
    this.textPools.clear();
    this.storage.destroy();
    this.drawings.clear();
    this.selectedId = null;
    this.creating = null;
    this.dragging = null;
  }

  /** Public facade returned by `chart.drawings`. */
  asFacade(): DrawingsFacade {
    return this.facade;
  }

  // ─── Public model methods (delegated by the facade) ──────────────────────

  private buildFacade(): DrawingsFacade {
    return Object.freeze({
      beginCreate: (kind: DrawingKind, options?: BeginCreateOptions): void => {
        this.beginCreate(kind, options);
      },
      cancelCreate: (): void => { this.cancelCreate(); },
      isCreating: (): boolean => this.creating !== null,
      list: (): readonly Drawing[] => Array.from(this.drawings.values()),
      getById: (id: DrawingId | string): Drawing | null => {
        const found = this.drawings.get(asDrawingId(String(id)));
        return found ?? null;
      },
      add: (drawing: Drawing): void => { this.addInternal(drawing); },
      update: <K extends Drawing>(
        id: DrawingId | string,
        patch: Partial<Omit<K, "id" | "kind" | "schemaVersion">>,
      ): boolean => this.updateInternal(asDrawingId(String(id)), patch),
      remove: (id: DrawingId | string): boolean => this.removeInternal(asDrawingId(String(id))),
      clear: (): void => { this.clearInternal(); },
      getSelectedId: (): DrawingId | null => this.selectedId,
      select: (id: DrawingId | string | null): void => {
        this.setSelected(id === null ? null : asDrawingId(String(id)));
      },
      getSnapshot: (): DrawingsSnapshot => this.takeSnapshotInternal(),
      loadSnapshot: (snapshot: unknown): { droppedCount: number; droppedKinds: readonly string[] } => {
        const { snapshot: parsed, droppedCount, droppedKinds, unsupportedSchemaVersion } = parseSnapshot(snapshot);
        if (unsupportedSchemaVersion !== null) {
          this.deps.logger.warn(
            `[carta] drawings:loadSnapshot unsupported schemaVersion ${String(unsupportedSchemaVersion)} — expected 1; nothing loaded`,
          );
        }
        if (droppedCount > 0) {
          this.deps.logger.warn(
            `[carta] drawings:loadSnapshot dropped ${String(droppedCount)} record(s)`,
            droppedKinds,
          );
        }
        this.applySnapshotInternal(parsed);
        return { droppedCount, droppedKinds };
      },
      attachStorage: (adapter: DrawingsStorageAdapter, scope: DrawingScope): void => {
        this.storage.attach(adapter, scope);
      },
      detachStorage: (): void => { this.storage.detach(); },
    });
  }

  // ─── FSM internals ───────────────────────────────────────────────────────

  private beginCreate(kind: DrawingKind, options?: BeginCreateOptions): void {
    this.cancelCreate();
    this.setSelected(null);
    this.creating = { kind, options: options ?? {}, placedAnchors: [] };
  }

  private cancelCreate(): void {
    if (this.creating === null) {
      return;
    }
    this.creating = null;
    this.deps.invalidate();
  }

  private acceptCreatePoint(localX: number, localY: number): void {
    const creating = this.creating;
    if (creating === null) {
      return;
    }
    const ctx = this.makeProjectionContext();
    if (ctx === null) {
      return;
    }
    const { time: rawTime, price: rawPrice } = unprojectPoint(ctx, localX, localY);
    const { time, price } = this.applyMagnetSnap(rawTime, rawPrice);
    const anchor: DrawingAnchor = Object.freeze({
      time: asTime(time),
      price: asPrice(price),
      paneId: MAIN_PANE_ID,
    });
    creating.placedAnchors.push(anchor);
    const required = requiredAnchorsFor(creating.kind);
    if (creating.placedAnchors.length < required) {
      this.deps.invalidate();
      return;
    }
    const drawing = this.materializeDrawing(creating);
    this.creating = null;
    if (drawing !== null) {
      this.addInternal(drawing);
      this.setSelected(drawing.id);
    }
  }

  private materializeDrawing(creating: CreatingState): Drawing | null {
    const id = this.newId();
    const z = creating.options.z ?? this.nextZ();
    const style: DrawingStyle = creating.options.style ?? Object.freeze({});
    const meta = creating.options.meta;
    const baseCommonNoMeta = Object.freeze({
      id,
      style,
      locked: false,
      visible: true,
      z,
      schemaVersion: 1 as const,
    });
    const baseCommon = meta === undefined ? baseCommonNoMeta : Object.freeze({ ...baseCommonNoMeta, meta });
    const a = creating.placedAnchors;
    switch (creating.kind) {
      case "trendline": {
        if (a[0] === undefined || a[1] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "trendline" as const,
          anchors: Object.freeze([a[0], a[1]] as const),
        });
      }
      case "horizontalLine": {
        if (a[0] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "horizontalLine" as const,
          anchors: Object.freeze([a[0]] as const),
        });
      }
      case "verticalLine": {
        if (a[0] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "verticalLine" as const,
          anchors: Object.freeze([a[0]] as const),
        });
      }
      case "rectangle": {
        if (a[0] === undefined || a[1] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "rectangle" as const,
          anchors: Object.freeze([a[0], a[1]] as const),
        });
      }
      case "fibRetracement": {
        if (a[0] === undefined || a[1] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "fibRetracement" as const,
          anchors: Object.freeze([a[0], a[1]] as const),
          levels: creating.options.levels ?? DEFAULT_FIB_LEVELS,
          showPrices: creating.options.showPrices !== false,
          showPercents: creating.options.showPercents !== false,
        });
      }
      case "ray": {
        if (a[0] === undefined || a[1] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "ray" as const,
          anchors: Object.freeze([a[0], a[1]] as const),
        });
      }
      case "extendedLine": {
        if (a[0] === undefined || a[1] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "extendedLine" as const,
          anchors: Object.freeze([a[0], a[1]] as const),
        });
      }
      case "horizontalRay": {
        if (a[0] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "horizontalRay" as const,
          anchors: Object.freeze([a[0]] as const),
          direction: creating.options.direction ?? "right",
        });
      }
      case "parallelChannel": {
        if (a[0] === undefined || a[1] === undefined || a[2] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "parallelChannel" as const,
          anchors: Object.freeze([a[0], a[1], a[2]] as const),
        });
      }
      case "longPosition":
      case "shortPosition": {
        // Two clicks: entry, then far-right (defines endTime). SL/TP default
        // to ±1% of entry per side; user adjusts via handles after create.
        if (a[0] === undefined || a[1] === undefined) {
          return null;
        }
        const entryTime = a[0].time;
        const entryPrice = Number(a[0].price);
        const endTime = creating.options.endTime !== undefined
          ? asTime(creating.options.endTime)
          : a[1].time;
        const endTimeNum = Number(endTime);
        const entryTimeNum = Number(entryTime);
        if (!Number.isFinite(endTimeNum) || endTimeNum <= entryTimeNum) {
          return null;
        }
        const isLong = creating.kind === "longPosition";
        const slPrice = isLong ? entryPrice * 0.99 : entryPrice * 1.01;
        const tpPrice = isLong ? entryPrice * 1.02 : entryPrice * 0.98;
        const entry = a[0];
        const sl: DrawingAnchor = Object.freeze({ time: entryTime, price: asPrice(slPrice), paneId: entry.paneId });
        const tp: DrawingAnchor = Object.freeze({ time: entryTime, price: asPrice(tpPrice), paneId: entry.paneId });
        const qty = creating.options.qty !== undefined && Number.isFinite(creating.options.qty) && creating.options.qty > 0
          ? creating.options.qty
          : 1;
        const displayMode: DisplayMode = creating.options.displayMode ?? "rr";
        const tickSize = creating.options.tickSize !== undefined && Number.isFinite(creating.options.tickSize) && creating.options.tickSize > 0
          ? creating.options.tickSize
          : undefined;
        const baseFields = {
          ...baseCommon,
          anchors: Object.freeze([entry, sl, tp] as const),
          endTime,
          qty,
          displayMode,
        };
        const withTick = tickSize === undefined ? baseFields : { ...baseFields, tickSize };
        if (isLong) {
          return Object.freeze({ ...withTick, kind: "longPosition" as const });
        }
        return Object.freeze({ ...withTick, kind: "shortPosition" as const });
      }
      case "text": {
        if (a[0] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "text" as const,
          anchors: Object.freeze([a[0]] as const),
          text: creating.options.text ?? "Note",
        });
      }
      case "callout": {
        if (a[0] === undefined || a[1] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "callout" as const,
          anchors: Object.freeze([a[0], a[1]] as const),
          text: creating.options.text ?? "Callout",
        });
      }
      case "arrow": {
        if (a[0] === undefined || a[1] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "arrow" as const,
          anchors: Object.freeze([a[0], a[1]] as const),
        });
      }
      case "dateRange": {
        if (a[0] === undefined || a[1] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "dateRange" as const,
          anchors: Object.freeze([a[0], a[1]] as const),
        });
      }
      case "priceRange": {
        if (a[0] === undefined || a[1] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "priceRange" as const,
          anchors: Object.freeze([a[0], a[1]] as const),
        });
      }
      case "priceDateRange": {
        if (a[0] === undefined || a[1] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "priceDateRange" as const,
          anchors: Object.freeze([a[0], a[1]] as const),
        });
      }
    }
  }

  private addInternal(drawing: Drawing): void {
    if (this.drawings.has(drawing.id)) {
      this.deps.logger.warn(`[carta] drawings.add: duplicate id ${String(drawing.id)} — ignored`);
      return;
    }
    const normalized = normalizeDrawingDefaults(drawing);
    this.drawings.set(normalized.id, normalized);
    this.maybeWarnSoftLimit();
    if (this.bulkLoadDepth === 0) {
      this.deps.eventBus.emit("drawings:created", { drawing: normalized });
      this.storage.scheduleSave();
    }
    this.deps.invalidate();
  }

  private updateInternal<K extends Drawing>(
    id: DrawingId,
    patch: Partial<Omit<K, "id" | "kind" | "schemaVersion">>,
  ): boolean {
    const existing = this.drawings.get(id);
    if (existing === undefined) {
      return false;
    }
    const next: Drawing = Object.freeze({
      ...existing,
      ...patch,
      id: existing.id,
      kind: existing.kind,
      schemaVersion: 1,
    } as Drawing);
    this.drawings.set(id, next);
    if (this.bulkLoadDepth === 0) {
      this.deps.eventBus.emit("drawings:updated", { drawing: next });
      this.storage.scheduleSave();
    }
    this.deps.invalidate();
    return true;
  }

  private removeInternal(id: DrawingId): boolean {
    const existing = this.drawings.get(id);
    if (existing === undefined) {
      return false;
    }
    this.drawings.delete(id);
    const g = this.graphicsByDrawing.get(id);
    if (g !== undefined) {
      g.parent?.removeChild(g);
      g.destroy();
      this.graphicsByDrawing.delete(id);
    }
    const pool = this.fibLabelPools.get(id);
    if (pool !== undefined) {
      pool.destroy();
      this.fibLabelPools.delete(id);
    }
    const tpool = this.textPools.get(id);
    if (tpool !== undefined) {
      tpool.destroy();
      this.textPools.delete(id);
    }
    if (this.selectedId === id) {
      this.setSelected(null);
    }
    if (this.bulkLoadDepth === 0) {
      this.deps.eventBus.emit("drawings:removed", { id, kind: existing.kind });
      this.storage.scheduleSave();
    }
    this.deps.invalidate();
    return true;
  }

  private clearInternal(): void {
    if (this.drawings.size === 0) {
      return;
    }
    const ids = Array.from(this.drawings.keys());
    this.bulkLoadDepth += 1;
    try {
      for (const id of ids) {
        this.removeInternal(id);
      }
    } finally {
      this.bulkLoadDepth -= 1;
    }
    if (this.bulkLoadDepth === 0) {
      this.storage.scheduleSave();
    }
    this.deps.invalidate();
  }

  private setSelected(id: DrawingId | null): void {
    if (this.selectedId === id) {
      return;
    }
    this.selectedId = id;
    const drawing = id === null ? null : this.drawings.get(id) ?? null;
    this.deps.eventBus.emit("drawings:selected", { drawing });
    this.deps.invalidate();
  }

  private removeSelected(): void {
    if (this.selectedId !== null) {
      this.removeInternal(this.selectedId);
    }
  }

  private duplicateSelected(): void {
    const id = this.selectedId;
    if (id === null) {
      return;
    }
    const orig = this.drawings.get(id);
    if (orig === undefined) {
      return;
    }
    const interval = Number(this.deps.currentTimeScale().intervalDuration);
    const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : 0;
    const clone = cloneDrawingWithOffset(orig, safeInterval, this.newId());
    if (clone === null) {
      return;
    }
    this.addInternal(clone);
    this.setSelected(clone.id);
  }

  private nudgeSelected(key: string, shift: boolean): void {
    const id = this.selectedId;
    if (id === null) {
      return;
    }
    const orig = this.drawings.get(id);
    if (orig === undefined) {
      return;
    }
    if (orig.locked) {
      return;
    }
    const interval = Number(this.deps.currentTimeScale().intervalDuration);
    const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : 0;
    const stepMul = shift ? 10 : 1;
    let dt = 0;
    let dp = 0;
    if (key === "ArrowLeft") {
      dt = -safeInterval * stepMul;
    } else if (key === "ArrowRight") {
      dt = safeInterval * stepMul;
    } else if (key === "ArrowUp") {
      dp = stepMul;
    } else if (key === "ArrowDown") {
      dp = -stepMul;
    }
    const next = translateDrawing(orig, dt, dp);
    this.drawings.set(id, next);
    if (this.bulkLoadDepth === 0) {
      this.deps.eventBus.emit("drawings:updated", { drawing: next });
      this.storage.scheduleSave();
    }
    this.deps.invalidate();
  }

  private beginDrag(
    drawing: Drawing,
    mode: "handle" | "body",
    handleKey: HandleKey | null,
    e: FederatedPointerEvent,
    localX: number,
    localY: number,
  ): void {
    if (drawing.locked) {
      return;
    }
    const ctx = this.makeProjectionContext();
    if (ctx === null) {
      return;
    }
    const { time, price } = unprojectPoint(ctx, localX, localY);
    const startEndTime =
      drawing.kind === "longPosition" || drawing.kind === "shortPosition"
        ? Number(drawing.endTime)
        : null;
    this.dragging = {
      id: drawing.id,
      mode,
      handleKey,
      pointerId: e.pointerId,
      startAnchors: drawing.anchors,
      startGlobalX: e.global.x,
      startGlobalY: e.global.y,
      startTime: time,
      startPrice: price,
      startEndTime,
      shiftConstrain: e.shiftKey,
      committed: false,
    };
  }

  private readonly onGlobalPointerMove = (e: FederatedPointerEvent): void => {
    if (this.destroyed) {
      return;
    }
    const local = this.toLocal(e);
    if (local === null) {
      return;
    }
    if (this.dragging !== null && this.dragging.pointerId === e.pointerId) {
      this.continueDrag(e, local.x, local.y);
      return;
    }
    // Hover update for cursor + handle highlight.
    const tols = defaultTolerancesFor((e.pointerType as PointerKind | undefined) ?? "mouse", this.deps.currentDpr());
    const ctx = this.makeProjectionContext();
    if (ctx === null) {
      return;
    }
    const projected = this.projectAll(ctx);
    const hit = hitTestDrawings(local.x, local.y, projected, this.selectedId === null ? null : String(this.selectedId), tols);
    const nextHovered = hit?.drawing.id ?? null;
    const nextHandle = hit?.handle ?? null;
    if (nextHovered !== this.hoveredId || nextHandle !== this.hoveredHandle) {
      this.hoveredId = nextHovered;
      this.hoveredHandle = nextHandle;
      this.deps.invalidate();
    }
  };

  private continueDrag(e: FederatedPointerEvent, localX: number, localY: number): void {
    const drag = this.dragging;
    if (drag === null) {
      return;
    }
    if (!drag.committed) {
      const dx = e.global.x - drag.startGlobalX;
      const dy = e.global.y - drag.startGlobalY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
        return;
      }
      drag.committed = true;
    }
    drag.shiftConstrain = e.shiftKey;
    const ctx = this.makeProjectionContext();
    if (ctx === null) {
      return;
    }
    const { time: rawLiveTime, price: rawLivePrice } = unprojectPoint(ctx, localX, localY);
    const { time: liveTime, price: livePrice } = this.applyMagnetSnap(rawLiveTime, rawLivePrice);
    const orig = this.drawings.get(drag.id);
    if (orig === undefined) {
      this.dragging = null;
      return;
    }
    // Phase 13 Cycle B.2 — position tools have a 4-handle topology
    // (entry / sl / tp / time-end) plus the SL<entry<TP invariant. Route
    // through a dedicated path so we can keep the invariant + endTime sync.
    if (orig.kind === "longPosition" || orig.kind === "shortPosition") {
      const next = this.applyPositionDrag(orig, drag, liveTime, livePrice);
      if (next === null) {
        return;
      }
      this.drawings.set(drag.id, next);
      if (this.bulkLoadDepth === 0) {
        this.deps.eventBus.emit("drawings:updated", { drawing: next });
      }
      this.deps.invalidate();
      return;
    }
    const nextAnchors =
      drag.mode === "handle"
        ? this.applyHandleDrag(orig, drag, liveTime, livePrice, ctx)
        : this.applyBodyDrag(drag, liveTime, livePrice);
    if (nextAnchors === null) {
      return;
    }
    const next = withAnchors(orig, nextAnchors);
    this.drawings.set(drag.id, next);
    if (this.bulkLoadDepth === 0) {
      this.deps.eventBus.emit("drawings:updated", { drawing: next });
    }
    this.deps.invalidate();
  }

  private applyHandleDrag(
    orig: Drawing,
    drag: DraggingState,
    liveTime: number,
    livePrice: number,
    ctx: { timeScale: TimeScale; priceScale: PriceScale; plotRect: PlotRect },
  ): readonly DrawingAnchor[] | null {
    const idx = typeof drag.handleKey === "number" ? drag.handleKey : null;
    // Only anchor handles map cleanly to anchor indexes in cycle A.
    if (idx === null) {
      return null;
    }
    const anchors = orig.anchors.map((a, i): DrawingAnchor => {
      if (i !== idx) {
        return a;
      }
      let timeOut = liveTime;
      let priceOut = livePrice;
      // Single-anchor primitives where the time or price is irrelevant
      // (horizontalLine = price-only; verticalLine = time-only). For these,
      // hold the unaffected coordinate constant from the original.
      if (orig.kind === "horizontalLine") {
        timeOut = Number(a.time);
      } else if (orig.kind === "verticalLine") {
        priceOut = Number(a.price);
      }
      // Trendline-family shift-constrain (3-bucket): horizontal / vertical / 45°.
      if ((orig.kind === "trendline" || orig.kind === "ray" || orig.kind === "extendedLine") && drag.shiftConstrain) {
        const otherIdx = idx === 0 ? 1 : 0;
        const other = orig.anchors[otherIdx];
        const a0Px = Number(ctx.timeScale.timeToPixel(other.time));
        const a0Py = Number(ctx.priceScale.valueToPixel(other.price));
        const a1Px = Number(ctx.timeScale.timeToPixel(asTime(timeOut)));
        const a1Py = Number(ctx.priceScale.valueToPixel(asPrice(priceOut)));
        const dx = a1Px - a0Px;
        const dy = a1Py - a0Py;
        const adx = Math.abs(dx);
        const ady = Math.abs(dy);
        if (adx === 0) {
          timeOut = Number(other.time);
        } else {
          const slope = ady / adx;
          if (slope < 0.4142) {
            priceOut = Number(other.price);
          } else if (slope > 2.4142) {
            timeOut = Number(other.time);
          } else {
            const sign = Math.sign(dy) || 1;
            const newPy = a0Py + sign * adx * Math.sign(dx);
            const newPriceVal = Number(ctx.priceScale.pixelToValue(newPy));
            if (Number.isFinite(newPriceVal)) {
              priceOut = newPriceVal;
            }
          }
        }
      }
      return Object.freeze({
        time: asTime(timeOut),
        price: asPrice(priceOut),
        paneId: a.paneId,
      });
    });
    return anchors;
  }

  private applyBodyDrag(
    drag: DraggingState,
    liveTime: number,
    livePrice: number,
  ): readonly DrawingAnchor[] | null {
    const dt = liveTime - drag.startTime;
    const dp = livePrice - drag.startPrice;
    let dtUse = dt;
    let dpUse = dp;
    if (drag.shiftConstrain) {
      // Shape body translate: keep dominant axis only.
      const interval = Math.abs(dt);
      const priceMag = Math.abs(dp);
      if (interval >= priceMag) {
        dpUse = 0;
      } else {
        dtUse = 0;
      }
    }
    return drag.startAnchors.map((a) => Object.freeze({
      time: asTime(Number(a.time) + dtUse),
      price: asPrice(Number(a.price) + dpUse),
      paneId: a.paneId,
    }));
  }

  /**
   * Phase 13 Cycle B.2 — position-tool drag. Handles entry / sl / tp / time-end
   * keys + body translate; enforces the SL<entry<TP invariant per side.
   */
  private applyPositionDrag(
    orig: LongPositionDrawing | ShortPositionDrawing,
    drag: DraggingState,
    liveTime: number,
    livePrice: number,
  ): LongPositionDrawing | ShortPositionDrawing | null {
    const startEntry = drag.startAnchors[0];
    const startSl = drag.startAnchors[1];
    const startTp = drag.startAnchors[2];
    if (startEntry === undefined || startSl === undefined || startTp === undefined) {
      return null;
    }
    const startEndTime = drag.startEndTime ?? Number(orig.endTime);
    const isLong = orig.kind === "longPosition";
    let entryTime = Number(startEntry.time);
    let endTime = startEndTime;
    let prices: PositionPrices = {
      entry: Number(startEntry.price),
      sl: Number(startSl.price),
      tp: Number(startTp.price),
    };

    if (drag.mode === "body") {
      const dt = liveTime - drag.startTime;
      const dp = livePrice - drag.startPrice;
      let dtUse = dt;
      let dpUse = dp;
      if (drag.shiftConstrain) {
        const interval = Math.abs(dt);
        const priceMag = Math.abs(dp);
        if (interval >= priceMag) {
          dpUse = 0;
        } else {
          dtUse = 0;
        }
      }
      entryTime += dtUse;
      endTime += dtUse;
      prices = {
        entry: prices.entry + dpUse,
        sl: prices.sl + dpUse,
        tp: prices.tp + dpUse,
      };
    } else {
      // Handle drag.
      const key = drag.handleKey;
      if (key === 0) {
        // Entry handle: drives entry.time AND entry.price.
        entryTime = liveTime;
        prices = { ...prices, entry: livePrice };
      } else if (key === 1) {
        // SL handle: y only.
        prices = { ...prices, sl: livePrice };
      } else if (key === 2) {
        // TP handle: y only.
        prices = { ...prices, tp: livePrice };
      } else if (key === "time-end") {
        endTime = liveTime;
      } else {
        return null;
      }
    }

    // Enforce invariant.
    const pinned: keyof PositionPrices | undefined =
      drag.mode === "handle"
        ? drag.handleKey === 0
          ? "entry"
          : drag.handleKey === 1
            ? "sl"
            : drag.handleKey === 2
              ? "tp"
              : undefined
        : undefined;
    const clamped = isLong ? clampLongPosition(prices, pinned) : clampShortPosition(prices, pinned);

    // Guard endTime > entryTime.
    if (!Number.isFinite(endTime) || endTime <= entryTime) {
      // Don't break the drawing — clamp endTime to one bar after entry.
      const interval = Number(this.deps.currentTimeScale().intervalDuration);
      endTime = entryTime + (Number.isFinite(interval) && interval > 0 ? interval : 1);
    }

    const paneId = startEntry.paneId;
    const entryAnchor: DrawingAnchor = Object.freeze({
      time: asTime(entryTime),
      price: asPrice(clamped.entry),
      paneId,
    });
    const slAnchor: DrawingAnchor = Object.freeze({
      time: asTime(entryTime),
      price: asPrice(clamped.sl),
      paneId,
    });
    const tpAnchor: DrawingAnchor = Object.freeze({
      time: asTime(entryTime),
      price: asPrice(clamped.tp),
      paneId,
    });
    return Object.freeze({
      ...orig,
      anchors: Object.freeze([entryAnchor, slAnchor, tpAnchor] as const),
      endTime: asTime(endTime),
    });
  }

  private readonly onPointerUp = (e: FederatedPointerEvent): void => {
    if (this.destroyed) {
      return;
    }
    const drag = this.dragging;
    if (drag !== null && drag.pointerId === e.pointerId) {
      const wasCommitted = drag.committed;
      this.dragging = null;
      const updated = this.drawings.get(drag.id);
      if (wasCommitted && updated !== undefined && this.bulkLoadDepth === 0) {
        this.storage.scheduleSave();
      }
      this.deps.invalidate();
    }
  };

  private readonly onPointerCancel = (e: FederatedPointerEvent): void => {
    const drag = this.dragging;
    if (drag !== null && drag.pointerId === e.pointerId) {
      // Restore original anchors (the most recent is in `dragging.startAnchors`).
      const orig = this.drawings.get(drag.id);
      if (orig !== undefined) {
        const restored = withAnchors(orig, drag.startAnchors);
        this.drawings.set(drag.id, restored);
      }
      this.dragging = null;
      this.deps.invalidate();
    }
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.destroyed) {
      return;
    }
    if (this.selectedId === null && this.creating === null) {
      return;
    }
    switch (e.key) {
      case "Escape":
        if (this.creating !== null) {
          this.cancelCreate();
          e.preventDefault();
          return;
        }
        if (this.selectedId !== null) {
          this.setSelected(null);
          e.preventDefault();
        }
        return;
      case "Delete":
      case "Backspace":
        if (this.selectedId !== null) {
          this.removeSelected();
          e.preventDefault();
        }
        return;
      case "d":
      case "D":
        if ((e.metaKey || e.ctrlKey) && this.selectedId !== null) {
          this.duplicateSelected();
          e.preventDefault();
        }
        return;
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown":
        if (this.selectedId !== null) {
          this.nudgeSelected(e.key, e.shiftKey);
          e.preventDefault();
        }
        return;
      default:
        return;
    }
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.destroyed) {
      return;
    }
    const rect = this.deps.canvas.getBoundingClientRect();
    const plot = this.deps.plotRect();
    const localX = e.clientX - rect.left - plot.x;
    const localY = e.clientY - rect.top - plot.y;
    const ctx = this.makeProjectionContext();
    if (ctx === null) {
      return;
    }
    const projected = this.projectAll(ctx);
    const tols = defaultTolerancesFor("mouse", this.deps.currentDpr());
    const hit = hitTestDrawings(localX, localY, projected, this.selectedId === null ? null : String(this.selectedId), tols);
    if (hit === null) {
      return;
    }
    e.preventDefault();
    this.deps.eventBus.emit("drawing:contextmenu", {
      drawing: hit.drawing,
      screen: { x: e.clientX, y: e.clientY },
      source: "right-click",
    });
  };

  private readonly onDoubleClick = (e: MouseEvent): void => {
    if (this.destroyed) {
      return;
    }
    const rect = this.deps.canvas.getBoundingClientRect();
    const plot = this.deps.plotRect();
    const localX = e.clientX - rect.left - plot.x;
    const localY = e.clientY - rect.top - plot.y;
    const ctx = this.makeProjectionContext();
    if (ctx === null) {
      return;
    }
    const projected = this.projectAll(ctx);
    const tols = defaultTolerancesFor("mouse", this.deps.currentDpr());
    const hit = hitTestDrawings(localX, localY, projected, this.selectedId === null ? null : String(this.selectedId), tols);
    if (hit === null) {
      return;
    }
    this.deps.eventBus.emit("drawing:edit", { drawing: hit.drawing });
  };

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private toLocal(e: FederatedPointerEvent): { x: number; y: number } | null {
    const plot = this.deps.plotRect();
    if (plot.w <= 0 || plot.h <= 0) {
      return null;
    }
    const local = { x: e.global.x - plot.x, y: e.global.y - plot.y };
    if (local.x < 0 || local.y < 0 || local.x > plot.w || local.y > plot.h) {
      return null;
    }
    return local;
  }

  private makeProjectionContext(): {
    timeScale: TimeScale;
    priceScale: PriceScale;
    plotRect: PlotRect;
  } | null {
    const plot = this.deps.plotRect();
    if (plot.w <= 0 || plot.h <= 0) {
      return null;
    }
    return {
      timeScale: this.deps.currentTimeScale(),
      priceScale: this.deps.currentPriceScale(),
      plotRect: plot,
    };
  }

  private projectAll(ctx: { timeScale: TimeScale; priceScale: PriceScale; plotRect: PlotRect }): readonly { drawing: Drawing; geom: ScreenGeom }[] {
    const sorted = Array.from(this.drawings.values()).sort((a, b) => a.z - b.z);
    return sorted.map((d) => ({ drawing: d, geom: projectDrawing(d, ctx) }));
  }

  private ensureGraphicsFor(id: DrawingId): Graphics {
    let g = this.graphicsByDrawing.get(id);
    if (g === undefined) {
      g = new Graphics();
      this.deps.renderer.drawingsLayer.addChild(g);
      this.graphicsByDrawing.set(id, g);
    }
    return g;
  }

  private ensureFibLabelPool(id: DrawingId): FibLabelPool {
    let pool = this.fibLabelPools.get(id);
    if (pool === undefined) {
      pool = new FibLabelPool(this.handlesContainer);
      this.fibLabelPools.set(id, pool);
    }
    return pool;
  }

  private ensureTextPool(id: DrawingId): DrawingTextPool {
    let pool = this.textPools.get(id);
    if (pool === undefined) {
      pool = new DrawingTextPool(this.handlesContainer);
      this.textPools.set(id, pool);
    }
    return pool;
  }

  private maybeWarnSoftLimit(): void {
    if (!this.warnedSoftLimit && this.drawings.size >= SOFT_DRAWING_LIMIT) {
      this.warnedSoftLimit = true;
      this.deps.logger.warn(
        `[carta] drawings: count exceeded ${String(SOFT_DRAWING_LIMIT)}; hit-test + render may degrade. Consider trimming.`,
      );
    }
  }

  /**
   * Cancel an in-flight handle/body drag, restoring the drawing to its
   * `startAnchors`. Called by the chart when `interval:change` fires mid-drag
   * so anchor times don't drift in the new bar grid. Idempotent.
   */
  cancelActiveDrag(): void {
    const drag = this.dragging;
    if (drag === null) {
      return;
    }
    const orig = this.drawings.get(drag.id);
    if (orig !== undefined) {
      const restored = withAnchors(orig, drag.startAnchors);
      this.drawings.set(drag.id, restored);
    }
    this.dragging = null;
    this.deps.invalidate();
  }

  private applyMagnetSnap(time: number, price: number): { time: number; price: number } {
    const modeFn = this.deps.currentMagnetMode;
    if (modeFn === undefined) {
      return { time, price };
    }
    const mode = modeFn();
    if (mode === "off") {
      return { time, price };
    }
    const interval = Number(this.deps.currentTimeScale().intervalDuration);
    const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : 0;
    if (safeInterval <= 0) {
      return { time, price };
    }
    const lookup = this.deps.getOhlcAtTime;
    if (lookup === undefined) {
      this.warnMagnetMissingOhlcChannel();
      return { time, price };
    }
    // Probe the bar at the snapped time; magnet helper handles null bar.
    const probeTime = nearestBarSampleTime(time, safeInterval);
    const bar = lookup(probeTime);
    if (bar === null) {
      // No cached bar — still snap time, but leave price live (don't drift).
      return applyMagnetTimeOnly(time, safeInterval, price);
    }
    const snapped = applyMagnet(time, price, mode, safeInterval, bar);
    return { time: snapped.time, price: snapped.price };
  }

  private warnMagnetMissingOhlcChannel(): void {
    if (this.warnedMissingOhlcChannel) {
      return;
    }
    this.warnedMissingOhlcChannel = true;
    this.deps.logger.warn(
      "[carta] drawings:magnet — no OHLC channel registered; magnet is a no-op until one is added.",
    );
  }

  private nextZ(): number {
    let z = 0;
    for (const d of this.drawings.values()) {
      if (d.z > z) {
        z = d.z;
      }
    }
    return z + 1;
  }

  private takeSnapshotInternal(): DrawingsSnapshot {
    const drawings: Drawing[] = Array.from(this.drawings.values()).map(cloneForSnapshot);
    return Object.freeze({ schemaVersion: 1, drawings: Object.freeze(drawings) });
  }

  private applySnapshotInternal(snapshot: DrawingsSnapshot): void {
    this.bulkLoadDepth += 1;
    try {
      // Replace contents wholesale.
      const existingIds = Array.from(this.drawings.keys());
      for (const id of existingIds) {
        this.removeInternal(id);
      }
      for (const d of snapshot.drawings) {
        this.addInternal(d);
      }
    } finally {
      this.bulkLoadDepth -= 1;
    }
    this.deps.invalidate();
  }
}

// Helpers — pure functions used by both the controller and tests.

function nearestBarSampleTime(time: number, interval: number): number {
  if (!Number.isFinite(time) || !Number.isFinite(interval) || interval <= 0) {
    return time;
  }
  return Math.floor((time + interval / 2) / interval) * interval;
}

function applyMagnetTimeOnly(time: number, interval: number, price: number): { time: number; price: number } {
  return { time: nearestBarSampleTime(time, interval), price };
}

function requiredAnchorsFor(kind: DrawingKind): number {
  switch (kind) {
    case "trendline":
    case "rectangle":
    case "fibRetracement":
    case "ray":
    case "extendedLine":
    case "longPosition":
    case "shortPosition":
    case "callout":
    case "arrow":
    case "dateRange":
    case "priceRange":
    case "priceDateRange":
      return 2;
    case "horizontalLine":
    case "verticalLine":
    case "horizontalRay":
    case "text":
      return 1;
    case "parallelChannel":
      return 3;
  }
}

function withAnchors(orig: Drawing, anchors: readonly DrawingAnchor[]): Drawing {
  switch (orig.kind) {
    case "trendline":
    case "rectangle":
    case "fibRetracement":
    case "ray":
    case "extendedLine":
    case "callout":
    case "arrow":
    case "dateRange":
    case "priceRange":
    case "priceDateRange":
      if (anchors[0] === undefined || anchors[1] === undefined) {
        return orig;
      }
      return Object.freeze({ ...orig, anchors: Object.freeze([anchors[0], anchors[1]] as const) });
    case "horizontalLine":
    case "verticalLine":
    case "horizontalRay":
    case "text":
      if (anchors[0] === undefined) {
        return orig;
      }
      return Object.freeze({ ...orig, anchors: Object.freeze([anchors[0]] as const) });
    case "parallelChannel":
      if (anchors[0] === undefined || anchors[1] === undefined || anchors[2] === undefined) {
        return orig;
      }
      return Object.freeze({
        ...orig,
        anchors: Object.freeze([anchors[0], anchors[1], anchors[2]] as const),
      });
    case "longPosition":
    case "shortPosition":
      if (anchors[0] === undefined || anchors[1] === undefined || anchors[2] === undefined) {
        return orig;
      }
      return Object.freeze({
        ...orig,
        anchors: Object.freeze([anchors[0], anchors[1], anchors[2]] as const),
      });
  }
}

function translateDrawing(d: Drawing, dt: number, dp: number): Drawing {
  const xform = (a: DrawingAnchor): DrawingAnchor =>
    Object.freeze({
      time: asTime(Number(a.time) + dt),
      price: asPrice(Number(a.price) + dp),
      paneId: a.paneId,
    });
  // Position-tool: also shift `endTime` by dt so the band tracks the body.
  if (d.kind === "longPosition" || d.kind === "shortPosition") {
    const next = Object.freeze({
      ...d,
      anchors: Object.freeze([xform(d.anchors[0]), xform(d.anchors[1]), xform(d.anchors[2])] as const),
      endTime: asTime(Number(d.endTime) + dt),
    });
    return next;
  }
  return withAnchors(d, d.anchors.map(xform));
}

function cloneDrawingWithOffset(d: Drawing, intervalMs: number, newId: DrawingId): Drawing | null {
  const offset = intervalMs > 0 ? intervalMs : 0;
  const shift = (a: DrawingAnchor): DrawingAnchor => Object.freeze({
    time: asTime(Number(a.time) + offset),
    price: a.price,
    paneId: a.paneId,
  });
  switch (d.kind) {
    case "trendline":
    case "rectangle":
    case "fibRetracement":
    case "ray":
    case "extendedLine":
    case "callout":
    case "arrow":
    case "dateRange":
    case "priceRange":
    case "priceDateRange":
      return Object.freeze({
        ...d,
        id: newId,
        anchors: Object.freeze([shift(d.anchors[0]), shift(d.anchors[1])] as const),
      });
    case "horizontalLine":
    case "verticalLine":
    case "horizontalRay":
    case "text":
      return Object.freeze({
        ...d,
        id: newId,
        anchors: Object.freeze([shift(d.anchors[0])] as const),
      });
    case "parallelChannel":
      return Object.freeze({
        ...d,
        id: newId,
        anchors: Object.freeze([
          shift(d.anchors[0]),
          shift(d.anchors[1]),
          shift(d.anchors[2]),
        ] as const),
      });
    case "longPosition":
    case "shortPosition":
      return Object.freeze({
        ...d,
        id: newId,
        anchors: Object.freeze([
          shift(d.anchors[0]),
          shift(d.anchors[1]),
          shift(d.anchors[2]),
        ] as const),
        endTime: asTime(Number(d.endTime) + offset),
      });
  }
}

function cloneForSnapshot(d: Drawing): Drawing {
  return d;
}

/**
 * Phase 13 Cycle B.2 — compute the per-drawing `DrawingTextSpec[]` for kinds
 * that carry pooled BitmapText readouts. Returns `null` for kinds that don't
 * have any text. The placement is plot-local pixels; pool's parent container
 * is positioned at `plotRect.(x,y)` already so specs need no further offset.
 */
function computeTextSpecs(
  drawing: Drawing,
  geom: ScreenGeom,
  ctx: DrawingsRenderContext,
  formatter: (v: number) => string,
  intervalDuration: number,
): readonly DrawingTextSpec[] | null {
  const theme = ctx.theme;
  const plotW = ctx.plotRect.w;
  switch (drawing.kind) {
    case "text": {
      if (geom.kind !== "text") {
        return null;
      }
      const specs: DrawingTextSpec[] = [];
      if (drawing.text.length > 0) {
        const x = clampLabelX(geom.labelX + 6, plotW, drawing.text.length * 6 + 8);
        specs.push(textSpec(drawing.text, x, geom.labelY - 8, theme));
      }
      return specs;
    }
    case "callout": {
      if (geom.kind !== "callout") {
        return null;
      }
      if (drawing.text.length === 0) {
        return [];
      }
      const x = geom.labelX + 8;
      const y = geom.labelY + 6;
      return [textSpec(drawing.text, x, y, theme)];
    }
    case "longPosition":
    case "shortPosition": {
      if (geom.kind !== "longPosition" && geom.kind !== "shortPosition") {
        return null;
      }
      const stats = computePositionStats({
        entry: Number(drawing.anchors[0].price),
        sl: Number(drawing.anchors[1].price),
        tp: Number(drawing.anchors[2].price),
        qty: drawing.qty,
        side: drawing.kind === "longPosition" ? "long" : "short",
        displayMode: drawing.displayMode,
        ...(drawing.tickSize !== undefined ? { tickSize: drawing.tickSize } : {}),
      });
      const rewardLabel = formatPositionLine(stats, drawing.displayMode, "reward", formatter);
      const riskLabel = formatPositionLine(stats, drawing.displayMode, "risk", formatter);
      const xRight = geom.endX;
      const labelOffset = 6;
      const rewardX = clampLabelX(xRight + labelOffset, plotW, rewardLabel.length * 6 + 8);
      const riskX = clampLabelX(xRight + labelOffset, plotW, riskLabel.length * 6 + 8);
      const rewardY = (geom.rewardRect.yTop + geom.rewardRect.yBottom) / 2 - 8;
      const riskY = (geom.riskRect.yTop + geom.riskRect.yBottom) / 2 - 8;
      const specs: DrawingTextSpec[] = [];
      specs.push({
        text: rewardLabel,
        x: rewardX,
        y: rewardY,
        bgColor: theme.up,
        textColor: theme.crosshairTagText,
        bgAlpha: 0.85,
      });
      specs.push({
        text: riskLabel,
        x: riskX,
        y: riskY,
        bgColor: theme.down,
        textColor: theme.crosshairTagText,
        bgAlpha: 0.85,
      });
      return specs;
    }
    case "dateRange": {
      if (geom.kind !== "dateRange") {
        return null;
      }
      const a = drawing.anchors;
      const dt = Number(a[1].time) - Number(a[0].time);
      const bars =
        intervalDuration > 0 ? Math.round(dt / intervalDuration) : 0;
      const text = `${String(bars)} ${Math.abs(bars) === 1 ? "bar" : "bars"} · ${formatDuration(dt)}`;
      const x = clampLabelX(geom.badgeAnchor.x - (text.length * 6) / 2, plotW, text.length * 6 + 8);
      return [textSpec(text, x, geom.badgeAnchor.y, theme)];
    }
    case "priceRange": {
      if (geom.kind !== "priceRange") {
        return null;
      }
      const a = drawing.anchors;
      const p0 = Number(a[0].price);
      const p1 = Number(a[1].price);
      const delta = p1 - p0;
      const pctText = p0 === 0 ? "—" : `${(delta >= 0 ? "+" : "")}${((delta / p0) * 100).toFixed(2)}%`;
      const sign = delta >= 0 ? "+" : "-";
      const text = `${sign}${formatter(Math.abs(delta))} (${pctText})`;
      const x = clampLabelX(geom.badgeAnchor.x - (text.length * 6) - 8, plotW, text.length * 6 + 8);
      return [textSpec(text, x, geom.badgeAnchor.y - 8, theme)];
    }
    case "priceDateRange": {
      if (geom.kind !== "priceDateRange") {
        return null;
      }
      const a = drawing.anchors;
      const p0 = Number(a[0].price);
      const p1 = Number(a[1].price);
      const dt = Number(a[1].time) - Number(a[0].time);
      const bars = intervalDuration > 0 ? Math.round(dt / intervalDuration) : 0;
      const delta = p1 - p0;
      const pctText = p0 === 0 ? "—" : `${(delta >= 0 ? "+" : "")}${((delta / p0) * 100).toFixed(2)}%`;
      const sign = delta >= 0 ? "+" : "-";
      const line1 = `${String(bars)} ${Math.abs(bars) === 1 ? "bar" : "bars"} · ${formatDuration(dt)}`;
      const line2 = `${sign}${formatter(Math.abs(delta))} (${pctText})`;
      const text = `${line1}\n${line2}`;
      const widest = Math.max(line1.length, line2.length);
      const x = clampLabelX(geom.badgeAnchor.x - (widest * 6) / 2, plotW, widest * 6 + 8);
      return [textSpec(text, x, geom.badgeAnchor.y + 4, theme)];
    }
    case "trendline":
    case "horizontalLine":
    case "verticalLine":
    case "rectangle":
    case "fibRetracement":
    case "ray":
    case "extendedLine":
    case "horizontalRay":
    case "parallelChannel":
    case "arrow":
      // No text readouts for these kinds (fib has its own pool).
      return null;
  }
}

function textSpec(text: string, x: number, y: number, theme: Theme): DrawingTextSpec {
  return {
    text,
    x,
    y,
    bgColor: theme.crosshairTagBg,
    textColor: theme.crosshairTagText,
  };
}

function clampLabelX(rawX: number, plotW: number, approxW: number): number {
  if (!Number.isFinite(plotW) || plotW <= 0) {
    return rawX;
  }
  if (rawX + approxW > plotW) {
    return Math.max(0, plotW - approxW);
  }
  if (rawX < 0) {
    return 0;
  }
  return rawX;
}

/**
 * Tolerant boundary for `chart.drawings.add()`. Hosts may legitimately build
 * drawings without filling every optional shape field — the internal model
 * (and `projectDrawing`) assume they are present, so we normalize once here.
 */
export function normalizeDrawingDefaults(d: Drawing): Drawing {
  // Tolerate hosts who omit optional shape fields at runtime (the TS types
  // declare them required, but JSON-built or partial inputs reach `add()`).
  const view = d as unknown as { style?: DrawingStyle | null; levels?: readonly FibLevel[] | null };
  const styleFill = view.style === undefined || view.style === null;
  if (d.kind === "fibRetracement") {
    const levelsFill = view.levels === undefined || view.levels === null || !Array.isArray(view.levels);
    if (!styleFill && !levelsFill) {
      return d;
    }
    return Object.freeze({
      ...d,
      style: styleFill ? Object.freeze({} as DrawingStyle) : d.style,
      levels: levelsFill ? DEFAULT_FIB_LEVELS : d.levels,
    });
  }
  if (!styleFill) {
    return d;
  }
  return Object.freeze({ ...d, style: Object.freeze({} as DrawingStyle) });
}
