import { Rectangle, type Container, type FederatedPointerEvent } from "pixi.js";
import {
  computePannedWindow,
  computeShiftPannedWindow,
  computeZoomedWindow,
  type WindowSnapshot,
} from "./ViewportMath.js";
import type { PlotRect } from "../render/Renderer.js";
import { asTime, type KineticOptions, type ViewportOptions, type WindowInput } from "../../types.js";

const DEFAULT_ZOOM_FACTOR = 0.88;
const DEFAULT_SHIFT_PAN_FRACTION = 0.1;
const DEFAULT_KINETIC_DECAY_PER_SEC = 5;
const DEFAULT_MIN_FLING_VELOCITY_PX_PER_MS = 0.1;
const VELOCITY_WINDOW_MS = 80;
const MAX_VELOCITY_SAMPLES = 64;
/** Per-pointer Euclidean displacement gate before pinch math fires. */
const PINCH_GATE_PX = 6;
/** Long-press timer duration, touch only. */
const LONG_PRESS_MS = 350;
/** Long-press cancellation deadzone — Euclidean displacement from down. */
const LONG_PRESS_DEADZONE_PX = 8;

interface ResolvedKineticOptions {
  readonly decayPerSec: number;
  readonly minFlingVelocityPxPerMs: number;
}

interface ResolvedOptions {
  readonly minIntervalDuration: number | undefined;
  readonly maxWindowDuration: number;
  readonly zoomFactor: number;
  readonly shiftPanFraction: number;
  readonly kinetic: ResolvedKineticOptions;
}

type PointerType = "mouse" | "pen" | "touch";

interface PointerState {
  readonly id: number;
  readonly type: PointerType;
  readonly startGlobalX: number;
  readonly startGlobalY: number;
  lastGlobalX: number;
  lastGlobalY: number;
  readonly startSnapshot: WindowSnapshot;
  readonly startedAt: number;
  readonly samples: VelocitySample[];
  cancelled: boolean;
}

interface VelocitySample {
  readonly t: number;
  readonly x: number;
}

export interface ViewportControllerDeps {
  readonly stage: Container;
  readonly canvas: HTMLCanvasElement;
  readonly snapshot: () => WindowSnapshot;
  readonly applyWindow: (win: WindowInput) => void;
  readonly plotRect: () => PlotRect;
  readonly options?: ViewportOptions | undefined;
  readonly rafFns?:
    | {
        readonly request: (cb: FrameRequestCallback) => number;
        readonly cancel: (id: number) => void;
        readonly now: () => number;
      }
    | undefined;
  /**
   * Phase 09 long-press tracking-mode entry. Fires once when a touch pointer
   * has been stationary (within `LONG_PRESS_DEADZONE_PX`) for `LONG_PRESS_MS`.
   * Coordinates are plot-local (already offset by `plotRect.x/y`). The host is
   * expected to call `setTrackingMode(true)` in response.
   */
  readonly onLongPress?: (plotLocalX: number, plotLocalY: number) => void;
  /**
   * Phase 09 tracking-mode pointer routing. Fires for each single-finger touch
   * `globalpointermove` while `setTrackingMode(true)` — instead of panning,
   * the controller forwards the pointer position to the host so the crosshair
   * can update. Coordinates are plot-local.
   */
  readonly onTrackingMove?: (plotLocalX: number, plotLocalY: number) => void;
  /**
   * Phase 09 timer factory. Defaults to `setTimeout`/`clearTimeout`. Override
   * in tests to drive long-press deterministically with `vi.useFakeTimers`.
   */
  readonly timerFns?:
    | {
        readonly setTimeout: (cb: () => void, ms: number) => number;
        readonly clearTimeout: (id: number) => void;
      }
    | undefined;
}

type GestureMode = "idle" | "pan" | "pinch";

interface PinchPair {
  readonly idA: number;
  readonly idB: number;
  startSeparation: number;
  startCentroidX: number;
  startSnapshot: WindowSnapshot;
  gateCrossed: boolean;
}

