import { describe, expect, it, vi } from "vitest";
import type { Container } from "pixi.js";
import { ViewportController } from "./ViewportController.js";
import { asInterval, asTime, type WindowInput } from "../types.js";

type FakeStageHandlers = Record<string, ((e: unknown) => void)[]>;

interface FakeStage {
  eventMode?: string;
  hitArea?: unknown;
  handlers: FakeStageHandlers;
  on: (event: string, handler: (e: unknown) => void) => void;
  off: (event: string, handler: (e: unknown) => void) => void;
  emit: (event: string, payload: unknown) => void;
}

function createFakeStage(): FakeStage {
  const handlers: FakeStageHandlers = {};
  return {
    handlers,
    on(event, handler): void {
      (handlers[event] ??= []).push(handler);
    },
    off(event, handler): void {
      const list = handlers[event];
      if (list === undefined) {
        return;
      }
      const idx = list.indexOf(handler);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
    },
    emit(event, payload): void {
      const list = handlers[event];
      if (list === undefined) {
        return;
      }
      for (const h of [...list]) {
        h(payload);
      }
    },
  };
}

function createFakeCanvas(width = 800, height = 400): HTMLCanvasElement {
  const listeners = new Map<string, Set<EventListener>>();
  const style = { touchAction: "" };
  const canvas: Partial<HTMLCanvasElement> & {
    _listeners: typeof listeners;
    width: number;
    height: number;
    clientWidth: number;
    clientHeight: number;
    style: typeof style;
    getBoundingClientRect(): DOMRect;
    addEventListener(type: string, listener: EventListener): void;
    removeEventListener(type: string, listener: EventListener): void;
    dispatchEvent(e: Event): boolean;
  } = {
    _listeners: listeners,
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: style as unknown as CSSStyleDeclaration,
    getBoundingClientRect(): DOMRect {
      return { x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: (): unknown => ({}) } as DOMRect;
    },
    addEventListener(type: string, listener: EventListener): void {
      let set = listeners.get(type);
      if (set === undefined) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type: string, listener: EventListener): void {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(e: Event): boolean {
      const set = listeners.get(e.type);
      if (set !== undefined) {
        for (const l of [...set]) {
          l(e);
        }
      }
      return true;
    },
  };
  return canvas as unknown as HTMLCanvasElement;
}

type ApplyWindowMock = ReturnType<typeof vi.fn<(w: WindowInput) => void>>;

function makeDeps(): {
  stage: FakeStage;
  canvas: HTMLCanvasElement;
  applyWindow: ApplyWindowMock;
  snapshot: { startTime: ReturnType<typeof asTime>; endTime: ReturnType<typeof asTime>; intervalDuration: ReturnType<typeof asInterval> };
  setSnapshot: (next: { startTime: number; endTime: number; interval: number }) => void;
  controller: ViewportController;
} {
  const stage = createFakeStage();
  const canvas = createFakeCanvas(1000, 400);
  let snap = {
    startTime: asTime(0),
    endTime: asTime(1_000_000),
    intervalDuration: asInterval(1_000),
  };
  const applyWindow = vi.fn((w: WindowInput): void => {
    snap = { ...snap, startTime: w.startTime, endTime: w.endTime };
  });
  const controller = new ViewportController({
    stage: stage as unknown as Container,
    canvas,
    snapshot: (): typeof snap => snap,
    applyWindow: applyWindow as unknown as (w: WindowInput) => void,
    plotRect: (): { x: number; y: number; w: number; h: number } => ({ x: 0, y: 0, w: 936, h: 372 }),
    rafFns: {
      request: (): number => 0,
      cancel: (): void => undefined,
      now: (): number => 0,
    },
  });
  return {
    stage,
    canvas,
    applyWindow,
    get snapshot() {
      return snap;
    },
    setSnapshot(next): void {
      snap = {
        startTime: asTime(next.startTime),
        endTime: asTime(next.endTime),
        intervalDuration: asInterval(next.interval),
      };
    },
    controller,
  };
}

describe("ViewportController — setup", () => {
  it("subscribes stage pointer events and canvas wheel listener", () => {
    const { stage, canvas, controller } = makeDeps();
    expect(stage.handlers.pointerdown?.length).toBe(1);
    expect(stage.handlers.globalpointermove?.length).toBe(1);
    expect(stage.handlers.pointerup?.length).toBe(1);
    expect(stage.handlers.pointerupoutside?.length).toBe(1);
    expect(stage.handlers.pointercancel?.length).toBe(1);
    expect((canvas as unknown as { _listeners: Map<string, Set<unknown>> })._listeners.get("wheel")?.size).toBe(1);
    controller.destroy();
  });

  it("sets touchAction:none on the canvas", () => {
    const { canvas, controller } = makeDeps();
    expect(canvas.style.touchAction).toBe("none");
    controller.destroy();
  });

  it("reports kinetic inactive initially", () => {
    const { controller } = makeDeps();
    expect(controller.isKineticActive()).toBe(false);
    controller.destroy();
  });
});

describe("ViewportController — destroy", () => {
  it("is idempotent", () => {
    const { controller } = makeDeps();
    controller.destroy();
    expect(() => { controller.destroy(); }).not.toThrow();
  });

  it("removes all listeners", () => {
    const { stage, canvas, controller } = makeDeps();
    controller.destroy();
    expect(stage.handlers.pointerdown?.length ?? 0).toBe(0);
    expect(stage.handlers.globalpointermove?.length ?? 0).toBe(0);
    expect(
      (canvas as unknown as { _listeners: Map<string, Set<unknown>> })._listeners.get("wheel")?.size ?? 0,
    ).toBe(0);
  });
});

describe("ViewportController — wheel", () => {
  it("plain wheel down zooms out; start time moves earlier", () => {
    const { canvas, applyWindow, controller } = makeDeps();
    const evt = new Event("wheel") as WheelEvent;
    Object.defineProperty(evt, "deltaY", { value: 1 });
    Object.defineProperty(evt, "clientX", { value: 500 });
    Object.defineProperty(evt, "clientY", { value: 100 });
    Object.defineProperty(evt, "shiftKey", { value: false });
    Object.defineProperty(evt, "preventDefault", { value: ((): void => undefined) });
    canvas.dispatchEvent(evt);
    expect(applyWindow).toHaveBeenCalled();
    const arg = applyWindow.mock.calls[0]?.[0] as WindowInput;
    expect(Number(arg.endTime) - Number(arg.startTime)).toBeGreaterThan(1_000_000);
    controller.destroy();
  });

  it("plain wheel up zooms in; width shrinks", () => {
    const { canvas, applyWindow, controller } = makeDeps();
    const evt = new Event("wheel") as WheelEvent;
    Object.defineProperty(evt, "deltaY", { value: -1 });
    Object.defineProperty(evt, "clientX", { value: 500 });
    Object.defineProperty(evt, "shiftKey", { value: false });
    Object.defineProperty(evt, "preventDefault", { value: ((): void => undefined) });
    canvas.dispatchEvent(evt);
    const arg = applyWindow.mock.calls[0]?.[0] as WindowInput;
    expect(Number(arg.endTime) - Number(arg.startTime)).toBeLessThan(1_000_000);
    controller.destroy();
  });

  it("shift+wheel pans without changing width", () => {
    const { canvas, applyWindow, controller } = makeDeps();
    const evt = new Event("wheel") as WheelEvent;
    Object.defineProperty(evt, "deltaY", { value: 1 });
    Object.defineProperty(evt, "clientX", { value: 500 });
    Object.defineProperty(evt, "shiftKey", { value: true });
    Object.defineProperty(evt, "preventDefault", { value: ((): void => undefined) });
    canvas.dispatchEvent(evt);
    const arg = applyWindow.mock.calls[0]?.[0] as WindowInput;
    expect(Number(arg.endTime) - Number(arg.startTime)).toBeCloseTo(1_000_000, 3);
    expect(Number(arg.startTime)).toBeGreaterThan(0);
    controller.destroy();
  });

  it("calls preventDefault to block page scroll", () => {
    const { canvas, controller } = makeDeps();
    const evt = new Event("wheel") as WheelEvent;
    Object.defineProperty(evt, "deltaY", { value: 1 });
    Object.defineProperty(evt, "clientX", { value: 500 });
    Object.defineProperty(evt, "shiftKey", { value: false });
    const prevent = vi.fn();
    Object.defineProperty(evt, "preventDefault", { value: prevent });
    canvas.dispatchEvent(evt);
    expect(prevent).toHaveBeenCalled();
    controller.destroy();
  });
});

describe("ViewportController — drag pan", () => {
  it("single-pointer mouse drag pans the window", () => {
    const deps = makeDeps();
    deps.stage.emit("pointerdown", {
      pointerId: 1,
      pointerType: "mouse",
      global: { x: 400, y: 200 },
    });
    deps.stage.emit("globalpointermove", {
      pointerId: 1,
      pointerType: "mouse",
      global: { x: 300, y: 200 },
    });
    expect(deps.applyWindow).toHaveBeenCalled();
    const arg = deps.applyWindow.mock.calls.at(-1)?.[0] as WindowInput;
    expect(Number(arg.startTime)).toBeGreaterThan(0);
    deps.stage.emit("pointerup", {
      pointerId: 1,
      pointerType: "mouse",
      global: { x: 300, y: 200 },
    });
    deps.controller.destroy();
  });

  it("second pointer latches multi-touch and cancels drag (no jumps)", () => {
    const deps = makeDeps();
    deps.stage.emit("pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      global: { x: 400, y: 200 },
    });
    deps.applyWindow.mockClear();
    deps.stage.emit("pointerdown", {
      pointerId: 2,
      pointerType: "touch",
      global: { x: 600, y: 200 },
    });
    deps.stage.emit("globalpointermove", {
      pointerId: 1,
      pointerType: "touch",
      global: { x: 500, y: 200 },
    });
    expect(deps.applyWindow).not.toHaveBeenCalled();
    deps.stage.emit("pointerup", { pointerId: 2, pointerType: "touch", global: { x: 600, y: 200 } });
    deps.stage.emit("pointerup", { pointerId: 1, pointerType: "touch", global: { x: 500, y: 200 } });
    deps.controller.destroy();
  });

  it("pointerupoutside completes a drag even when pointer left canvas", () => {
    const deps = makeDeps();
    deps.stage.emit("pointerdown", {
      pointerId: 5,
      pointerType: "mouse",
      global: { x: 200, y: 200 },
    });
    deps.stage.emit("globalpointermove", {
      pointerId: 5,
      pointerType: "mouse",
      global: { x: 1200, y: 200 },
    });
    deps.stage.emit("pointerupoutside", {
      pointerId: 5,
      pointerType: "mouse",
      global: { x: 1200, y: 200 },
    });
    expect(deps.controller.isKineticActive()).toBe(false);
    deps.controller.destroy();
  });
});

