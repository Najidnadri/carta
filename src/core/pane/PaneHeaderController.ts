import type { Container } from "pixi.js";
import { Graphics } from "pixi.js";
import type { PaneHeader, PaneHeaderRegion } from "./PaneHeader.js";
import type { Pane } from "./Pane.js";
import type { PaneRect, PaneId } from "./types.js";
import type { Theme } from "../../types.js";

/**
 * Phase 14 Cycle C — DOM-canvas pointer dispatcher for pane headers. Owns
 * the click vs drag-reorder state machine and routes events to the chart's
 * lifecycle (`onChevronClick`, `onGearClick`, `onCloseClick`, `onReorder`,
 * `onDragStart`, `onDragEnd`).
 *
 * Design mirrors `PaneResizeController`: DOM `pointerevents` on the
 * canvas, `setPointerCapture` for the duration of a drag, no Pixi
 * federated events. Routing precedence — the chart-level pointerdown
 * sequence is "divider hit (resize) first, then header hit (this), then
 * drawings, then viewport"; header zones never overlap divider zones,
 * so order matters only when neither fires.
 *
 * Click vs drag disambiguation:
 * - Pointerdown on a BUTTON (chevron / gear / close) → `armed-button`.
 *   Pointerup with movement ≤ 5 px and pointer still over the same button
 *   → fire the button callback. Otherwise cancel (treat as drag-cancel).
 * - Pointerdown on TITLE region (or anywhere else inside the header
 *   that isn't a button) → `armed-title-desktop` (mouse / pen) or
 *   `armed-title-touch` (touch). Touch starts a 600 ms long-press
 *   timer; movement > 5 px before the timer fires aborts (it's a
 *   scroll). Mouse promotes to `dragging` immediately on > 5 px move.
 * - In `dragging`: pointer's Y picks the insertion slot; drop on
 *   pointerup calls `onReorder(paneId, newIndex)`.
 */
export interface PaneHeaderControllerDeps {
  readonly canvas: HTMLCanvasElement;
  readonly headerLayer: Container;
  /** Read-only pane list (top-to-bottom). */
  readonly panes: () => readonly Pane[];
  /** Header instance for each pane id (or `null` for pane without header). */
  readonly headerForPane: (paneId: PaneId) => PaneHeader | null;
  /** Pane rects (plot regions) for the most recent layout. */
  readonly paneRects: () => readonly PaneRect[];
  /** Header rects for the most recent layout. */
  readonly headerRects: () => readonly PaneRect[];
  /** Outer rects (header + plot) for drop-slot computation. */
  readonly outerRects: () => readonly PaneRect[];
  readonly onChevronClick: (paneId: PaneId) => void;
  readonly onGearClick: (paneId: PaneId) => void;
  readonly onCloseClick: (paneId: PaneId) => void;
  /**
   * Called on a successful drop. `targetIndex` is the destination index
   * in the panes list (insertion semantics — value `panes.length` drops
   * the pane at the end).
   */
  readonly onReorder: (paneId: PaneId, targetIndex: number) => void;
  readonly onDragStart: (paneId: PaneId) => void;
  readonly onDragEnd: () => void;
  /**
   * Called when the hovered button changes (or when no button is hovered).
   * Caller invalidates `'layout'` to repaint hover highlights.
   */
  readonly onHoverChange: () => void;
  /** Long-press timer ms — defaults to 600. Test hook. */
  readonly longPressMs?: number;
}

const MOVEMENT_THRESHOLD_PX = 5;
const DEFAULT_LONG_PRESS_MS = 600;

type FsmState =
  | { kind: "idle" }
  | {
      kind: "armed-button";
      pointerId: number;
      startX: number;
      startY: number;
      paneId: PaneId;
      region: Exclude<PaneHeaderRegion, "title">;
    }
  | {
      kind: "armed-title-desktop";
      pointerId: number;
      startX: number;
      startY: number;
      paneId: PaneId;
    }
  | {
      kind: "armed-title-touch";
      pointerId: number;
      startX: number;
      startY: number;
      paneId: PaneId;
      timerId: ReturnType<typeof setTimeout> | null;
    }
  | {
      kind: "dragging";
      pointerId: number;
      paneId: PaneId;
      currentInsertIndex: number;
    };