interface LongPressArm {
  readonly pointerId: number;
  readonly startGlobalX: number;
  readonly startGlobalY: number;
  timerId: number;
}

function resolveKineticOptions(opts: KineticOptions | undefined): ResolvedKineticOptions {
  return {
    decayPerSec:
      opts?.decayPerSec !== undefined && Number.isFinite(opts.decayPerSec) && opts.decayPerSec > 0
        ? opts.decayPerSec
        : DEFAULT_KINETIC_DECAY_PER_SEC,
    minFlingVelocityPxPerMs:
      opts?.minFlingVelocityPxPerMs !== undefined &&
      Number.isFinite(opts.minFlingVelocityPxPerMs) &&
      opts.minFlingVelocityPxPerMs > 0
        ? opts.minFlingVelocityPxPerMs
        : DEFAULT_MIN_FLING_VELOCITY_PX_PER_MS,
  };
}

function resolveOptions(opts: ViewportOptions | undefined): ResolvedOptions {
  return {
    minIntervalDuration:
      opts?.minIntervalDuration !== undefined &&
      Number.isFinite(opts.minIntervalDuration) &&
      opts.minIntervalDuration > 0
        ? opts.minIntervalDuration
        : undefined,
    maxWindowDuration:
      opts?.maxWindowDuration !== undefined &&
      Number.isFinite(opts.maxWindowDuration) &&
      opts.maxWindowDuration > 0
        ? opts.maxWindowDuration
        : Number.POSITIVE_INFINITY,
    zoomFactor:
      opts?.zoomFactor !== undefined && Number.isFinite(opts.zoomFactor) && opts.zoomFactor > 0 && opts.zoomFactor < 1
        ? opts.zoomFactor
        : DEFAULT_ZOOM_FACTOR,
    shiftPanFraction:
      opts?.shiftPanFraction !== undefined &&
      Number.isFinite(opts.shiftPanFraction) &&
      opts.shiftPanFraction > 0
        ? opts.shiftPanFraction
        : DEFAULT_SHIFT_PAN_FRACTION,
    kinetic: resolveKineticOptions(opts?.kinetic),
  };
}

/**
 * ViewportController — translates pointer / wheel / touch into window
 * mutations. Pointer flow goes through Pixi's federated events
 * (`globalpointermove` + `pointerupoutside`); wheel is a native
 * `{passive:false}` listener on the canvas so `preventDefault()` works.
 *
 * Kinetic scroll runs on a dedicated RAF loop, dt-aware via exponential
 * decay, sampled from a sliding 80ms velocity window, touch-only.
 *
 * Gestures are tracked via an explicit `mode: 'idle' | 'pan' | 'pinch'`.
 * `'pinch'` is entered when a second pointer arrives; pinch math runs once
 * both pointers have moved past `PINCH_GATE_PX` from their start, composing
 * `computeZoomedWindow` (anchored at the start-centroid time) with
 * `computePannedWindow` (centroid delta). Long-press tracking mode is armed
 * on the first touch pointer; on fire, `deps.onLongPress` is invoked. While
 * `trackingMode === true`, single-finger moves are routed to
 * `deps.onTrackingMove` instead of `applyPanFromPointer`.
 */
export class ViewportController {
  private readonly stage: Container;
  private readonly canvas: HTMLCanvasElement;
  private readonly snapshot: () => WindowSnapshot;
  private readonly applyWindow: (win: WindowInput) => void;
  private readonly plotRect: () => PlotRect;
  private readonly options: ResolvedOptions;
  private readonly raf: (cb: FrameRequestCallback) => number;
  private readonly caf: (id: number) => void;
  private readonly now: () => number;
  private readonly onLongPress: ((plotLocalX: number, plotLocalY: number) => void) | undefined;
  private readonly onTrackingMove: ((plotLocalX: number, plotLocalY: number) => void) | undefined;
  private readonly timerSet: (cb: () => void, ms: number) => number;
  private readonly timerClear: (id: number) => void;