describe("ViewportController — kinetic", () => {
  it("does not start kinetic for mouse pointerType", () => {
    const deps = makeDeps();
    deps.stage.emit("pointerdown", { pointerId: 9, pointerType: "mouse", global: { x: 400, y: 200 } });
    deps.stage.emit("globalpointermove", { pointerId: 9, pointerType: "mouse", global: { x: 420, y: 200 } });
    deps.stage.emit("pointerup", { pointerId: 9, pointerType: "mouse", global: { x: 500, y: 200 } });
    expect(deps.controller.isKineticActive()).toBe(false);
    deps.controller.destroy();
  });

  it("stopKinetic is safe to call when no kinetic active", () => {
    const deps = makeDeps();
    expect(() => { deps.controller.stopKinetic(); }).not.toThrow();
    deps.controller.destroy();
  });
});

describe("ViewportController — blur/visibilitychange", () => {
  it("does not throw when blur fires with no active drag", () => {
    const deps = makeDeps();
    expect(() => globalThis.window.dispatchEvent(new Event("blur"))).not.toThrow();
    deps.controller.destroy();
  });
});

// ─── Phase 09 — pinch + long-press + tracking-mode ───────────────────────

interface PinchDeps {
  readonly stage: FakeStage;
  readonly canvas: HTMLCanvasElement;
  readonly applyWindow: ApplyWindowMock;
  readonly onLongPress: ReturnType<typeof vi.fn<(x: number, y: number) => void>>;
  readonly onTrackingMove: ReturnType<typeof vi.fn<(x: number, y: number) => void>>;
  readonly controller: ViewportController;
  /** Fast-forward the fake timer queue by `ms`. */
  readonly tick: (ms: number) => void;
}

