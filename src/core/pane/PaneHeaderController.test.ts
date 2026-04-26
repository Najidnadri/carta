import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Container } from "pixi.js";
import { PaneHeader } from "./PaneHeader.js";
import { PaneHeaderController } from "./PaneHeaderController.js";
import type { Pane } from "./Pane.js";
import { asPaneId } from "./types.js";
import type { PaneRect } from "./types.js";
import { DarkTheme } from "../infra/themes.js";

interface MockCanvas extends HTMLCanvasElement {
  __dispatchPointer: (
    type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
    init: { clientX: number; clientY: number; pointerId?: number; pointerType?: string },
  ) => void;
  __keydown: (key: string) => void;
}

interface CapturedListener {
  type: string;
  fn: EventListenerOrEventListenerObject;
}

function makeMockCanvas(width: number, height: number): MockCanvas {
  const listeners: CapturedListener[] = [];
  const captured = new Set<number>();
  const canvas: Partial<MockCanvas> = {
    style: { cursor: "" } as CSSStyleDeclaration,
    addEventListener: ((type: string, fn: EventListenerOrEventListenerObject): void => {
      listeners.push({ type, fn });
    }) as HTMLCanvasElement["addEventListener"],
    removeEventListener: ((type: string, fn: EventListenerOrEventListenerObject): void => {
      const idx = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (idx !== -1) {
        listeners.splice(idx, 1);
      }
    }) as HTMLCanvasElement["removeEventListener"],
    setPointerCapture: (id: number): void => { captured.add(id); },
    releasePointerCapture: (id: number): void => { captured.delete(id); },
    hasPointerCapture: (id: number): boolean => captured.has(id),
    getBoundingClientRect: (): DOMRect =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        width,
        height,
        toJSON: () => ({}),
      } as DOMRect),
  };
  (canvas as MockCanvas).__dispatchPointer = (type, init): void => {
    const event = {
      type,
      clientX: init.clientX,
      clientY: init.clientY,
      pointerId: init.pointerId ?? 1,
      pointerType: init.pointerType ?? "mouse",
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    } as unknown as PointerEvent;
    for (const l of [...listeners]) {
      if (l.type === type) {
        if (typeof l.fn === "function") {
          l.fn(event);
        } else {
          l.fn.handleEvent(event);
        }
      }
    }
  };
  (canvas as MockCanvas).__keydown = (key): void => {
    const ev = { key } as KeyboardEvent;
    for (const l of [...listeners]) {
      if (l.type === "keydown") {
        if (typeof l.fn === "function") {
          l.fn(ev);
        } else {
          l.fn.handleEvent(ev);
        }
      }
    }
  };
  return canvas as MockCanvas;
}

interface Setup {
  controller: PaneHeaderController;
  canvas: MockCanvas;
  panes: Pane[];
  headers: Map<string, PaneHeader>;
  outerRects: PaneRect[];
  callbacks: {
    chevronClicks: string[];
    gearClicks: string[];
    closeClicks: string[];
    reorders: { id: string; idx: number }[];
    dragStarts: string[];
    dragEnds: number;
    hoverChanges: number;
  };
}

function setup(opts: { panes: { id: string; headerY: number }[]; longPressMs?: number; chartW?: number; chartH?: number }): Setup {
  const chartW = opts.chartW ?? 800;
  const chartH = opts.chartH ?? 400;
  const canvas = makeMockCanvas(chartW, chartH);
  const headerLayer = new Container();
  const headers = new Map<string, PaneHeader>();
  const panes: Pane[] = [];
  const outerRects: PaneRect[] = [];
  for (const p of opts.panes) {
    // Make a minimal Pane-like stub (avoid constructing real Pane to keep
    // tests fast).
    const id = asPaneId(p.id);
    const fakePane = { id } as unknown as Pane;
    panes.push(fakePane);
    if (p.headerY > 0 || p.id !== "primary") {
      const header = new PaneHeader(id);
      header.applyRect({ x: 0, y: p.headerY, w: chartW, h: 24 }, DarkTheme, p.id, false);
      headers.set(p.id, header);
    }
    outerRects.push({ x: 0, y: p.headerY, w: chartW, h: 100 });
  }
  const callbacks = {
    chevronClicks: [] as string[],
    gearClicks: [] as string[],
    closeClicks: [] as string[],
    reorders: [] as { id: string; idx: number }[],
    dragStarts: [] as string[],
    dragEnds: 0,
    hoverChanges: 0,
  };
  const baseDeps = {
    canvas: canvas as unknown as HTMLCanvasElement,
    headerLayer,
    panes: () => panes,
    headerForPane: (id: ReturnType<typeof asPaneId>): PaneHeader | null => headers.get(String(id)) ?? null,
    paneRects: () => outerRects,
    headerRects: () => outerRects,
    outerRects: () => outerRects,
    onChevronClick: (id: ReturnType<typeof asPaneId>): void => { callbacks.chevronClicks.push(String(id)); },
    onGearClick: (id: ReturnType<typeof asPaneId>): void => { callbacks.gearClicks.push(String(id)); },
    onCloseClick: (id: ReturnType<typeof asPaneId>): void => { callbacks.closeClicks.push(String(id)); },
    onReorder: (id: ReturnType<typeof asPaneId>, idx: number): void => { callbacks.reorders.push({ id: String(id), idx }); },
    onDragStart: (id: ReturnType<typeof asPaneId>): void => { callbacks.dragStarts.push(String(id)); },
    onDragEnd: () => { callbacks.dragEnds += 1; },
    onHoverChange: () => { callbacks.hoverChanges += 1; },
  };
  const controller =
    opts.longPressMs !== undefined
      ? new PaneHeaderController({ ...baseDeps, longPressMs: opts.longPressMs })
      : new PaneHeaderController(baseDeps);
  return { controller, canvas, panes, headers, outerRects, callbacks };
}

