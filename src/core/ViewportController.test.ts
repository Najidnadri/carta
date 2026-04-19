import { describe, expect, it, vi } from "vitest";
import type { Container } from "pixi.js";
import { ViewportController } from "./ViewportController.js";
import { asInterval, asTime, type ChartWindow } from "../types.js";

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

type ApplyWindowMock = ReturnType<typeof vi.fn<(w: ChartWindow) => void>>;

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
  const applyWindow = vi.fn((w: ChartWindow): void => {
    snap = { ...snap, startTime: w.startTime, endTime: w.endTime };
  });
  const controller = new ViewportController({
    stage: stage as unknown as Container,
    canvas,
    snapshot: (): typeof snap => snap,
    applyWindow: applyWindow as unknown as (w: ChartWindow) => void,
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
    const arg = applyWindow.mock.calls[0]?.[0] as ChartWindow;
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
    const arg = applyWindow.mock.calls[0]?.[0] as ChartWindow;
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
    const arg = applyWindow.mock.calls[0]?.[0] as ChartWindow;
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
    const arg = deps.applyWindow.mock.calls.at(-1)?.[0] as ChartWindow;
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
