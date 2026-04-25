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
  type Theme,
} from "../../types.js";
import {
  asDrawingId,
  DEFAULT_FIB_LEVELS,
  MAIN_PANE_ID,
  type BeginCreateOptions,
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
} from "./render.js";
import { parseSnapshot } from "./parsers.js";
import { StorageBinding } from "./storage.js";

const SOFT_DRAWING_LIMIT = 500;
const DRAG_THRESHOLD_PX = 6;

interface DraggingState {
  readonly id: DrawingId;
  readonly mode: "handle" | "body";
  readonly handleKey: number | "corner-tr" | "corner-bl" | null;
  readonly pointerId: number;
  readonly startAnchors: readonly DrawingAnchor[];
  readonly startGlobalX: number;
  readonly startGlobalY: number;
  readonly startTime: number;
  readonly startPrice: number;
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
  private readonly handleGraphicsPool: Graphics[] = [];
  private readonly handleCache = new HandleContextCache();
  private readonly handlesContainer: Container;
  private readonly handleHitParent: { addChild: (g: Graphics) => Graphics };

  private readonly storage: StorageBinding;

  private selectedId: DrawingId | null = null;
  private hoveredId: DrawingId | null = null;
  private hoveredHandle: number | "corner-tr" | "corner-bl" | null = null;
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
    // Redraw drawings into pooled graphics.
    const seen = new Set<DrawingId>();
    for (const entry of projected) {
      const g = this.ensureGraphicsFor(entry.drawing.id);
      redrawDrawing(g, entry.drawing, entry.geom, ctx.theme, ctx.dpr);
      seen.add(entry.drawing.id);
    }
    // Hide graphics whose drawings vanished.
    for (const [id, g] of this.graphicsByDrawing) {
      if (!seen.has(id)) {
        g.visible = false;
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
    const { time, price } = unprojectPoint(ctx, localX, localY);
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
    handleKey: number | "corner-tr" | "corner-bl" | null,
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
    const { time: liveTime, price: livePrice } = unprojectPoint(ctx, localX, localY);
    const orig = this.drawings.get(drag.id);
    if (orig === undefined) {
      this.dragging = null;
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
      // Trendline shift-constrain (3-bucket).
      if (orig.kind === "trendline" && drag.shiftConstrain) {
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

  private maybeWarnSoftLimit(): void {
    if (!this.warnedSoftLimit && this.drawings.size >= SOFT_DRAWING_LIMIT) {
      this.warnedSoftLimit = true;
      this.deps.logger.warn(
        `[carta] drawings: count exceeded ${String(SOFT_DRAWING_LIMIT)}; hit-test + render may degrade. Consider trimming.`,
      );
    }
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

function requiredAnchorsFor(kind: DrawingKind): number {
  switch (kind) {
    case "trendline":
    case "rectangle":
    case "fibRetracement":
      return 2;
    case "horizontalLine":
    case "verticalLine":
      return 1;
  }
}

function withAnchors(orig: Drawing, anchors: readonly DrawingAnchor[]): Drawing {
  switch (orig.kind) {
    case "trendline":
      if (anchors[0] === undefined || anchors[1] === undefined) {
        return orig;
      }
      return Object.freeze({ ...orig, anchors: Object.freeze([anchors[0], anchors[1]] as const) });
    case "horizontalLine":
      if (anchors[0] === undefined) {
        return orig;
      }
      return Object.freeze({ ...orig, anchors: Object.freeze([anchors[0]] as const) });
    case "verticalLine":
      if (anchors[0] === undefined) {
        return orig;
      }
      return Object.freeze({ ...orig, anchors: Object.freeze([anchors[0]] as const) });
    case "rectangle":
      if (anchors[0] === undefined || anchors[1] === undefined) {
        return orig;
      }
      return Object.freeze({ ...orig, anchors: Object.freeze([anchors[0], anchors[1]] as const) });
    case "fibRetracement":
      if (anchors[0] === undefined || anchors[1] === undefined) {
        return orig;
      }
      return Object.freeze({ ...orig, anchors: Object.freeze([anchors[0], anchors[1]] as const) });
  }
}

function translateDrawing(d: Drawing, dt: number, dp: number): Drawing {
  const xform = (a: DrawingAnchor): DrawingAnchor =>
    Object.freeze({
      time: asTime(Number(a.time) + dt),
      price: asPrice(Number(a.price) + dp),
      paneId: a.paneId,
    });
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
      return Object.freeze({
        ...d,
        id: newId,
        anchors: Object.freeze([shift(d.anchors[0]), shift(d.anchors[1])] as const),
      });
    case "horizontalLine":
    case "verticalLine":
      return Object.freeze({
        ...d,
        id: newId,
        anchors: Object.freeze([shift(d.anchors[0])] as const),
      });
  }
}

function cloneForSnapshot(d: Drawing): Drawing {
  return d;
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
