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
  type HandleSpec,
} from "./render.js";
import { parseSnapshot } from "./parsers.js";
import { StorageBinding } from "./storage.js";
import { normalizeDrawingDefaults as normalizeBoundary } from "./normalize.js";
import type {
  BeginDragForTestOptions,
  DragStateSnapshot,
  DrawingsDevHooks,
  VisibleHandleInfo,
} from "./devHooks.js";

const SOFT_DRAWING_LIMIT = 500;
const DRAG_THRESHOLD_PX = 6;
/**
 * Phase 13 Cycle B.3 — chart-height threshold below which the readout
 * auto-thin kicks in.  Per F-2 in the B.2 test report: at 300 px every
 * stacked priceDateRange / position label overlaps; 360 gives a comfortable
 * margin while still allowing tight panes.
 */
const COMPACT_READOUT_HEIGHT_PX = 360;

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
  /**
   * Cycle B.3 — when body-drag is multi-select, snapshot the full Drawing
   * for every peer in the selection (excluding the primary drag.id and
   * any locked drawings).  Each frame translates from these snapshots so
   * deltas stay absolute relative to drag start.  Empty for handle-drag
   * and single-selection body-drag.
   */
  readonly peerStartStates: ReadonlyMap<DrawingId, Drawing>;
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
  /**
   * Plural selection getter — returns the full selection set (length 0 =
   * nothing, length 1 = single-select, length ≥ 2 = multi).  Cycle B.3
   * replaced the legacy singular `getSelectedId`; hosts that want "the
   * active drawing" should call `getPrimarySelectedId()`.
   */
  getSelectedIds(): readonly DrawingId[];
  /** Most recently clicked / focused drawing in the selection, or `null`. */
  getPrimarySelectedId(): DrawingId | null;
  select(id: DrawingId | string | null): void;
  /**
   * Cycle B.3 — toggle a drawing's membership in the selection set.
   * Used by Ctrl/Cmd+click on desktop.  When the drawing was just added,
   * it becomes the new primary.
   */
  toggleSelection(id: DrawingId | string): void;
  getSnapshot(): DrawingsSnapshot;
  loadSnapshot(snapshot: unknown): { droppedCount: number; droppedKinds: readonly string[] };
  attachStorage(adapter: DrawingsStorageAdapter, scope: DrawingScope): void;
  detachStorage(): void;
  /**
   * Phase 13 Cycle B.3 — test-only / unstable surface.  See `DrawingsDevHooks`
   * for the contract.  Not part of the SemVer API; may change between minors.
   */
  getDevHooks(): DrawingsDevHooks;
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

  /**
   * Phase 13 Cycle B.3 — multi-select state.  `selectedIds` is the full
   * selection set (rendered as primary outline + handles for the most
   * recently focused, secondary outline for the rest).  `primarySelectedId`
   * tracks the last-clicked drawing so hit-tests + handle-drags route to
   * a single owner.  `selectedId` (singular) is preserved as an internal
   * alias for the primary so existing render code keeps working until the
   * full secondary-render landing.
   */
  private readonly selectedIds = new Set<DrawingId>();
  private primarySelectedId: DrawingId | null = null;
  /**
   * Internal alias for `primarySelectedId` — keeps the read sites that
   * pre-date the multi-select refactor (handle hit-test, hover gating,
   * keyboard nudge) working without rewriting every reference.  Writes go
   * through `setSelected` / `toggleSelection` / `clearSelection`.
   */
  private get selectedId(): DrawingId | null {
    return this.primarySelectedId;
  }
  private hoveredId: DrawingId | null = null;
  private hoveredHandle: HandleKey | null = null;
  /** Phase 13 Cycle B.2 — generic per-drawing text pool for text/callout/range/position readouts. */
  private readonly textPools = new Map<DrawingId, DrawingTextPool>();
  private creating: CreatingState | null = null;
  private dragging: DraggingState | null = null;
  private bulkLoadDepth = 0;
  /**
   * Cycle B.3 fix-up Q-A — set during `removeSelected()` so per-id
   * `removeInternal` calls don't each emit a `drawings:selected` event.
   * `removeSelected` emits a single trailing `drawings:selected` after the
   * loop completes.
   */
  private suppressSelectionEmit = false;
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
    const primaryStr = this.primarySelectedId === null ? null : String(this.primarySelectedId);
    const hit = hitTestDrawings(local.x, local.y, projected, primaryStr, tols);
    if (hit === null) {
      // Empty area — deselect if anything was selected; otherwise let viewport pan.
      if (this.selectedIds.size > 0) {
        this.setSelected(null);
        return true;
      }
      return false;
    }
    // Cycle B.3 — Ctrl/Cmd+click toggles the hit drawing in/out of the
    // selection set.  No drag is initiated by the modifier-click; the user
    // is curating the selection.
    if (e.ctrlKey || e.metaKey) {
      this.toggleSelectionInternal(hit.drawing.id);
      this.deps.canvas.focus();
      return true;
    }
    // Hit on selected drawing's handle → start handle drag (single-only).
    if (hit.part === "handle" && hit.handle !== undefined) {
      this.beginDrag(hit.drawing, "handle", hit.handle, e, local.x, local.y);
      this.deps.canvas.focus();
      return true;
    }
    // Hit on a member of the current selection → start body translate.
    // Multi-select carries through the drag, peers move together.
    if (this.selectedIds.has(hit.drawing.id)) {
      this.beginDrag(hit.drawing, "body", null, e, local.x, local.y);
      this.deps.canvas.focus();
      return true;
    }
    // Plain click on a non-selected drawing replaces the selection.
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
    const seen = new Set<DrawingId>();
    const formatter = this.deps.priceFormatter?.() ?? ((v: number): string => v.toFixed(2));
    const intervalDuration = Number(ctx.timeScale.intervalDuration);
    const compact = ctx.plotRect.h < COMPACT_READOUT_HEIGHT_PX;

    // Phase 1: compute candidate text-specs for every visible drawing.
    const candidates = new Map<DrawingId, readonly DrawingTextSpec[]>();
    for (const entry of projected) {
      if (!entry.drawing.visible) {
        continue;
      }
      const specs = computeTextSpecs(entry.drawing, entry.geom, ctx, formatter, intervalDuration, compact);
      if (specs !== null) {
        candidates.set(entry.drawing.id, specs);
      }
    }

    // Phase 2: when compact, drop specs from non-selected drawings whose
    // bbox overlaps another drawing's bbox.  Selected drawings always win.
    const finalSpecs = compact && candidates.size >= 2
      ? suppressOverlappingSpecs(candidates, this.selectedId)
      : candidates;

    // Render pass.
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
      const textSpecs = finalSpecs.get(entry.drawing.id);
      if (textSpecs !== undefined) {
        const pool = this.ensureTextPool(entry.drawing.id);
        if (entry.drawing.visible) {
          pool.sync(textSpecs, ctx.theme);
        } else {
          pool.hideAll();
        }
      } else if (this.textPools.has(entry.drawing.id)) {
        // Was previously rendered, now suppressed — hide pool entries.
        this.textPools.get(entry.drawing.id)?.hideAll();
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
    // Sync handles for the entire selection set.  Cycle B.3 — multi-select
    // renders handles for every selected drawing; the hit-tester still only
    // routes drags on the primary, but the visual cue makes the selection
    // legible.  Primary's handles use the existing hover / active variants;
    // secondaries render with the `'normal'` variant only.
    const allSpecs: HandleSpec[] = [];
    for (const sid of this.selectedIds) {
      const drawing = this.drawings.get(sid);
      if (drawing === undefined) {
        continue;
      }
      const geom = projected.find((e) => e.drawing.id === drawing.id)?.geom;
      if (geom === undefined) {
        continue;
      }
      const isPrimary = sid === this.primarySelectedId;
      const draggingHandle = isPrimary && this.dragging?.id === drawing.id ? this.dragging.handleKey : null;
      const hoveredHandle = isPrimary && this.hoveredId === drawing.id ? this.hoveredHandle : null;
      const specs = handleSpecsFor(geom, hoveredHandle, draggingHandle, { w: ctx.plotRect.w, h: ctx.plotRect.h });
      for (const s of specs) {
        allSpecs.push(s);
      }
    }
    syncHandleGraphics(this.handleGraphicsPool, allSpecs, this.handleCache, ctx.theme, ctx.dpr, this.handleHitParent);
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
    this.selectedIds.clear();
    this.primarySelectedId = null;
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
      getSelectedIds: (): readonly DrawingId[] => Array.from(this.selectedIds),
      getPrimarySelectedId: (): DrawingId | null => this.primarySelectedId,
      select: (id: DrawingId | string | null): void => {
        this.setSelected(id === null ? null : asDrawingId(String(id)));
      },
      toggleSelection: (id: DrawingId | string): void => {
        this.toggleSelectionInternal(asDrawingId(String(id)));
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
      getDevHooks: (): DrawingsDevHooks => this.buildDevHooks(),
    });
  }

  // ─── Dev hooks ───────────────────────────────────────────────────────────

  /**
   * Phase 13 Cycle B.3 — return the dev-hook surface used by `__cartaTest` in
   * the demo and by Playwright e2e specs.  Materialized once per call (no
   * caching), but each method is a thin closure that reads live controller
   * state — so callers can hold a single reference for the lifetime of the
   * chart.
   */
  private buildDevHooks(): DrawingsDevHooks {
    return Object.freeze({
      beginDragForTest: (opts: BeginDragForTestOptions): boolean => {
        const id = asDrawingId(String(opts.drawingId));
        const drawing = this.drawings.get(id);
        if (drawing === undefined) {
          return false;
        }
        const handleKey: HandleKey | null = opts.mode === "handle"
          ? (opts.handleKey ?? 0)
          : null;
        // Default the start coords to the first anchor's screen position so
        // the test caller doesn't have to compute pixels by hand.
        let localX = opts.localX;
        let localY = opts.localY;
        if (localX === undefined || localY === undefined) {
          const ctx = this.makeProjectionContext();
          if (ctx === null) {
            return false;
          }
          const geom = projectDrawing(drawing, ctx);
          const fallback = firstAnchorScreenPoint(geom);
          if (fallback === null) {
            return false;
          }
          localX = fallback.x;
          localY = fallback.y;
        }
        const plot = this.deps.plotRect();
        return this.beginDragRaw({
          drawing,
          mode: opts.mode,
          handleKey,
          pointerId: opts.pointerId ?? 1,
          globalX: localX + plot.x,
          globalY: localY + plot.y,
          shiftKey: false,
          localX,
          localY,
        });
      },
      continueDragForTest: (localX: number, localY: number): boolean => {
        if (this.dragging === null) {
          return false;
        }
        const plot = this.deps.plotRect();
        // Move just past the threshold the first time so the drag commits.
        this.continueDragRaw(localX + plot.x, localY + plot.y, false, localX, localY);
        return true;
      },
      endDragForTest: (): boolean => {
        if (this.dragging === null) {
          return false;
        }
        return this.endDragForPointer(this.dragging.pointerId);
      },
      getDragState: (): DragStateSnapshot | null => {
        const drag = this.dragging;
        if (drag === null) {
          return null;
        }
        return Object.freeze({
          drawingId: drag.id,
          mode: drag.mode,
          handleKey: drag.handleKey,
          pointerId: drag.pointerId,
          committed: drag.committed,
        });
      },
      cancelActiveDrag: (): void => { this.cancelActiveDrag(); },
      visibleHandlesFor: (drawingId: DrawingId | string): readonly VisibleHandleInfo[] => {
        const id = asDrawingId(String(drawingId));
        if (this.selectedId !== id) {
          return Object.freeze([]);
        }
        const drawing = this.drawings.get(id);
        if (drawing === undefined) {
          return Object.freeze([]);
        }
        const ctx = this.makeProjectionContext();
        if (ctx === null) {
          return Object.freeze([]);
        }
        const geom = projectDrawing(drawing, ctx);
        const specs = handleSpecsFor(geom, null, null, { w: ctx.plotRect.w, h: ctx.plotRect.h });
        return Object.freeze(
          specs.map((s): VisibleHandleInfo => Object.freeze({
            key: s.key as HandleKey,
            x: s.x,
            y: s.y,
          })),
        );
      },
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
      // ─── Phase 13 Cycle C.1 ───
      case "pitchfork": {
        if (a[0] === undefined || a[1] === undefined || a[2] === undefined) {
          return null;
        }
        const variant = creating.options.variant ?? "andrews";
        return Object.freeze({
          ...baseCommon,
          kind: "pitchfork" as const,
          anchors: Object.freeze([a[0], a[1], a[2]] as const),
          variant,
        });
      }
      case "gannFan": {
        if (a[0] === undefined || a[1] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "gannFan" as const,
          anchors: Object.freeze([a[0], a[1]] as const),
        });
      }
      case "ellipse": {
        if (a[0] === undefined || a[1] === undefined) {
          return null;
        }
        return Object.freeze({
          ...baseCommon,
          kind: "ellipse" as const,
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
    const intervalMs = Number(this.deps.currentTimeScale().intervalDuration);
    const safeInterval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0;
    const { drawing: normalized, warn } = normalizeBoundary(drawing, safeInterval);
    if (normalized === null) {
      this.deps.logger.warn(`[carta] drawings.add: ${warn ?? "invalid drawing"} — dropped`);
      return;
    }
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
    // Cycle B.3 — drop the removed id from the selection set; emit a single
    // updated `drawings:selected` payload so hosts can re-render their
    // selection-aware UI (PnL panel, context menu).
    let selectionChanged = false;
    if (this.selectedIds.delete(id)) {
      selectionChanged = true;
    }
    if (this.primarySelectedId === id) {
      const next = this.selectedIds.values().next();
      this.primarySelectedId = next.done === true ? null : next.value;
      selectionChanged = true;
    }
    if (this.bulkLoadDepth === 0) {
      this.deps.eventBus.emit("drawings:removed", { id, kind: existing.kind });
      if (selectionChanged && !this.suppressSelectionEmit) {
        this.emitSelected();
      }
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

  /**
   * Replace the selection set with a single drawing (or empty).  Used for
   * pointerdown without modifier, programmatic `chart.drawings.select(id)`,
   * and Esc clear.
   */
  private setSelected(id: DrawingId | null): void {
    if (id === null) {
      if (this.selectedIds.size === 0 && this.primarySelectedId === null) {
        return;
      }
      this.selectedIds.clear();
      this.primarySelectedId = null;
      this.emitSelected();
      this.deps.invalidate();
      return;
    }
    if (
      this.selectedIds.size === 1 &&
      this.selectedIds.has(id) &&
      this.primarySelectedId === id
    ) {
      return;
    }
    this.selectedIds.clear();
    this.selectedIds.add(id);
    this.primarySelectedId = id;
    this.emitSelected();
    this.deps.invalidate();
  }

  /**
   * Cycle B.3 — Ctrl/Cmd+click toggle.  Adds `id` if absent, otherwise
   * removes it.  When adding, the toggled drawing becomes primary; when
   * removing the current primary, the next id in `selectedIds` (insertion
   * order) becomes primary, or `null` if the set is now empty.
   */
  private toggleSelectionInternal(id: DrawingId): void {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
      if (this.primarySelectedId === id) {
        const next = this.selectedIds.values().next();
        this.primarySelectedId = next.done === true ? null : next.value;
      }
    } else {
      if (!this.drawings.has(id)) {
        return;
      }
      this.selectedIds.add(id);
      this.primarySelectedId = id;
    }
    this.emitSelected();
    this.deps.invalidate();
  }

  private emitSelected(): void {
    const drawings: Drawing[] = [];
    for (const sid of this.selectedIds) {
      const d = this.drawings.get(sid);
      if (d !== undefined) {
        drawings.push(d);
      }
    }
    const primary =
      this.primarySelectedId !== null
        ? this.drawings.get(this.primarySelectedId) ?? null
        : null;
    this.deps.eventBus.emit("drawings:selected", {
      drawings: Object.freeze(drawings),
      primary,
    });
  }

  private removeSelected(): void {
    if (this.selectedIds.size === 0) {
      return;
    }
    // Iterate copy so removeInternal can mutate the set freely; skip locked.
    // Cycle B.3 fix-up Q-A — coalesce per-removal `drawings:selected` emits
    // into a single trailing emit so a 100-select-Delete doesn't spam 100
    // selection events.  Per-removal `drawings:removed` still fires.
    const ids = Array.from(this.selectedIds);
    const sizeBefore = this.selectedIds.size;
    this.suppressSelectionEmit = true;
    try {
      for (const id of ids) {
        const d = this.drawings.get(id);
        if (d === undefined || d.locked) {
          continue;
        }
        this.removeInternal(id);
      }
    } finally {
      this.suppressSelectionEmit = false;
    }
    if (this.selectedIds.size !== sizeBefore && this.bulkLoadDepth === 0) {
      this.emitSelected();
    }
  }

  private duplicateSelected(): void {
    const id = this.primarySelectedId;
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
    if (this.selectedIds.size === 0) {
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
    let touched = false;
    for (const id of this.selectedIds) {
      const orig = this.drawings.get(id);
      if (orig === undefined || orig.locked) {
        continue;
      }
      const next = translateDrawing(orig, dt, dp);
      this.drawings.set(id, next);
      if (this.bulkLoadDepth === 0) {
        this.deps.eventBus.emit("drawings:updated", { drawing: next });
      }
      touched = true;
    }
    if (touched && this.bulkLoadDepth === 0) {
      this.storage.scheduleSave();
    }
    if (touched) {
      this.deps.invalidate();
    }
  }

  private beginDrag(
    drawing: Drawing,
    mode: "handle" | "body",
    handleKey: HandleKey | null,
    e: FederatedPointerEvent,
    localX: number,
    localY: number,
  ): void {
    this.beginDragRaw({
      drawing,
      mode,
      handleKey,
      pointerId: e.pointerId,
      globalX: e.global.x,
      globalY: e.global.y,
      shiftKey: e.shiftKey,
      localX,
      localY,
    });
  }

  /**
   * Internal — accepts raw pointer coords so the dev-hook test path can
   * initiate a drag without forging a `FederatedPointerEvent`.  Returns
   * `true` when the drag was started; `false` when refused (locked drawing,
   * unprojectable plot, or another drag already active).
   */
  private beginDragRaw(opts: {
    drawing: Drawing;
    mode: "handle" | "body";
    handleKey: HandleKey | null;
    pointerId: number;
    globalX: number;
    globalY: number;
    shiftKey: boolean;
    localX: number;
    localY: number;
  }): boolean {
    if (this.dragging !== null) {
      return false;
    }
    if (opts.drawing.locked) {
      return false;
    }
    const ctx = this.makeProjectionContext();
    if (ctx === null) {
      return false;
    }
    const { time, price } = unprojectPoint(ctx, opts.localX, opts.localY);
    const startEndTime =
      opts.drawing.kind === "longPosition" || opts.drawing.kind === "shortPosition"
        ? Number(opts.drawing.endTime)
        : null;
    // Cycle B.3 — for multi-select body-drag, snapshot every peer's full
    // drawing (excluding primary + locked) so per-frame translates stay
    // absolute relative to drag start.
    const peerStartStates = new Map<DrawingId, Drawing>();
    if (opts.mode === "body" && this.selectedIds.size > 1 && this.selectedIds.has(opts.drawing.id)) {
      for (const sid of this.selectedIds) {
        if (sid === opts.drawing.id) {
          continue;
        }
        const peer = this.drawings.get(sid);
        if (peer === undefined || peer.locked) {
          continue;
        }
        peerStartStates.set(sid, peer);
      }
    }
    this.dragging = {
      id: opts.drawing.id,
      mode: opts.mode,
      handleKey: opts.handleKey,
      pointerId: opts.pointerId,
      startAnchors: opts.drawing.anchors,
      startGlobalX: opts.globalX,
      startGlobalY: opts.globalY,
      startTime: time,
      startPrice: price,
      startEndTime,
      peerStartStates,
      shiftConstrain: opts.shiftKey,
      committed: false,
    };
    return true;
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
    this.continueDragRaw(e.global.x, e.global.y, e.shiftKey, localX, localY);
  }

  private continueDragRaw(
    globalX: number,
    globalY: number,
    shiftKey: boolean,
    localX: number,
    localY: number,
  ): void {
    const drag = this.dragging;
    if (drag === null) {
      return;
    }
    if (!drag.committed) {
      const dx = globalX - drag.startGlobalX;
      const dy = globalY - drag.startGlobalY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
        return;
      }
      drag.committed = true;
    }
    drag.shiftConstrain = shiftKey;
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
    // Phase 13 Cycle B.3 — body-drag with multi-select: translate every
    // OTHER selected drawing by the same Δt / Δp from drag start (so we
    // never accumulate per-frame).  Locked drawings stay put (filtered
    // out at drag-start snapshot time).  Handle-drag is single-only by
    // design (matches TradingView).
    if (drag.mode === "body" && drag.peerStartStates.size > 0) {
      const dt = liveTime - drag.startTime;
      const dp = livePrice - drag.startPrice;
      let dtUse = dt;
      let dpUse = dp;
      if (drag.shiftConstrain) {
        if (Math.abs(dt) >= Math.abs(dp)) {
          dpUse = 0;
        } else {
          dtUse = 0;
        }
      }
      for (const [sid, peerStart] of drag.peerStartStates) {
        const peerNext = translateDrawing(peerStart, dtUse, dpUse);
        this.drawings.set(sid, peerNext);
        if (this.bulkLoadDepth === 0) {
          this.deps.eventBus.emit("drawings:updated", { drawing: peerNext });
        }
      }
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
    this.endDragForPointer(e.pointerId);
  };

  /**
   * Internal — finalize the active drag for a given pointerId.  Returns
   * `true` when a drag was ended, `false` when no drag was active for that
   * pointer.  Used by both real `pointerup` and the dev-hook test path.
   */
  private endDragForPointer(pointerId: number): boolean {
    const drag = this.dragging;
    if (drag?.pointerId !== pointerId) {
      return false;
    }
    const wasCommitted = drag.committed;
    this.dragging = null;
    const updated = this.drawings.get(drag.id);
    if (wasCommitted && updated !== undefined && this.bulkLoadDepth === 0) {
      this.storage.scheduleSave();
    }
    this.deps.invalidate();
    return true;
  }

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
   * Phase 13 Cycle B.3 — long-press claim hook used by `TimeSeriesChart`.
   * If a drawing is hit at the given plot-local pixel, select it + emit
   * `drawing:contextmenu` with `source: 'long-press'` and return `true`
   * (caller should suppress tracking-mode entry).  Returns `false` when
   * the long-press hits empty space and should fall through to phase-09
   * tracking mode.
   *
   * Pointer kind is fixed to `'touch'` because the only callers are
   * touch / pen long-press timers (extended in B.3 to fire on pen too).
   */
  tryClaimLongPress(localX: number, localY: number): boolean {
    if (this.destroyed) {
      return false;
    }
    // While create-mode is active, the long-press is consumed silently so
    // it doesn't promote into phase-09 tracking-mode and clobber the
    // half-finished drawing.  No selection / context-menu fires — the next
    // tap simply places the next anchor.
    if (this.creating !== null) {
      return true;
    }
    const ctx = this.makeProjectionContext();
    if (ctx === null) {
      return false;
    }
    const projected = this.projectAll(ctx);
    const tols = defaultTolerancesFor("touch", this.deps.currentDpr());
    const hit = hitTestDrawings(
      localX,
      localY,
      projected,
      this.selectedId === null ? null : String(this.selectedId),
      tols,
    );
    if (hit === null) {
      return false;
    }
    this.setSelected(hit.drawing.id);
    const plot = this.deps.plotRect();
    this.deps.eventBus.emit("drawing:contextmenu", {
      drawing: hit.drawing,
      screen: { x: plot.x + localX, y: plot.y + localY },
      source: "long-press",
    });
    return true;
  }

  /**
   * Cancel an in-flight handle/body drag, restoring the drawing AND every
   * multi-select peer to their pre-drag state.  Called by the chart when
   * `interval:change` fires mid-drag (so anchor times don't drift in the new
   * bar grid) and when `ViewportController.onPinchStart` fires (so a
   * second-finger pinch rolls back the drag and lets pinch take over).
   * Idempotent.
   *
   * Cycle B.3 fix-up — also iterates `drag.peerStartStates` and restores
   * every peer drawing translated by a multi-select body-drag.  Without
   * this, peers stay at their dragged positions after the cancel and the
   * user's data is silently corrupted on every interval change while a
   * multi-drag is in progress.
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
      // Only emit when the drag actually moved the primary — sub-threshold
      // (uncommitted) drags are a no-op rollback so silence matches the
      // peer-rollback strict-equality short-circuit.
      if (drag.committed && this.bulkLoadDepth === 0) {
        this.deps.eventBus.emit("drawings:updated", { drawing: restored });
      }
    }
    for (const [sid, peerStart] of drag.peerStartStates) {
      // Only emit if a peer actually moved during the drag — beginDragRaw
      // captures peerStartStates with `current === start`, so an
      // uncommitted drag will set the same state back without spam.
      const current = this.drawings.get(sid);
      if (current === undefined || current === peerStart) {
        continue;
      }
      this.drawings.set(sid, peerStart);
      if (this.bulkLoadDepth === 0) {
        this.deps.eventBus.emit("drawings:updated", { drawing: peerStart });
      }
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
    case "gannFan":
    case "ellipse":
      return 2;
    case "horizontalLine":
    case "verticalLine":
    case "horizontalRay":
    case "text":
      return 1;
    case "parallelChannel":
    case "pitchfork":
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
    case "gannFan":
    case "ellipse":
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
    case "pitchfork":
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
    case "gannFan":
    case "ellipse":
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
    case "pitchfork":
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
  compact: boolean,
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
      const xRight = geom.endX;
      const labelOffset = 6;
      // Compact mode: collapse the two readouts into a single R:R chip on
      // the band centre.  Full mode: separate reward + risk chips.
      if (compact) {
        const rrLabel = formatPositionLine(stats, "rr", "reward", formatter);
        const rrX = clampLabelX(xRight + labelOffset, plotW, rrLabel.length * 6 + 8);
        const rrY = (geom.rewardRect.yTop + geom.riskRect.yBottom) / 2 - 8;
        return [{
          text: rrLabel,
          x: rrX,
          y: rrY,
          bgColor: theme.crosshairTagBg,
          textColor: theme.crosshairTagText,
          bgAlpha: 0.85,
        }];
      }
      const rewardLabel = formatPositionLine(stats, drawing.displayMode, "reward", formatter);
      const riskLabel = formatPositionLine(stats, drawing.displayMode, "risk", formatter);
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
      const text = compact
        ? `${String(bars)}b · ${formatDuration(dt)}`
        : `${String(bars)} ${Math.abs(bars) === 1 ? "bar" : "bars"} · ${formatDuration(dt)}`;
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
      const text = compact
        ? `${sign}${formatter(Math.abs(delta))}`
        : `${sign}${formatter(Math.abs(delta))} (${pctText})`;
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
      // Compact mode: single line — combine bar count + delta with a separator.
      if (compact) {
        const oneLine = `${String(bars)}b · ${sign}${formatter(Math.abs(delta))}`;
        const x = clampLabelX(geom.badgeAnchor.x - (oneLine.length * 6) / 2, plotW, oneLine.length * 6 + 8);
        return [textSpec(oneLine, x, geom.badgeAnchor.y + 4, theme)];
      }
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
    case "pitchfork":
    case "gannFan":
    case "ellipse":
      // No text readouts for these kinds (fib has its own pool).
      return null;
  }
}

/**
 * Phase 13 Cycle B.3 — F-2 auto-thin overlap suppression.  Only invoked
 * when `plotRect.h < COMPACT_READOUT_HEIGHT_PX`.  For each pair of
 * candidate text-spec sets, if their bboxes overlap, the non-selected
 * loser drops its specs entirely.  Selected drawings always keep their
 * specs.  When two non-selected drawings overlap each other, the lower-z
 * drawing (earlier insertion in the candidates Map iteration order) is
 * dropped — small visual but stable per frame.
 *
 * Bbox approximation: `(x, y, max(text.length) * 6, 12)` per spec.  The
 * `text.length * 6` heuristic mirrors what `FibLabelPool` and the existing
 * label clampers already use.
 */
function suppressOverlappingSpecs(
  candidates: ReadonlyMap<DrawingId, readonly DrawingTextSpec[]>,
  selectedId: DrawingId | null,
): Map<DrawingId, readonly DrawingTextSpec[]> {
  const ids = Array.from(candidates.keys());
  const drop = new Set<DrawingId>();
  for (let i = 0; i < ids.length; i++) {
    const idA = ids[i];
    if (idA === undefined || drop.has(idA)) {
      continue;
    }
    const aSpecs = candidates.get(idA);
    if (aSpecs === undefined || aSpecs.length === 0) {
      continue;
    }
    for (let j = i + 1; j < ids.length; j++) {
      const idB = ids[j];
      if (idB === undefined || drop.has(idB)) {
        continue;
      }
      const bSpecs = candidates.get(idB);
      if (bSpecs === undefined || bSpecs.length === 0) {
        continue;
      }
      if (!specsOverlap(aSpecs, bSpecs)) {
        continue;
      }
      // Prefer the selected drawing; otherwise drop the earlier one (B beats A's drop ordering).
      if (idA === selectedId) {
        drop.add(idB);
      } else if (idB === selectedId) {
        drop.add(idA);
        break;
      } else {
        drop.add(idA);
        break;
      }
    }
  }
  const final = new Map<DrawingId, readonly DrawingTextSpec[]>();
  for (const [id, specs] of candidates) {
    if (!drop.has(id)) {
      final.set(id, specs);
    }
  }
  return final;
}

function specsOverlap(
  a: readonly DrawingTextSpec[],
  b: readonly DrawingTextSpec[],
): boolean {
  for (const sa of a) {
    const ax0 = sa.x;
    const ay0 = sa.y;
    const ax1 = ax0 + Math.max(8, sa.text.length * 6);
    const ay1 = ay0 + 12;
    for (const sb of b) {
      const bx0 = sb.x;
      const by0 = sb.y;
      const bx1 = bx0 + Math.max(8, sb.text.length * 6);
      const by1 = by0 + 12;
      if (ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0) {
        return true;
      }
    }
  }
  return false;
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

// `normalizeDrawingDefaults` lives in `./normalize.ts` since Cycle B.3 — the
// helper now returns `{ drawing, warn }` so the controller can drop drawings
// that violate hard invariants (e.g. long-position `sl < entry < tp`).

/**
 * Cycle B.3 — pick a sensible plot-local pixel for a drawing's first
 * anchor / pin / entry.  Used by the dev-hook test path when callers don't
 * pass explicit coords.
 */
function firstAnchorScreenPoint(geom: ScreenGeom): { x: number; y: number } | null {
  switch (geom.kind) {
    case "trendline":
    case "fibRetracement":
    case "rectangle":
    case "ray":
    case "extendedLine":
    case "arrow":
    case "dateRange":
    case "priceRange":
    case "priceDateRange":
    case "parallelChannel":
    case "pitchfork":
    case "gannFan":
    case "ellipse": {
      const a = geom.anchors[0];
      return { x: a.x, y: a.y };
    }
    case "horizontalLine":
    case "verticalLine":
    case "horizontalRay":
    case "text":
      return { x: geom.anchor.x, y: geom.anchor.y };
    case "callout":
      return { x: geom.pin.x, y: geom.pin.y };
    case "longPosition":
    case "shortPosition":
      return { x: geom.entry.x, y: geom.entry.y };
  }
}