describe("PaneHeaderController", () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("idle FSM after construction", () => {
    const s = setup({ panes: [{ id: "primary", headerY: 0 }, { id: "rsi", headerY: 100 }] });
    expect(s.controller.stateKind()).toBe("idle");
    expect(s.controller.isDragging()).toBe(false);
  });

  it("chevron click fires onChevronClick on pointerup with no movement", () => {
    const s = setup({ panes: [{ id: "primary", headerY: 0 }, { id: "rsi", headerY: 100 }] });
    // Chevron at right cluster: ~739, header at y=100 + h=24 → click at y=112.
    s.canvas.__dispatchPointer("pointerdown", { clientX: 739, clientY: 112 });
    expect(s.controller.stateKind()).toBe("armed-button");
    s.canvas.__dispatchPointer("pointerup", { clientX: 739, clientY: 112 });
    expect(s.callbacks.chevronClicks).toEqual(["rsi"]);
    expect(s.controller.stateKind()).toBe("idle");
  });

  it("gear click fires onGearClick", () => {
    const s = setup({ panes: [{ id: "primary", headerY: 0 }, { id: "rsi", headerY: 100 }] });
    s.canvas.__dispatchPointer("pointerdown", { clientX: 761, clientY: 112 });
    s.canvas.__dispatchPointer("pointerup", { clientX: 761, clientY: 112 });
    expect(s.callbacks.gearClicks).toEqual(["rsi"]);
  });

  it("close click fires onCloseClick", () => {
    const s = setup({ panes: [{ id: "primary", headerY: 0 }, { id: "rsi", headerY: 100 }] });
    s.canvas.__dispatchPointer("pointerdown", { clientX: 783, clientY: 112 });
    s.canvas.__dispatchPointer("pointerup", { clientX: 783, clientY: 112 });
    expect(s.callbacks.closeClicks).toEqual(["rsi"]);
  });

  it("button click is cancelled when movement exceeds 5 px", () => {
    const s = setup({ panes: [{ id: "primary", headerY: 0 }, { id: "rsi", headerY: 100 }] });
    s.canvas.__dispatchPointer("pointerdown", { clientX: 739, clientY: 112 });
    expect(s.controller.stateKind()).toBe("armed-button");
    s.canvas.__dispatchPointer("pointermove", { clientX: 760, clientY: 130 });
    expect(s.controller.stateKind()).toBe("idle");
    s.canvas.__dispatchPointer("pointerup", { clientX: 760, clientY: 130 });
    expect(s.callbacks.chevronClicks).toEqual([]);
  });

  it("desktop title-region drag promotes to dragging on > 5 px movement", () => {
    const s = setup({ panes: [{ id: "primary", headerY: 0 }, { id: "rsi", headerY: 100 }] });
    s.canvas.__dispatchPointer("pointerdown", { clientX: 30, clientY: 112 });
    expect(s.controller.stateKind()).toBe("armed-title-desktop");
    expect(s.callbacks.dragStarts).toEqual([]);
    s.canvas.__dispatchPointer("pointermove", { clientX: 30, clientY: 200 });
    expect(s.controller.stateKind()).toBe("dragging");
    expect(s.callbacks.dragStarts).toEqual(["rsi"]);
  });

  it("desktop title click (no movement) is a no-op (no reorder)", () => {
    const s = setup({ panes: [{ id: "primary", headerY: 0 }, { id: "rsi", headerY: 100 }] });
    s.canvas.__dispatchPointer("pointerdown", { clientX: 30, clientY: 112 });
    s.canvas.__dispatchPointer("pointerup", { clientX: 30, clientY: 112 });
    expect(s.callbacks.reorders).toEqual([]);
    expect(s.callbacks.dragStarts).toEqual([]);
  });

  it("touch long-press promotes to dragging after the timer fires", async () => {
    vi.useFakeTimers();
    const s = setup({ panes: [{ id: "primary", headerY: 0 }, { id: "rsi", headerY: 100 }], longPressMs: 100 });
    s.canvas.__dispatchPointer("pointerdown", { clientX: 30, clientY: 112, pointerType: "touch" });
    expect(s.controller.stateKind()).toBe("armed-title-touch");
    expect(s.callbacks.dragStarts).toEqual([]);
    await vi.advanceTimersByTimeAsync(150);
    expect(s.controller.stateKind()).toBe("dragging");
    expect(s.callbacks.dragStarts).toEqual(["rsi"]);
    vi.useRealTimers();
  });

  it("touch movement before long-press fires aborts the gesture", async () => {
    vi.useFakeTimers();
    const s = setup({ panes: [{ id: "primary", headerY: 0 }, { id: "rsi", headerY: 100 }], longPressMs: 100 });
    s.canvas.__dispatchPointer("pointerdown", { clientX: 30, clientY: 112, pointerType: "touch" });
    s.canvas.__dispatchPointer("pointermove", { clientX: 30, clientY: 200, pointerType: "touch" });
    expect(s.controller.stateKind()).toBe("idle");
    await vi.advanceTimersByTimeAsync(200);
    expect(s.callbacks.dragStarts).toEqual([]);
    vi.useRealTimers();
  });

  it("Escape cancels an in-flight drag", () => {
    const s = setup({ panes: [{ id: "primary", headerY: 0 }, { id: "rsi", headerY: 100 }] });
    s.canvas.__dispatchPointer("pointerdown", { clientX: 30, clientY: 112 });
    s.canvas.__dispatchPointer("pointermove", { clientX: 30, clientY: 200 });
    expect(s.controller.stateKind()).toBe("dragging");
    if (typeof globalThis.window !== "undefined") {
      // Escape via window keydown — controller listens at window scope.
      const ev = new KeyboardEvent("keydown", { key: "Escape" });
      globalThis.window.dispatchEvent(ev);
    } else {
      s.canvas.__keydown("Escape");
    }
    expect(s.controller.stateKind()).toBe("idle");
  });

  it("pointercancel during drag triggers onDragEnd", () => {
    const s = setup({ panes: [{ id: "primary", headerY: 0 }, { id: "rsi", headerY: 100 }] });
    s.canvas.__dispatchPointer("pointerdown", { clientX: 30, clientY: 112 });
    s.canvas.__dispatchPointer("pointermove", { clientX: 30, clientY: 200 });
    s.canvas.__dispatchPointer("pointercancel", { clientX: 30, clientY: 200 });
    expect(s.controller.stateKind()).toBe("idle");
    expect(s.callbacks.dragEnds).toBe(1);
  });

  it("pointerup during drag triggers onReorder + onDragEnd", () => {
    const s = setup({
      panes: [
        { id: "primary", headerY: 0 },
        { id: "rsi", headerY: 100 },
        { id: "macd", headerY: 200 },
      ],
      chartH: 600,
    });
    // Drag rsi pane down past macd.
    s.canvas.__dispatchPointer("pointerdown", { clientX: 30, clientY: 112 });
    s.canvas.__dispatchPointer("pointermove", { clientX: 30, clientY: 250 });
    s.canvas.__dispatchPointer("pointerup", { clientX: 30, clientY: 250 });
    expect(s.controller.stateKind()).toBe("idle");
    expect(s.callbacks.dragEnds).toBe(1);
    expect(s.callbacks.reorders.length).toBe(1);
  });

  it("dragging primary pane is rejected (no armed state)", () => {
    const s = setup({ panes: [{ id: "primary", headerY: 0 }, { id: "rsi", headerY: 100 }] });
    // Primary pane has no header in our setup (headerY=0 → no header).
    s.canvas.__dispatchPointer("pointerdown", { clientX: 30, clientY: 12 });
    expect(s.controller.stateKind()).toBe("idle");
  });

  it("hover state propagates to header.setHover", () => {
    const s = setup({ panes: [{ id: "primary", headerY: 0 }, { id: "rsi", headerY: 100 }] });
    s.canvas.__dispatchPointer("pointermove", { clientX: 739, clientY: 112 });
    const header = s.headers.get("rsi");
    expect(header?.getHover()).toBe("chevron");
    // Move off the header.
    s.canvas.__dispatchPointer("pointermove", { clientX: 50, clientY: 50 });
    expect(header?.getHover()).toBe(null);
  });

  it("cancelDrag from outside aborts armed state", () => {
    const s = setup({ panes: [{ id: "primary", headerY: 0 }, { id: "rsi", headerY: 100 }] });
    s.canvas.__dispatchPointer("pointerdown", { clientX: 739, clientY: 112 });
    expect(s.controller.stateKind()).toBe("armed-button");
    s.controller.cancelDrag();
    expect(s.controller.stateKind()).toBe("idle");
  });

  it("destroy unbinds listeners + cancels in-flight drag", () => {
    const s = setup({ panes: [{ id: "primary", headerY: 0 }, { id: "rsi", headerY: 100 }] });
    s.canvas.__dispatchPointer("pointerdown", { clientX: 30, clientY: 112 });
    s.canvas.__dispatchPointer("pointermove", { clientX: 30, clientY: 200 });
    expect(s.controller.stateKind()).toBe("dragging");
    s.controller.destroy();
    expect(s.controller.stateKind()).toBe("idle");
    // Subsequent events should be no-ops.
    s.canvas.__dispatchPointer("pointerdown", { clientX: 30, clientY: 112 });
    expect(s.controller.stateKind()).toBe("idle");
  });
});