export class PaneHeaderController {
  private readonly deps: PaneHeaderControllerDeps;
  private readonly attachedListeners: (() => void)[] = [];
  private readonly insertionBar: Graphics;
  private state: FsmState = { kind: "idle" };
  private destroyed = false;
  private hoveredPaneId: PaneId | null = null;
  private hoveredRegion: Exclude<PaneHeaderRegion, "title"> | null = null;
  private readonly longPressMs: number;

  constructor(deps: PaneHeaderControllerDeps) {
    this.deps = deps;
    this.longPressMs = deps.longPressMs ?? DEFAULT_LONG_PRESS_MS;
    this.insertionBar = new Graphics();
    this.insertionBar.visible = false;
    this.deps.headerLayer.addChild(this.insertionBar);
    this.attach();
  }

  /**
   * Phase 14 Cycle C — paint the insertion bar between drop slots while a
   * reorder drag is active. Idempotent + cheap to call every flush.
   * Returns early when no drag is active.
   */
  render(theme: Theme): void {
    if (this.destroyed) {
      return;
    }
    if (this.state.kind !== "dragging") {
      this.insertionBar.visible = false;
      return;
    }
    const outers = this.deps.outerRects();
    if (outers.length === 0) {
      this.insertionBar.visible = false;
      return;
    }
    const idx = Math.max(0, Math.min(this.state.currentInsertIndex, outers.length));
    let y: number;
    let w: number;
    if (idx >= outers.length) {
      const last = outers[outers.length - 1];
      if (last === undefined) {
        return;
      }
      y = last.y + last.h;
      w = last.w;
    } else {
      const r = outers[idx];
      if (r === undefined) {
        return;
      }
      y = r.y;
      w = r.w;
    }
    this.insertionBar.clear()
      .rect(0, y - 1, w, 2)
      .fill({ color: theme.selection, alpha: 0.95 });
    this.insertionBar.visible = true;
  }

  /** Dev/test introspection. */
  isDragging(): boolean {
    return this.state.kind === "dragging";
  }

  /** Dev/test introspection — expose internal FSM state kind. */
  stateKind(): FsmState["kind"] {
    return this.state.kind;
  }

  /**
   * Cancel any active gesture — armed click, armed drag, in-flight drag.
   * Mirrors `PaneResizeController.cancelDrag`. Idempotent.
   */
  cancelDrag(): void {
    if (this.destroyed) {
      return;
    }
    if (this.state.kind === "idle") {
      return;
    }
    const wasDragging = this.state.kind === "dragging";
    const captured = this.state.pointerId;
    if (this.state.kind === "armed-title-touch" && this.state.timerId !== null) {
      clearTimeout(this.state.timerId);
    }
    if (wasDragging) {
      this.deps.onDragEnd();
    }
    this.insertionBar.visible = false;
    this.state = { kind: "idle" };
    if (this.deps.canvas.hasPointerCapture(captured)) {
      this.deps.canvas.releasePointerCapture(captured);
    }
    this.deps.canvas.style.cursor = "";
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    // Cancel any in-flight gesture BEFORE flipping `destroyed` — otherwise
    // `cancelDrag` short-circuits and the state stays in `dragging` /
    // `armed-*` with leaked pointer capture.
    this.cancelDrag();
    this.destroyed = true;
    for (const off of this.attachedListeners) {
      off();
    }
    this.attachedListeners.length = 0;
    this.insertionBar.parent?.removeChild(this.insertionBar);
    this.insertionBar.destroy();
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /**
   * Hit-test the canvas-local `(localX, localY)` against every pane
   * header. Returns `null` if nothing is hit.
   */
  private findHeaderHit(
    e: PointerEvent,
  ): { paneId: PaneId; region: PaneHeaderRegion } | null {
    const rect = this.deps.canvas.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
      return null;
    }
    for (const pane of this.deps.panes()) {
      const header = this.deps.headerForPane(pane.id);
      if (header === null) {
        continue;
      }
      const region = header.hitTest(localX, localY, { pointerType: e.pointerType });
      if (region !== null) {
        return { paneId: pane.id, region };
      }
    }
    return null;
  }

