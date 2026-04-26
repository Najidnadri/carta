import type { Container} from "pixi.js";
import { Graphics } from "pixi.js";
import type { Pane } from "./Pane.js";
import type { PaneRect } from "./types.js";
import type { Theme } from "../../types.js";

/**
 * Phase 14 Cycle A — divider-drag controller. Listens for pointerdown on
 * divider zones between adjacent visible panes, then captures pointermove
 * to resize the two neighbours.
 *
 * Hit zones:
 * - Mouse / pen: 8 CSS px tall (4 above + 4 below the divider line).
 * - Touch: 24 CSS px tall (WCAG 2.5.5 floor — overlaps 12 px into adjacent
 *   panes; that overlap is fine because the chart-level pointer-down
 *   intercept routes the gesture to this controller before drawings /
 *   crosshair / viewport see it).
 */
export interface PaneResizeControllerDeps {
  readonly canvas: HTMLCanvasElement;
  readonly separatorLayer: Container;
  /** Read-only pane list and their rects, top-to-bottom. */
  readonly panes: () => readonly Pane[];
  readonly paneRects: () => readonly PaneRect[];
  /**
   * Notify the chart that the pane heights changed. Caller invalidates
   * `'layout'` and emits `pane:resize`.
   */
  readonly onResize: (
    aboveId: string,
    aboveHeight: number,
    belowId: string,
    belowHeight: number,
  ) => void;
}

const MOUSE_HIT_HALF_HEIGHT = 4;
const TOUCH_HIT_HALF_HEIGHT = 12;

interface DragState {
  readonly aboveIndex: number;
  readonly belowIndex: number;
  readonly aboveStartH: number;
  readonly belowStartH: number;
  readonly belowStartTop: number;
  readonly startY: number;
  readonly aboveMin: number;
  readonly belowMin: number;
  readonly pointerId: number;
}

export class PaneResizeController {
  private readonly deps: PaneResizeControllerDeps;
  private readonly separators: Graphics[] = [];
  private readonly attachedListeners: (() => void)[] = [];
  private dragState: DragState | null = null;
  private destroyed = false;

  constructor(deps: PaneResizeControllerDeps) {
    this.deps = deps;
    this.attach();
  }

