/**
 * Phase 13 Cycle B.3 — drawing-controller dev hooks.
 *
 * `chart.drawings.getDevHooks()` returns this surface. It bypasses pixel
 * hit-testing so Playwright (and unit tests) can deterministically drive
 * handle / body drags, query the active drag state, and read the rendered
 * handle positions of any drawing.
 *
 * **This is NOT part of the Carta SemVer API.** The shape may change between
 * minor versions. Hosts must not depend on it in production code; it exists
 * solely for end-to-end testing scaffolding (the `__cartaTest` namespace in
 * the demo wires it up). Production-bundle cost is ~150 bytes after minify;
 * we deliberately ship one package rather than a separate `@carta/test-hooks`
 * subpackage.
 */
import type { DrawingId } from "./types.js";
import type { HandleKey } from "./render.js";

export interface DragStateSnapshot {
  readonly drawingId: DrawingId;
  readonly mode: "handle" | "body";
  readonly handleKey: HandleKey | null;
  readonly pointerId: number;
  readonly committed: boolean;
}

export interface VisibleHandleInfo {
  /** Anchor index, `'corner-tr' | 'corner-bl'`, or `'time-end'`. */
  readonly key: HandleKey;
  /** Plot-local CSS px. */
  readonly x: number;
  readonly y: number;
}

export interface BeginDragForTestOptions {
  readonly drawingId: DrawingId | string;
  readonly mode: "handle" | "body";
  /** Required for `mode: 'handle'`. Ignored for `mode: 'body'`. */
  readonly handleKey?: HandleKey | null;
  /** Default = 1. Lets tests reuse synthesized pointer ids. */
  readonly pointerId?: number;
  /** Plot-local CSS px. Default = drawing's first-anchor screen position. */
  readonly localX?: number;
  readonly localY?: number;
}

export interface DrawingsDevHooks {
  /**
   * Initiate a synthesized drag bypassing the pixel hit-test.  Returns `false`
   * when the drawing is missing, locked, or another drag is already active.
   * After this call, the test should issue `continueDragForTest(...)` calls
   * to move the drag and finally `endDragForTest()` to commit (or
   * `cancelActiveDrag()` to roll back).
   */
  beginDragForTest(opts: BeginDragForTestOptions): boolean;
  /**
   * Move the in-flight drag to a new plot-local pixel.  Returns `false` if
   * no drag is active.
   */
  continueDragForTest(localX: number, localY: number): boolean;
  /**
   * End the in-flight drag, mirroring real-pointer-up semantics (commits
   * if past the drag threshold).  Returns `false` if no drag is active.
   */
  endDragForTest(): boolean;
  /** Snapshot of the active drag, or `null`. */
  getDragState(): DragStateSnapshot | null;
  /**
   * Force-cancel the in-flight drag, restoring start anchors.  Idempotent.
   * Mirrors the existing `interval:change` rollback path.
   */
  cancelActiveDrag(): void;
  /**
   * Currently rendered handle positions for the given drawing, in
   * plot-local CSS px.  Returns `[]` if the drawing is unselected or has
   * no visible handles.
   */
  visibleHandlesFor(drawingId: DrawingId | string): readonly VisibleHandleInfo[];
  /**
   * Phase 13 Cycle C.3 — force-cancel any active brush capture (mirrors
   * the `pinch-start` and `interval:change` cancel paths).  Idempotent;
   * silently no-ops when no capture is active.
   */
  cancelActiveBrush(): void;
  /**
   * Phase 13 Cycle C.3 — read-only snapshot of the active brush capture.
   * Returns `null` when no capture is active.  `pointCount` is the number
   * of raw pointer points captured so far (post mid-stroke RDP collapses).
   */
  getBrushCaptureState(): { readonly pointerId: number; readonly pointCount: number } | null;
  /**
   * Phase 13 Cycle C.3 — count of live icon sprites currently registered
   * on `drawingsLayer`.  Used by leak assertions after `chart.destroy()`
   * or large add/remove churn.
   */
  spriteRegistrySize(): number;
  /**
   * Phase 13 Cycle C.3 — atlas state for visual-stability assertions.
   * `null` when no atlas has been built yet (no icon ever placed).
   */
  iconAtlasInfo(): { readonly dprBucket: number; readonly cellPx: number; readonly textureCount: number } | null;
}