function makeDepsExt(): PinchDeps {
  const stage = createFakeStage();
  const canvas = createFakeCanvas(1000, 400);
  let snap = {
    startTime: asTime(0),
    endTime: asTime(1_000_000),
    intervalDuration: asInterval(1_000),
  };
  const applyWindow = vi.fn((w: WindowInput): void => {
    snap = { ...snap, startTime: w.startTime, endTime: w.endTime };
  });
  // Fake timer: deterministic queue, fires when the cumulative tick time reaches ms.
  let nowMs = 0;
  let nextTimerId = 1;
  const queue = new Map<number, { firesAt: number; cb: () => void }>();
  const onLongPress = vi.fn();
  const onTrackingMove = vi.fn();
  const controller = new ViewportController({
    stage: stage as unknown as Container,
    canvas,
    snapshot: (): typeof snap => snap,
    applyWindow: applyWindow as unknown as (w: WindowInput) => void,
    plotRect: (): { x: number; y: number; w: number; h: number } => ({ x: 0, y: 0, w: 1000, h: 400 }),
    rafFns: {
      request: (): number => 0,
      cancel: (): void => undefined,
      now: (): number => nowMs,
    },
    onLongPress,
    onTrackingMove,
    timerFns: {
      setTimeout: (cb, ms): number => {
        const id = nextTimerId++;
        queue.set(id, { firesAt: nowMs + ms, cb });
        return id;
      },
      clearTimeout: (id): void => { queue.delete(id); },
    },
  });
  const tick = (ms: number): void => {
    nowMs += ms;
    for (const [id, entry] of [...queue.entries()]) {
      if (entry.firesAt <= nowMs) {
        queue.delete(id);
        entry.cb();
      }
    }
  };
  return { stage, canvas, applyWindow, onLongPress, onTrackingMove, controller, tick };
}