  /** Map pointer Y to insertion index for the drag-reorder drop slot. */
  private dropIndexForPointerY(localY: number): number {
    const outers = this.deps.outerRects();
    const panes = this.deps.panes();
    if (outers.length === 0 || panes.length === 0) {
      return 0;
    }
    // Primary pane stays at index 0 — drop slots are 1..panes.length.
    let chosen = panes.length;
    for (let i = 1; i < panes.length; i += 1) {
      const r = outers[i];
      if (r === undefined) {
        continue;
      }
      if (localY < r.y + r.h / 2) {
        chosen = i;
        break;
      }
    }
    return Math.max(1, chosen);
  }

  private attach(): void {
    const canvas = this.deps.canvas;

    const onPointerDown = (e: PointerEvent): void => {
      if (this.destroyed) {
        return;
      }
      if (this.state.kind !== "idle") {
        return;
      }
      const hit = this.findHeaderHit(e);
      if (hit === null) {
        return;
      }
      const isPrimary = this.deps.panes()[0]?.id === hit.paneId;
      if (hit.region === "title") {
        // Title region: arm a drag-reorder. Primary pane never reorders.
        if (isPrimary) {
          return;
        }
        canvas.setPointerCapture(e.pointerId);
        const isTouch = e.pointerType === "touch";
        if (isTouch) {
          const timerId = setTimeout(() => {
            // Long-press fired — promote to dragging if we're still armed.
            if (
              this.state.kind === "armed-title-touch" &&
              this.state.pointerId === e.pointerId
            ) {
              this.startDragging(this.state.paneId, e.pointerId);
            }
          }, this.longPressMs);
          this.state = {
            kind: "armed-title-touch",
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            paneId: hit.paneId,
            timerId,
          };
        } else {
          this.state = {
            kind: "armed-title-desktop",
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            paneId: hit.paneId,
          };
        }
        canvas.style.cursor = "grab";
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Button region: arm a click. Captured so pointermove off the button
      // can short-circuit the click without bubbling.
      canvas.setPointerCapture(e.pointerId);
      this.state = {
        kind: "armed-button",
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        paneId: hit.paneId,
        region: hit.region,
      };
      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerMove = (e: PointerEvent): void => {
      if (this.destroyed) {
        return;
      }
      // Hover bookkeeping for buttons (only when not in any active gesture).
      if (this.state.kind === "idle") {
        const hit = this.findHeaderHit(e);
        const region = hit === null || hit.region === "title" ? null : hit.region;
        const paneId = hit === null ? null : hit.paneId;
        const headerChanged =
          paneId !== this.hoveredPaneId || region !== this.hoveredRegion;
        if (headerChanged) {
          if (this.hoveredPaneId !== null) {
            const prev = this.deps.headerForPane(this.hoveredPaneId);
            prev?.setHover(null);
          }
          if (paneId !== null && region !== null) {
            const next = this.deps.headerForPane(paneId);
            next?.setHover(region);
          }
          this.hoveredPaneId = paneId;
          this.hoveredRegion = region;
          this.deps.onHoverChange();
        }
        return;
      }
      if (e.pointerId !== this.state.pointerId) {
        return;
      }
      const cur = this.state;
      if (cur.kind === "dragging") {
        const rect = canvas.getBoundingClientRect();
        const localY = e.clientY - rect.top;
        const next = this.dropIndexForPointerY(localY);
        if (next !== cur.currentInsertIndex) {
          this.state = { ...cur, currentInsertIndex: next };
          this.deps.onHoverChange();
        }
        return;
      }
      // Armed states all carry start coords — compute movement once.
      const dx = e.clientX - cur.startX;
      const dy = e.clientY - cur.startY;
      const dist2 = dx * dx + dy * dy;
      const beyondThreshold = dist2 > MOVEMENT_THRESHOLD_PX * MOVEMENT_THRESHOLD_PX;
      if (cur.kind === "armed-button") {
        if (beyondThreshold) {
          // Movement past threshold cancels the click — release capture.
          this.cancelDrag();
        }
        return;
      }
      if (cur.kind === "armed-title-desktop") {
        if (beyondThreshold) {
          this.startDragging(cur.paneId, cur.pointerId);
        }
        return;
      }
      // Final remaining state is `armed-title-touch`.
      if (beyondThreshold) {
        if (cur.timerId !== null) {
          clearTimeout(cur.timerId);
        }
        // Movement before long-press fires aborts (it's a scroll, not a drag).
        this.cancelDrag();
      }
    };

    const onPointerUp = (e: PointerEvent): void => {
      if (this.destroyed) {
        return;
      }
      if (this.state.kind === "idle") {
        return;
      }
      if (e.pointerId !== this.state.pointerId) {
        return;
      }
      const wasState = this.state;
      // Release capture before invoking callbacks so reentrant handlers
      // (e.g. removePane handler that triggers another pointer event) see
      // a clean state.
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
      canvas.style.cursor = "";

      if (wasState.kind === "armed-button") {
        // Click — fire callback.
        this.state = { kind: "idle" };
        const { paneId, region } = wasState;
        if (region === "chevron") {
          this.deps.onChevronClick(paneId);
        } else if (region === "gear") {
          this.deps.onGearClick(paneId);
        } else {
          // Only remaining region is "close".
          this.deps.onCloseClick(paneId);
        }
        return;
      }
      if (wasState.kind === "armed-title-desktop" || wasState.kind === "armed-title-touch") {
        if (wasState.kind === "armed-title-touch" && wasState.timerId !== null) {
          clearTimeout(wasState.timerId);
        }
        this.state = { kind: "idle" };
        return;
      }
      // Final remaining state: `dragging`. Drop into the reorder branch.
      const targetIndex = wasState.currentInsertIndex;
      const paneId = wasState.paneId;
      this.deps.onDragEnd();
      this.insertionBar.visible = false;
      this.state = { kind: "idle" };
      this.deps.onReorder(paneId, targetIndex);
    };

    const onPointerCancel = (e: PointerEvent): void => {
      if (this.state.kind === "idle") {
        return;
      }
      if (e.pointerId !== this.state.pointerId) {
        return;
      }
      this.cancelDrag();
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && this.state.kind !== "idle") {
        this.cancelDrag();
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    if (typeof globalThis.window !== "undefined") {
      globalThis.window.addEventListener("keydown", onKeyDown);
    }
    this.attachedListeners.push(
      () => { canvas.removeEventListener("pointerdown", onPointerDown); },
      () => { canvas.removeEventListener("pointermove", onPointerMove); },
      () => { canvas.removeEventListener("pointerup", onPointerUp); },
      () => { canvas.removeEventListener("pointercancel", onPointerCancel); },
      () => {
        if (typeof globalThis.window !== "undefined") {
          globalThis.window.removeEventListener("keydown", onKeyDown);
        }
      },
    );
  }

  private startDragging(paneId: PaneId, pointerId: number): void {
    this.state = {
      kind: "dragging",
      pointerId,
      paneId,
      currentInsertIndex: this.dropIndexForPaneId(paneId),
    };
    this.deps.onDragStart(paneId);
    this.deps.canvas.style.cursor = "grabbing";
    this.deps.onHoverChange();
  }

  private dropIndexForPaneId(paneId: PaneId): number {
    const panes = this.deps.panes();
    const idx = panes.findIndex((p) => p.id === paneId);
    return idx === -1 ? panes.length : idx;
  }
}