  private readonly activePointers = new Map<number, PointerState>();
  private activePanPointerId: number | null = null;
  private mode: GestureMode = "idle";
  private pinchPair: PinchPair | null = null;
  private longPressArm: LongPressArm | null = null;
  private trackingMode = false;
  private disposed = false;

  private kineticRafId = 0;
  private kineticVelocityPxPerMs = 0;
  private kineticLastT = 0;

  constructor(deps: ViewportControllerDeps) {
    this.stage = deps.stage;
    this.canvas = deps.canvas;
    this.snapshot = deps.snapshot;
    this.applyWindow = deps.applyWindow;
    this.plotRect = deps.plotRect;
    this.options = resolveOptions(deps.options);
    this.raf = deps.rafFns?.request ?? ((cb): number => requestAnimationFrame(cb));
    this.caf = deps.rafFns?.cancel ?? ((id): void => { cancelAnimationFrame(id); });
    this.now = deps.rafFns?.now ?? ((): number => performance.now());
    this.onLongPress = deps.onLongPress;
    this.onTrackingMove = deps.onTrackingMove;
    this.timerSet =
      deps.timerFns?.setTimeout ??
      ((cb, ms): number => globalThis.setTimeout(cb, ms) as unknown as number);
    this.timerClear =
      deps.timerFns?.clearTimeout ??
      ((id): void => { globalThis.clearTimeout(id); });

    this.stage.eventMode = "static";
    this.stage.hitArea = this.asScreenHitArea();

    this.stage.on("pointerdown", this.onPointerDown);
    this.stage.on("globalpointermove", this.onPointerMove);
    this.stage.on("pointerup", this.onPointerEnd);
    this.stage.on("pointerupoutside", this.onPointerEnd);
    this.stage.on("pointercancel", this.onPointerEnd);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });

    if (typeof globalThis.window !== "undefined") {
      globalThis.window.addEventListener("blur", this.onWindowBlur);
    }
    if (typeof globalThis.document !== "undefined") {
      globalThis.document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  isKineticActive(): boolean {
    return this.kineticRafId !== 0;
  }

  stopKinetic(): void {
    this.cancelKineticRaf();
  }

  /**
   * Called by `TimeSeriesChart` after a resize so the stage hit-area stays
   * aligned with the new canvas dimensions.
   */
  syncHitArea(): void {
    if (this.disposed) {
      return;
    }
    this.stage.hitArea = this.asScreenHitArea();
  }

  /**
   * Phase 09 — flips the controller into tracking mode. While tracking,
   * single-finger touch moves are forwarded to `deps.onTrackingMove` instead
   * of panning the window. Idempotent. Called by `TimeSeriesChart` on
   * long-press fire and on `exitTrackingMode`.
   */
  setTrackingMode(on: boolean): void {
    if (this.disposed || this.trackingMode === on) {
      return;
    }
    this.trackingMode = on;
    if (on) {
      this.cancelLongPressTimer();
      this.activePanPointerId = null;
      if (this.mode === "pan") {
        this.mode = "idle";
      }
    } else {
      this.routeGesture();
    }
  }

  /** Dev/test introspection: is tracking mode currently on? */
  isTrackingMode(): boolean {
    return this.trackingMode;
  }

  /**
   * Phase 09 — number of pointers currently down on the chart. Used by the
   * public `enterTrackingMode` API to reject programmatic entry while a
   * multi-pointer gesture (pinch / two-finger pan) is in flight.
   */
  activePointerCount(): number {
    return this.activePointers.size;
  }

  destroy(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelKineticRaf();
    this.cancelLongPressTimer();
    this.activePointers.clear();
    this.activePanPointerId = null;
    this.mode = "idle";
    this.pinchPair = null;
    this.trackingMode = false;

    this.stage.off("pointerdown", this.onPointerDown);
    this.stage.off("globalpointermove", this.onPointerMove);
    this.stage.off("pointerup", this.onPointerEnd);
    this.stage.off("pointerupoutside", this.onPointerEnd);
    this.stage.off("pointercancel", this.onPointerEnd);
    this.canvas.removeEventListener("wheel", this.onWheel);

    if (typeof globalThis.window !== "undefined") {
      globalThis.window.removeEventListener("blur", this.onWindowBlur);
    }
    if (typeof globalThis.document !== "undefined") {
      globalThis.document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  private readonly onPointerDown = (e: FederatedPointerEvent): void => {
    if (this.disposed) {
      return;
    }
    this.cancelKineticRaf();
    const type = e.pointerType as PointerType;
    const sampleT = this.eventTime(e);
    const state: PointerState = {
      id: e.pointerId,
      type,
      startGlobalX: e.global.x,
      startGlobalY: e.global.y,
      lastGlobalX: e.global.x,
      lastGlobalY: e.global.y,
      startSnapshot: this.snapshot(),
      startedAt: sampleT,
      samples: [{ t: sampleT, x: e.global.x }],
      cancelled: false,
    };
    this.activePointers.set(e.pointerId, state);
    // Long-press is touch-only, single-pointer, only when not already tracking.
    // A second pointerdown cancels the timer (we're now in pinch territory).
    if (this.activePointers.size === 1) {
      if (!this.trackingMode && type === "touch") {
        this.armLongPress(e.pointerId, e.global.x, e.global.y);
      }
    } else {
      this.cancelLongPressTimer();
    }
    this.routeGesture();
  };

  private readonly onPointerMove = (e: FederatedPointerEvent): void => {
    if (this.disposed) {
      return;
    }
    const state = this.activePointers.get(e.pointerId);
    if (state === undefined) {
      return;
    }
    state.lastGlobalX = e.global.x;
    state.lastGlobalY = e.global.y;
    const sampleT = this.eventTime(e);
    state.samples.push({ t: sampleT, x: e.global.x });
    while (state.samples.length > MAX_VELOCITY_SAMPLES) {
      state.samples.shift();
    }
    // Cancel long-press if the pointer drifts past the deadzone.
    if (this.longPressArm !== null && this.longPressArm.pointerId === e.pointerId) {
      const dx = e.global.x - this.longPressArm.startGlobalX;
      const dy = e.global.y - this.longPressArm.startGlobalY;
      if (Math.hypot(dx, dy) >= LONG_PRESS_DEADZONE_PX) {
        this.cancelLongPressTimer();
      }
    }
    // Tracking mode: single-finger touch routes to crosshair, not pan.
    if (
      this.trackingMode &&
      this.activePointers.size === 1 &&
      state.type === "touch" &&
      this.onTrackingMove !== undefined
    ) {
      const plot = this.plotRect();
      this.onTrackingMove(e.global.x - plot.x, e.global.y - plot.y);
      return;
    }
    if (state.cancelled) {
      return;
    }
    // Pinch: any pointer that's part of the captured pair drives pinch math.
    // Math only fires once BOTH pointers have moved past `PINCH_GATE_PX` from
    // their pointer-down position. Once gate-crossed it stays crossed for the
    // rest of the gesture.
    if (this.mode === "pinch" && this.pinchPair !== null) {
      const pair = this.pinchPair;
      if (e.pointerId === pair.idA || e.pointerId === pair.idB) {
        if (!pair.gateCrossed) {
          const a = this.activePointers.get(pair.idA);
          const b = this.activePointers.get(pair.idB);
          if (a !== undefined && b !== undefined) {
            const dispA = Math.hypot(a.lastGlobalX - a.startGlobalX, a.lastGlobalY - a.startGlobalY);
            const dispB = Math.hypot(b.lastGlobalX - b.startGlobalX, b.lastGlobalY - b.startGlobalY);
            if (dispA >= PINCH_GATE_PX && dispB >= PINCH_GATE_PX) {
              pair.gateCrossed = true;
            }
          }
        }
        if (pair.gateCrossed) {
          this.applyPinch();
        }
      }
      return;
    }
    if (this.activePanPointerId === e.pointerId && this.activePointers.size === 1) {
      this.applyPanFromPointer(state);
    }
  };

  private eventTime(e: FederatedPointerEvent): number {
    const native = e.nativeEvent as { timeStamp?: number } | null | undefined;
    const ts = native?.timeStamp;
    if (typeof ts === "number" && Number.isFinite(ts)) {
      return ts;
    }
    return this.now();
  }

  private readonly onPointerEnd = (e: FederatedPointerEvent): void => {
    if (this.disposed) {
      return;
    }
    const state = this.activePointers.get(e.pointerId);
    this.activePointers.delete(e.pointerId);
    if (this.longPressArm !== null && this.longPressArm.pointerId === e.pointerId) {
      this.cancelLongPressTimer();
    }
    if (state === undefined) {
      this.routeGesture();
      return;
    }
    const wasPanPointer = this.activePanPointerId === e.pointerId;
    if (wasPanPointer) {
      this.activePanPointerId = null;
      if (!state.cancelled && state.type === "touch" && this.activePointers.size === 0 && !this.trackingMode) {
        this.maybeStartKinetic(state);
      }
    }
    this.routeGesture();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (this.disposed) {
      return;
    }
    e.preventDefault();
    this.cancelKineticRaf();
    const snap = this.snapshot();
    const plot = this.plotRect();
    if (e.shiftKey) {
      const direction = Math.sign(e.deltaY);
      if (direction === 0) {
        return;
      }
      const next = computeShiftPannedWindow(snap, direction, this.options.shiftPanFraction);
      this.applyWindow({ startTime: next.startTime, endTime: next.endTime });
      return;
    }
    if (plot.w <= 0) {
      return;
    }
    const sign = Math.sign(e.deltaY);
    if (sign === 0) {
      return;
    }
    const factor = sign > 0 ? 1 / this.options.zoomFactor : this.options.zoomFactor;
    const rect = this.canvas.getBoundingClientRect();
    const localX = rect.width > 0 ? e.clientX - rect.left : 0;
    const anchorPlotX = Math.max(0, Math.min(plot.w, localX - plot.x));
    const spanMs = Number(snap.endTime) - Number(snap.startTime);
    const anchorTime = asTime(Number(snap.startTime) + (anchorPlotX / plot.w) * spanMs);
    const next = computeZoomedWindow(snap, anchorTime, factor, {
      minIntervalDuration: this.options.minIntervalDuration,
      maxWindowDuration: this.options.maxWindowDuration,
    });
    this.applyWindow({ startTime: next.startTime, endTime: next.endTime });
  };

  private readonly onWindowBlur = (): void => {
    this.endAllDrags();
  };

  private readonly onVisibilityChange = (): void => {
    if (globalThis.document.hidden) {
      this.endAllDrags();
      this.cancelKineticRaf();
    }
  };

  private routeGesture(): void {
    const size = this.activePointers.size;
    if (size === 0) {
      this.mode = "idle";
      this.pinchPair = null;
      this.activePanPointerId = null;
      return;
    }
    if (size === 1) {
      // A finger lifted out of pinch → drop pinch state. The remaining
      // pointer does not promote to pan; user must lift + re-down to drag,
      // matching TradingView/MetaTrader behavior.
      if (this.mode === "pinch") {
        this.mode = "idle";
        this.pinchPair = null;
        this.activePanPointerId = null;
        return;
      }
      if (this.trackingMode) {
        // No pan in tracking mode; pointer moves are routed to the crosshair.
        this.activePanPointerId = null;
        return;
      }
      const [first] = this.activePointers.values();
      if (first !== undefined && this.activePanPointerId === null) {
        this.activePanPointerId = first.id;
        this.mode = "pan";
      }
      return;
    }
    // size >= 2 → enter pinch on the first two pointers (id-order from the
    // Map's insertion order = pointerdown order). Third+ fingers are tracked
    // for cleanup but not consumed by the pinch handler. Snapshot, separation,
    // centroid are captured at second-pointer-down so the first move that
    // crosses the per-pointer 6 px gate has a real delta to compute against.
    if (this.mode !== "pinch") {
      const ids = [...this.activePointers.keys()].slice(0, 2);
      const id0 = ids[0];
      const id1 = ids[1];
      if (id0 === undefined || id1 === undefined) {
        return;
      }
      const a = this.activePointers.get(id0);
      const b = this.activePointers.get(id1);
      if (a === undefined || b === undefined) {
        return;
      }
      this.pinchPair = {
        idA: id0,
        idB: id1,
        startSeparation: Math.hypot(a.lastGlobalX - b.lastGlobalX, a.lastGlobalY - b.lastGlobalY),
        startCentroidX: (a.lastGlobalX + b.lastGlobalX) / 2,
        startSnapshot: this.snapshot(),
        gateCrossed: false,
      };
      this.mode = "pinch";
      this.activePanPointerId = null;
      this.cancelLongPressTimer();
    }
  }

  private applyPanFromPointer(state: PointerState): void {
    const plot = this.plotRect();
    if (plot.w <= 0) {
      return;
    }
    const dxPx = state.lastGlobalX - state.startGlobalX;
    const win = computePannedWindow(state.startSnapshot, dxPx, plot.w);
    this.applyWindow({ startTime: win.startTime, endTime: win.endTime });
  }

  /**
   * Pinch math — single-formula form that directly enforces the invariant:
   * the bar at the start-centroid TIME renders at the live-centroid PLOT-X
   * after the update.
   *
   * Given:
   *   factor   = startSeparation / liveSeparation
   *   newSpan  = factor * startSpan        (clamped to [minWidth, maxWidth])
   *   T*       = the time corresponding to the start centroid in the START window
   *            = startTime + (startCentroidPlotX / plot.w) * startSpan
   *   X_live   = live-centroid plot-x (clamped to [0, plot.w])
   * the new window [newStart, newEnd] satisfies T* → X_live, i.e.
   *   newStart = T* - (X_live / plot.w) * newSpan
   *
   * This is mathematically equivalent to "zoom around startCentroid then pan
   * by centroidDx" but is harder to bias by floating-point composition.
   * Idempotent against the gesture-start.
   */
  private applyPinch(): void {
    const pair = this.pinchPair;
    if (pair?.gateCrossed !== true) {
      return;
    }
    const a = this.activePointers.get(pair.idA);
    const b = this.activePointers.get(pair.idB);
    if (a === undefined || b === undefined) {
      return;
    }
    const plot = this.plotRect();
    if (plot.w <= 0) {
      return;
    }
    const sepNow = Math.hypot(a.lastGlobalX - b.lastGlobalX, a.lastGlobalY - b.lastGlobalY);
    if (sepNow <= 0 || pair.startSeparation <= 0) {
      return;
    }
    const factor = pair.startSeparation / sepNow;
    if (!Number.isFinite(factor) || factor <= 0) {
      return;
    }

    const startSnap = pair.startSnapshot;
    const startSpan = Number(startSnap.endTime) - Number(startSnap.startTime);
    if (!Number.isFinite(startSpan) || startSpan <= 0) {
      return;
    }

    const startCentroidPlotX = Math.max(0, Math.min(plot.w, pair.startCentroidX - plot.x));
    const liveCentroidGlobalX = (a.lastGlobalX + b.lastGlobalX) / 2;
    const liveCentroidPlotX = Math.max(0, Math.min(plot.w, liveCentroidGlobalX - plot.x));
    const startCentroidTime = Number(startSnap.startTime) + (startCentroidPlotX / plot.w) * startSpan;

    const minWidth = Math.max(
      Number(startSnap.intervalDuration),
      this.options.minIntervalDuration ?? 0,
    );
    let newSpan = factor * startSpan;
    if (newSpan < minWidth) {
      newSpan = minWidth;
    } else if (newSpan > this.options.maxWindowDuration) {
      newSpan = this.options.maxWindowDuration;
    }

    const newStart = startCentroidTime - (liveCentroidPlotX / plot.w) * newSpan;
    const newEnd = newStart + newSpan;
    if (!Number.isFinite(newStart) || !Number.isFinite(newEnd)) {
      return;
    }
    this.applyWindow({ startTime: asTime(newStart), endTime: asTime(newEnd) });
  }

  private armLongPress(pointerId: number, x: number, y: number): void {
    this.cancelLongPressTimer();
    if (this.onLongPress === undefined) {
      return;
    }
    const timerId = this.timerSet(() => {
      const arm = this.longPressArm;
      this.longPressArm = null;
      if (this.disposed || arm === null || this.trackingMode) {
        return;
      }
      const pointer = this.activePointers.get(arm.pointerId);
      if (pointer === undefined) {
        return;
      }
      const plot = this.plotRect();
      this.onLongPress?.(pointer.lastGlobalX - plot.x, pointer.lastGlobalY - plot.y);
    }, LONG_PRESS_MS);
    this.longPressArm = { pointerId, startGlobalX: x, startGlobalY: y, timerId };
  }

  private cancelLongPressTimer(): void {
    if (this.longPressArm !== null) {
      this.timerClear(this.longPressArm.timerId);
      this.longPressArm = null;
    }
  }

  private endAllDrags(): void {
    this.cancelLongPressTimer();
    if (this.activePointers.size === 0) {
      this.mode = "idle";
      this.pinchPair = null;
      return;
    }
    this.activePointers.clear();
    this.activePanPointerId = null;
    this.mode = "idle";
    this.pinchPair = null;
  }

  private maybeStartKinetic(state: PointerState): void {
    const samples = state.samples;
    const latest = samples[samples.length - 1];
    if (latest === undefined || samples.length < 2) {
      return;
    }
    const cutoff = latest.t - VELOCITY_WINDOW_MS;
    let oldest: VelocitySample = latest;
    for (let i = samples.length - 2; i >= 0; i--) {
      const sample = samples[i];
      if (sample === undefined) {
        break;
      }
      oldest = sample;
      if (sample.t <= cutoff) {
        break;
      }
    }
    const dt = latest.t - oldest.t;
    if (dt <= 0) {
      return;
    }
    const vPxPerMs = (latest.x - oldest.x) / dt;
    if (Math.abs(vPxPerMs) < this.options.kinetic.minFlingVelocityPxPerMs) {
      return;
    }
    this.kineticVelocityPxPerMs = vPxPerMs;
    this.kineticLastT = this.now();
    this.kineticRafId = this.raf(this.runKineticTick);
  }

  private readonly runKineticTick = (): void => {
    if (this.disposed) {
      this.kineticRafId = 0;
      return;
    }
    const now = this.now();
    const dt = Math.max(0, now - this.kineticLastT);
    this.kineticLastT = now;
    const plot = this.plotRect();
    if (plot.w > 0 && dt > 0) {
      const dxPx = this.kineticVelocityPxPerMs * dt;
      const win = computePannedWindow(this.snapshot(), dxPx, plot.w);
      this.applyWindow({ startTime: win.startTime, endTime: win.endTime });
    }
    const decay = Math.exp((-this.options.kinetic.decayPerSec / 1000) * dt);
    this.kineticVelocityPxPerMs *= decay;
    if (Math.abs(this.kineticVelocityPxPerMs) < this.options.kinetic.minFlingVelocityPxPerMs) {
      this.kineticRafId = 0;
      this.kineticVelocityPxPerMs = 0;
      return;
    }
    this.kineticRafId = this.raf(this.runKineticTick);
  };

  private cancelKineticRaf(): void {
    if (this.kineticRafId !== 0) {
      this.caf(this.kineticRafId);
      this.kineticRafId = 0;
    }
    this.kineticVelocityPxPerMs = 0;
  }

  private asScreenHitArea(): Rectangle {
    const width = Math.max(0, this.canvas.clientWidth);
    const height = Math.max(0, this.canvas.clientHeight);
    return new Rectangle(0, 0, width, height);
  }
}

export type { ResolvedOptions as ResolvedViewportOptions };