  /**
   * Phase 14 Cycle A — render the visible separator lines between panes.
   * Called from the chart's `flush` after pane rects are applied. Returns
   * the bottoms of the panes that have a divider drawn directly below
   * them (used internally for hit-test).
   */
  render(theme: Theme): void {
    if (this.destroyed) {
      return;
    }
    const rects = this.deps.paneRects();
    const panes = this.deps.panes();
    // Allocate / free separator graphics to match (panes - 1) visible
    // separators (skipping hidden panes).
    const visiblePairs: { aboveIdx: number; belowIdx: number; rect: PaneRect; aboveRect: PaneRect }[] = [];
    for (let i = 0; i < panes.length - 1; i += 1) {
      const a = panes[i];
      const b = panes[i + 1];
      const ra = rects[i];
      const rb = rects[i + 1];
      if (a === undefined || b === undefined || ra === undefined || rb === undefined) {
        continue;
      }
      if (a.hidden || b.hidden) {
        continue;
      }
      if (ra.h <= 0 || rb.h <= 0) {
        continue;
      }
      visiblePairs.push({ aboveIdx: i, belowIdx: i + 1, rect: rb, aboveRect: ra });
    }

    while (this.separators.length < visiblePairs.length) {
      const g = new Graphics();
      this.deps.separatorLayer.addChild(g);
      this.separators.push(g);
    }
    while (this.separators.length > visiblePairs.length) {
      const g = this.separators.pop();
      g?.parent?.removeChild(g);
      g?.destroy();
    }

    for (let i = 0; i < visiblePairs.length; i += 1) {
      const pair = visiblePairs[i];
      const g = this.separators[i];
      if (pair === undefined || g === undefined) {
        continue;
      }
      const dividerY = pair.rect.y;
      // Phase 14 Cycle A — use the dedicated `paneSeparator` color so the
      // 1 px divider stroke meets the 3:1 contrast floor against the chart
      // background regardless of theme. Falls back to `frame` for hosts
      // running pre-cycle-A theme objects without the new field.
      const color =
        typeof theme.paneSeparator === "number" ? theme.paneSeparator : theme.frame;
      g.clear()
        .moveTo(pair.aboveRect.x, dividerY + 0.5)
        .lineTo(pair.aboveRect.x + pair.aboveRect.w, dividerY + 0.5)
        .stroke({ width: 1, color, alpha: 1 });
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const off of this.attachedListeners) {
      off();
    }
    this.attachedListeners.length = 0;
    for (const g of this.separators) {
      g.parent?.removeChild(g);
      g.destroy();
    }
    this.separators.length = 0;
    this.dragState = null;
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private attach(): void {
    const onPointerDown = (e: PointerEvent): void => {
      if (this.dragState !== null) {
        return;
      }
      const hit = this.findDividerHit(e);
      if (hit === null) {
        return;
      }
      const panes = this.deps.panes();
      const rects = this.deps.paneRects();
      const above = panes[hit.aboveIndex];
      const below = panes[hit.belowIndex];
      const aboveRect = rects[hit.aboveIndex];
      const belowRect = rects[hit.belowIndex];
      if (above === undefined || below === undefined || aboveRect === undefined || belowRect === undefined) {
        return;
      }
      this.dragState = {
        aboveIndex: hit.aboveIndex,
        belowIndex: hit.belowIndex,
        aboveStartH: aboveRect.h,
        belowStartH: belowRect.h,
        belowStartTop: belowRect.y,
        startY: e.clientY,
        aboveMin: above.minHeight,
        belowMin: below.minHeight,
        pointerId: e.pointerId,
      };
      this.deps.canvas.setPointerCapture(e.pointerId);
      this.deps.canvas.style.cursor = "ns-resize";
      e.preventDefault();
      e.stopPropagation();
    };
    const onPointerMove = (e: PointerEvent): void => {
      if (this.dragState === null) {
        if (this.findDividerHit(e) !== null) {
          this.deps.canvas.style.cursor = "ns-resize";
        } else if (this.deps.canvas.style.cursor === "ns-resize") {
          this.deps.canvas.style.cursor = "";
        }
        return;
      }
      if (e.pointerId !== this.dragState.pointerId) {
        return;
      }
      const dy = e.clientY - this.dragState.startY;
      // Move the divider by `dy`. Clamp so neither neighbour falls below its minHeight.
      let nextAbove = this.dragState.aboveStartH + dy;
      let nextBelow = this.dragState.belowStartH - dy;
      if (nextAbove < this.dragState.aboveMin) {
        const overflow = this.dragState.aboveMin - nextAbove;
        nextAbove = this.dragState.aboveMin;
        nextBelow -= overflow;
      }
      if (nextBelow < this.dragState.belowMin) {
        const overflow = this.dragState.belowMin - nextBelow;
        nextBelow = this.dragState.belowMin;
        nextAbove -= overflow;
      }
      const panes = this.deps.panes();
      const above = panes[this.dragState.aboveIndex];
      const below = panes[this.dragState.belowIndex];
      if (above === undefined || below === undefined) {
        return;
      }
      this.deps.onResize(String(above.id), Math.floor(nextAbove), String(below.id), Math.floor(nextBelow));
      e.preventDefault();
    };
    const endDrag = (e: PointerEvent): void => {
      if (this.dragState === null) {
        return;
      }
      if (e.pointerId !== this.dragState.pointerId) {
        return;
      }
      this.deps.canvas.releasePointerCapture(e.pointerId);
      this.deps.canvas.style.cursor = "";
      this.dragState = null;
    };
    this.deps.canvas.addEventListener("pointerdown", onPointerDown);
    this.deps.canvas.addEventListener("pointermove", onPointerMove);
    this.deps.canvas.addEventListener("pointerup", endDrag);
    this.deps.canvas.addEventListener("pointercancel", endDrag);
    this.attachedListeners.push(
      () => { this.deps.canvas.removeEventListener("pointerdown", onPointerDown); },
      () => { this.deps.canvas.removeEventListener("pointermove", onPointerMove); },
      () => { this.deps.canvas.removeEventListener("pointerup", endDrag); },
      () => { this.deps.canvas.removeEventListener("pointercancel", endDrag); },
    );
  }

  private findDividerHit(e: PointerEvent): { aboveIndex: number; belowIndex: number } | null {
    const rect = this.deps.canvas.getBoundingClientRect();
    const localY = e.clientY - rect.top;
    const isTouch = e.pointerType === "touch";
    const halfHeight = isTouch ? TOUCH_HIT_HALF_HEIGHT : MOUSE_HIT_HALF_HEIGHT;
    const panes = this.deps.panes();
    const rects = this.deps.paneRects();
    for (let i = 0; i < panes.length - 1; i += 1) {
      const a = panes[i];
      const b = panes[i + 1];
      const ra = rects[i];
      const rb = rects[i + 1];
      if (a === undefined || b === undefined || ra === undefined || rb === undefined) {
        continue;
      }
      if (a.hidden || b.hidden) {
        continue;
      }
      if (ra.h <= 0 || rb.h <= 0) {
        continue;
      }
      const dividerY = rb.y; // top of the lower pane
      if (Math.abs(localY - dividerY) <= halfHeight) {
        return { aboveIndex: i, belowIndex: i + 1 };
      }
    }
    return null;
  }
}