function pdown(stage: FakeStage, id: number, x: number, y: number, type = "touch"): void {
  stage.emit("pointerdown", {
    pointerId: id,
    pointerType: type,
    global: { x, y },
  });
}
function pmove(stage: FakeStage, id: number, x: number, y: number, type = "touch"): void {
  stage.emit("globalpointermove", {
    pointerId: id,
    pointerType: type,
    global: { x, y },
  });
}
function pup(stage: FakeStage, id: number, x: number, y: number, type = "touch"): void {
  stage.emit("pointerup", {
    pointerId: id,
    pointerType: type,
    global: { x, y },
  });
}

describe("ViewportController — pinch", () => {
  it("zooms around midpoint when pointers spread apart", () => {
    const d = makeDepsExt();
    pdown(d.stage, 1, 400, 200);
    pdown(d.stage, 2, 600, 200);
    d.applyWindow.mockClear();
    // Both pointers move past 6px gate, separation grows from 200 to 400 → factor 0.5 (zoom in).
    pmove(d.stage, 1, 300, 200);
    pmove(d.stage, 2, 700, 200);
    expect(d.applyWindow).toHaveBeenCalled();
    const arg = d.applyWindow.mock.calls.at(-1)?.[0] as WindowInput;
    const newSpan = Number(arg.endTime) - Number(arg.startTime);
    expect(newSpan).toBeLessThan(1_000_000);
    expect(newSpan).toBeGreaterThan(0);
    d.controller.destroy();
  });

  it("two-finger pan with constant separation translates the window", () => {
    const d = makeDepsExt();
    pdown(d.stage, 1, 400, 200);
    pdown(d.stage, 2, 600, 200);
    d.applyWindow.mockClear();
    // Both fingers move +100 px → constant separation, centroid moves +100 px.
    pmove(d.stage, 1, 500, 200);
    pmove(d.stage, 2, 700, 200);
    expect(d.applyWindow).toHaveBeenCalled();
    const arg = d.applyWindow.mock.calls.at(-1)?.[0] as WindowInput;
    const newSpan = Number(arg.endTime) - Number(arg.startTime);
    // Span should stay (near-)constant — separation didn't change.
    expect(newSpan).toBeGreaterThan(990_000);
    expect(newSpan).toBeLessThan(1_010_000);
    // Window translated to earlier times (centroid moved right → window shifts left).
    expect(Number(arg.startTime)).toBeLessThan(0);
    d.controller.destroy();
  });

  it("does not zoom while one finger is below the gate (thumb resting)", () => {
    const d = makeDepsExt();
    pdown(d.stage, 1, 400, 200);
    pdown(d.stage, 2, 600, 200);
    d.applyWindow.mockClear();
    // Pointer 1 moves 100 px; pointer 2 only 3 px (under 6 px gate).
    pmove(d.stage, 1, 500, 200);
    pmove(d.stage, 2, 603, 200);
    expect(d.applyWindow).not.toHaveBeenCalled();
    d.controller.destroy();
  });

  it("ignores a third finger that lands during an active pinch", () => {
    const d = makeDepsExt();
    pdown(d.stage, 1, 400, 200);
    pdown(d.stage, 2, 600, 200);
    pmove(d.stage, 1, 300, 200);
    pmove(d.stage, 2, 700, 200);
    d.applyWindow.mockClear();
    // Third finger lands and moves — shouldn't drive any new applyWindow.
    pdown(d.stage, 3, 800, 200);
    pmove(d.stage, 3, 850, 200);
    expect(d.applyWindow).not.toHaveBeenCalled();
    // Re-driving the original pair still works.
    pmove(d.stage, 1, 250, 200);
    expect(d.applyWindow).toHaveBeenCalled();
    d.controller.destroy();
  });

  it("ends pinch cleanly when one finger lifts; remaining finger does not adopt as pan", () => {
    const d = makeDepsExt();
    pdown(d.stage, 1, 400, 200);
    pdown(d.stage, 2, 600, 200);
    pmove(d.stage, 1, 300, 200);
    pmove(d.stage, 2, 700, 200);
    pup(d.stage, 2, 700, 200);
    d.applyWindow.mockClear();
    // Remaining pointer moves — should NOT drive a pan (no pointer-id was promoted).
    pmove(d.stage, 1, 100, 200);
    expect(d.applyWindow).not.toHaveBeenCalled();
    d.controller.destroy();
  });
});

