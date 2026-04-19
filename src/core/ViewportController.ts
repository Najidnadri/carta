import { Rectangle, type Container, type FederatedPointerEvent } from "pixi.js";
import {
  computePannedWindow,
  computeShiftPannedWindow,
  computeZoomedWindow,
  type WindowSnapshot,
} from "./ViewportMath.js";
import type { PlotRect } from "./Renderer.js";
import { asTime, type ChartWindow, type KineticOptions, type ViewportOptions } from "../types.js";

const DEFAULT_ZOOM_FACTOR = 0.88;
const DEFAULT_SHIFT_PAN_FRACTION = 0.1;
const DEFAULT_KINETIC_DECAY_PER_SEC = 5;
const DEFAULT_MIN_FLING_VELOCITY_PX_PER_MS = 0.1;
const VELOCITY_WINDOW_MS = 80;
const MAX_VELOCITY_SAMPLES = 64;

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
  readonly applyWindow: (win: ChartWindow) => void;
  readonly plotRect: () => PlotRect;
  readonly options?: ViewportOptions | undefined;
  readonly rafFns?:
    | {
        readonly request: (cb: FrameRequestCallback) => number;
        readonly cancel: (id: number) => void;
        readonly now: () => number;
      }
    | undefined;
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
 * The `activePointers` map + `routeGesture` switch scaffold phase 09's pinch
 * support: size === 1 → single-pointer pan; size >= 2 cancels the in-flight
 * drag and latches a "multi-touch" flag until only one pointer remains.
 */
export class ViewportController {
  private readonly stage: Container;
  private readonly canvas: HTMLCanvasElement;
  private readonly snapshot: () => WindowSnapshot;
  private readonly applyWindow: (win: ChartWindow) => void;
  private readonly plotRect: () => PlotRect;
  private readonly options: ResolvedOptions;
  private readonly raf: (cb: FrameRequestCallback) => number;
  private readonly caf: (id: number) => void;
  private readonly now: () => number;

  private readonly activePointers = new Map<number, PointerState>();
  private activePanPointerId: number | null = null;
  private multiTouchLatched = false;
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
    this.caf = deps.rafFns?.cancel ?? ((id): void => cancelAnimationFrame(id));
    this.now = deps.rafFns?.now ?? ((): number => performance.now());

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

    this.canvas.style.touchAction = "none";
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

  destroy(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelKineticRaf();
    this.activePointers.clear();
    this.activePanPointerId = null;
    this.multiTouchLatched = false;

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
    const type = (e.pointerType as PointerType) ?? "mouse";
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
    this.routeGesture();
  };

  private readonly onPointerMove = (e: FederatedPointerEvent): void => {
    if (this.disposed) {
      return;
    }
    const state = this.activePointers.get(e.pointerId);
    if (state === undefined || state.cancelled) {
      return;
    }
    state.lastGlobalX = e.global.x;
    state.lastGlobalY = e.global.y;
    const sampleT = this.eventTime(e);
    state.samples.push({ t: sampleT, x: e.global.x });
    while (state.samples.length > MAX_VELOCITY_SAMPLES) {
      state.samples.shift();
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
    if (state === undefined) {
      this.routeGesture();
      return;
    }
    const wasPanPointer = this.activePanPointerId === e.pointerId;
    if (wasPanPointer) {
      this.activePanPointerId = null;
      if (!state.cancelled && state.type === "touch" && this.activePointers.size === 0) {
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
    if (globalThis.document?.hidden === true) {
      this.endAllDrags();
      this.cancelKineticRaf();
    }
  };

  private routeGesture(): void {
    if (this.activePointers.size === 0) {
      if (this.multiTouchLatched) {
        this.multiTouchLatched = false;
      }
      this.activePanPointerId = null;
      return;
    }
    if (this.activePointers.size === 1) {
      if (this.multiTouchLatched) {
        return;
      }
      const [first] = this.activePointers.values();
      if (first !== undefined && this.activePanPointerId === null) {
        this.activePanPointerId = first.id;
      }
      return;
    }
    if (!this.multiTouchLatched) {
      this.multiTouchLatched = true;
      for (const p of this.activePointers.values()) {
        p.cancelled = true;
      }
      this.activePanPointerId = null;
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

  private endAllDrags(): void {
    if (this.activePointers.size === 0) {
      return;
    }
    this.activePointers.clear();
    this.activePanPointerId = null;
    this.multiTouchLatched = false;
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