describe("ViewportController — long-press", () => {
  it("fires onLongPress after 350ms within deadzone", () => {
    const d = makeDepsExt();
    pdown(d.stage, 1, 400, 200);
    d.tick(351);
    expect(d.onLongPress).toHaveBeenCalledTimes(1);
    const args = d.onLongPress.mock.calls[0] ?? [];
    expect(args[0]).toBe(400);
    expect(args[1]).toBe(200);
    d.controller.destroy();
  });

  it("cancels timer on second pointerdown", () => {
    const d = makeDepsExt();
    pdown(d.stage, 1, 400, 200);
    pdown(d.stage, 2, 600, 200);
    d.tick(400);
    expect(d.onLongPress).not.toHaveBeenCalled();
    d.controller.destroy();
  });

  it("cancels timer on move beyond 8px deadzone", () => {
    const d = makeDepsExt();
    pdown(d.stage, 1, 400, 200);
    pmove(d.stage, 1, 410, 207); // hypot(10,7)=12.2 > 8
    d.tick(400);
    expect(d.onLongPress).not.toHaveBeenCalled();
    d.controller.destroy();
  });

  it("does not cancel for sub-deadzone jitter", () => {
    const d = makeDepsExt();
    pdown(d.stage, 1, 400, 200);
    pmove(d.stage, 1, 405, 203); // hypot(5,3) ≈ 5.83 < 8
    d.tick(400);
    expect(d.onLongPress).toHaveBeenCalledTimes(1);
    d.controller.destroy();
  });

  it("cancels timer on pointerup before fire", () => {
    const d = makeDepsExt();
    pdown(d.stage, 1, 400, 200);
    pup(d.stage, 1, 400, 200);
    d.tick(400);
    expect(d.onLongPress).not.toHaveBeenCalled();
    d.controller.destroy();
  });

  it("does not arm for mouse pointers", () => {
    const d = makeDepsExt();
    pdown(d.stage, 1, 400, 200, "mouse");
    d.tick(400);
    expect(d.onLongPress).not.toHaveBeenCalled();
    d.controller.destroy();
  });
});

describe("ViewportController — tracking mode", () => {
  it("routes single-finger touch moves to onTrackingMove instead of panning", () => {
    const d = makeDepsExt();
    d.controller.setTrackingMode(true);
    expect(d.controller.isTrackingMode()).toBe(true);
    pdown(d.stage, 1, 400, 200);
    d.applyWindow.mockClear();
    pmove(d.stage, 1, 500, 250);
    expect(d.applyWindow).not.toHaveBeenCalled();
    expect(d.onTrackingMove).toHaveBeenCalledWith(500, 250);
    d.controller.destroy();
  });

  it("does not route mouse moves to onTrackingMove (mouse path stays alive)", () => {
    const d = makeDepsExt();
    d.controller.setTrackingMode(true);
    pdown(d.stage, 1, 400, 200, "mouse");
    pmove(d.stage, 1, 500, 200, "mouse");
    expect(d.onTrackingMove).not.toHaveBeenCalled();
    d.controller.destroy();
  });

  it("setTrackingMode(false) resumes pan routing", () => {
    const d = makeDepsExt();
    d.controller.setTrackingMode(true);
    d.controller.setTrackingMode(false);
    pdown(d.stage, 1, 400, 200, "mouse");
    pmove(d.stage, 1, 300, 200, "mouse");
    expect(d.applyWindow).toHaveBeenCalled();
    d.controller.destroy();
  });
});
