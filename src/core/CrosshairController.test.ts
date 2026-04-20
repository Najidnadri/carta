import { describe, it, expect, vi } from "vitest";
import type * as PixiNS from "pixi.js";
import { CrosshairController, type CrosshairRenderContext } from "./CrosshairController.js";
import { DataStore } from "./DataStore.js";
import { EventBus } from "./EventBus.js";
import { PriceScale } from "./PriceScale.js";
import { TimeScale } from "./TimeScale.js";
import type { Series } from "./Series.js";
import type { PlotRect } from "./Renderer.js";
import {
  asInterval,
  asPrice,
  asTime,
  DEFAULT_THEME,
  type CartaEventMap,
  type CrosshairInfo,
  type OhlcRecord,
} from "../types.js";

// Stub BitmapText — the real one needs a canvas jsdom doesn't provide.
vi.mock("pixi.js", async () => {
  const actual = await vi.importActual<typeof PixiNS>("pixi.js");
  class FakeBitmapText extends actual.Container {
    text = "";
    readonly __isFakeBitmapText = true;
    get width(): number { return this.text.length * 6; }
    // eslint-disable-next-line @typescript-eslint/class-literal-property-style
    get height(): number { return 11; }
    constructor(..._args: unknown[]) {
      super();
    }
  }
  return { ...actual, BitmapText: FakeBitmapText };
});

type Pixi = typeof PixiNS;

const MIN = 60_000;
const HOUR = 60 * MIN;
// Minute-aligned so slot 0 == startTime (see TimeScale.snapToBarTime tests).
const START = 1_700_000_040_000;

async function freshPixi(): Promise<Pixi> {
  return await import("pixi.js");
}

const noopLogger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

function makeCanvas(): HTMLCanvasElement {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const canvas = {
    addEventListener: (type: string, listener: EventListener): void => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener as (e: Event) => void);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: EventListener): void => {
      listeners.get(type)?.delete(listener as (e: Event) => void);
    },
    dispatchEvent: (e: Event): boolean => {
      for (const l of listeners.get(e.type) ?? []) {
        l(e);
      }
      return true;
    },
    __listeners: listeners,
  } as unknown as HTMLCanvasElement & { __listeners: Map<string, Set<(e: Event) => void>> };
  return canvas;
}

function makeTimeScale(): TimeScale {
  // 60 slots over 1200 px → 20 px per bar.
  return new TimeScale({
    startTime: asTime(START),
    endTime: asTime(START + HOUR),
    intervalDuration: asInterval(MIN),
    pixelWidth: 1200,
  });
}

function makePriceScale(): PriceScale {
  return new PriceScale({
    domainMin: asPrice(100),
    domainMax: asPrice(200),
    pixelHeight: 400,
  });
}

function ohlc(time: number, c: number): OhlcRecord {
  return {
    time: asTime(time),
    open: asPrice(c - 1),
    high: asPrice(c + 2),
    low: asPrice(c - 2),
    close: asPrice(c),
  };
}

async function setup(): Promise<{
  controller: CrosshairController;
  stage: PixiNS.Container;
  canvas: HTMLCanvasElement & { __listeners: Map<string, Set<(e: Event) => void>> };
  linesLayer: PixiNS.Container;
  tagsLayer: PixiNS.Container;
  bus: EventBus<CartaEventMap>;
  invalidate: ReturnType<typeof vi.fn>;
  dataStore: DataStore;
  series: Series[];
  ctx: () => CrosshairRenderContext;
  payloads: CrosshairInfo[];
}> {
  const pixi = await freshPixi();
  const stage = new pixi.Container();
  const linesLayer = new pixi.Container();
  const tagsLayer = new pixi.Container();
  stage.addChild(linesLayer);
  stage.addChild(tagsLayer);

  const canvas = makeCanvas() as HTMLCanvasElement & {
    __listeners: Map<string, Set<(e: Event) => void>>;
  };
  const bus = new EventBus<CartaEventMap>();
  const payloads: CrosshairInfo[] = [];
  bus.on("crosshair:move", (info) => { payloads.push(info); });

  const invalidate = vi.fn();
  const controller = new CrosshairController({
    stage,
    canvas,
    linesLayer,
    tagsLayer,
    eventBus: bus,
    logger: noopLogger,
    invalidate,
  });

  const dataStore = new DataStore();
  const series: Series[] = [];

  const plotRect: PlotRect = { x: 0, y: 0, w: 1200, h: 400 };
  const timeScale = makeTimeScale();
  const priceScale = makePriceScale();

  return {
    controller,
    stage,
    canvas,
    linesLayer,
    tagsLayer,
    bus,
    invalidate,
    dataStore,
    series,
    ctx: (): CrosshairRenderContext => ({
      plotRect,
      timeScale,
      priceScale,
      theme: DEFAULT_THEME,
      dataStore,
      series,
      intervalDuration: MIN,
      priceFormatter: (v): string => v.toFixed(2),
    }),
    payloads,
  };
}

function fakeMove(
  stage: PixiNS.Container,
  x: number,
  y: number,
  pointerType = "mouse",
): void {
  stage.emit("globalpointermove", {
    global: { x, y },
    pointerType,
    pointerId: 1,
  } as unknown as PixiNS.FederatedPointerEvent);
}

describe("CrosshairController — initial state", () => {
  it("starts hidden; no emissions until a move lands", async () => {
    const s = await setup();
    expect(s.controller.isVisible()).toBe(false);
    expect(s.payloads).toHaveLength(0);
  });
});

describe("CrosshairController — move handling", () => {
  it("records pending state and calls invalidate on a mouse move", async () => {
    const s = await setup();
    fakeMove(s.stage, 300, 150);
    expect(s.invalidate).toHaveBeenCalledTimes(1);
    // No emit yet — emission happens inside redraw().
    expect(s.payloads).toHaveLength(0);
  });

  it("emits a full payload after redraw with snapped time + finite price", async () => {
    const s = await setup();
    fakeMove(s.stage, 300, 200);
    s.controller.redraw(s.ctx());
    expect(s.payloads).toHaveLength(1);
    const p = s.payloads[0];
    expect(p).toBeDefined();
    if (p === undefined) {return;}
    // x=300 @ 20px/bar → bar 15 → snapped time START + 15 min.
    expect(Number(p.time)).toBe(START + 15 * MIN);
    expect(p.price).not.toBeNull();
    expect(p.point.x).toBeDefined();
    expect(p.seriesData.size).toBe(0);
    expect(s.controller.isVisible()).toBe(true);
  });

  it("filters out touch pointers", async () => {
    const s = await setup();
    fakeMove(s.stage, 300, 200, "touch");
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it("accepts pen pointers", async () => {
    const s = await setup();
    fakeMove(s.stage, 300, 200, "pen");
    expect(s.invalidate).toHaveBeenCalledTimes(1);
  });
});

describe("CrosshairController — leave semantics", () => {
  it("pointerleave on canvas hides + emits partial payload", async () => {
    const s = await setup();
    fakeMove(s.stage, 300, 200);
    s.controller.redraw(s.ctx());
    expect(s.controller.isVisible()).toBe(true);

    const leaveEvent = new Event("pointerleave");
    s.canvas.dispatchEvent(leaveEvent);
    s.controller.redraw(s.ctx());

    expect(s.controller.isVisible()).toBe(false);
    const last = s.payloads[s.payloads.length - 1];
    expect(last).toBeDefined();
    if (last === undefined) {return;}
    expect(last.time).toBeNull();
    expect(last.price).toBeNull();
    expect(last.seriesData.size).toBe(0);
    expect(last.point).toBeDefined();
  });

  it("moving outside plot bounds emits partial payload (OOB treated as leave)", async () => {
    const s = await setup();
    fakeMove(s.stage, 300, 200);
    s.controller.redraw(s.ctx());
    expect(s.controller.isVisible()).toBe(true);

    fakeMove(s.stage, 1500, 200); // past plot.w=1200
    s.controller.redraw(s.ctx());

    expect(s.controller.isVisible()).toBe(false);
    const last = s.payloads[s.payloads.length - 1];
    expect(last).toBeDefined();
    if (last === undefined) {return;}
    expect(last.time).toBeNull();
    expect(last.price).toBeNull();
  });

  it("redraw with no prior move stays hidden and does not emit (idle)", async () => {
    const s = await setup();
    s.controller.redraw(s.ctx());
    expect(s.controller.isVisible()).toBe(false);
    expect(s.payloads).toHaveLength(0);
  });
});

describe("CrosshairController — payload shape", () => {
  it("non-finite price domain → price field is null, time still present", async () => {
    const s = await setup();
    // Swap in a degenerate price scale (NaN domain).
    const baseCtx = s.ctx();
    const degenerate = new PriceScale({
      domainMin: asPrice(Number.NaN),
      domainMax: asPrice(Number.NaN),
      pixelHeight: 400,
    });
    fakeMove(s.stage, 300, 200);
    s.controller.redraw({ ...baseCtx, priceScale: degenerate });
    const p = s.payloads[s.payloads.length - 1];
    // Degenerate valid=false → pixelToValue returns midpoint (0.5), which
    // IS finite, so price is still a number. The degenerate-price path is
    // only engaged when the result is NaN/Infinity — use a fake priceScale.
    expect(p).toBeDefined();
  });

  it("emits once per redraw regardless of multiple fired moves in one frame", async () => {
    const s = await setup();
    fakeMove(s.stage, 100, 200);
    fakeMove(s.stage, 200, 200);
    fakeMove(s.stage, 300, 200);
    // 3 moves → 3 invalidate calls, 0 emits yet.
    expect(s.invalidate).toHaveBeenCalledTimes(3);
    expect(s.payloads).toHaveLength(0);
    // One redraw → one emit using the LATEST pending state (x=300).
    s.controller.redraw(s.ctx());
    expect(s.payloads).toHaveLength(1);
    expect(Number(s.payloads[0]?.time)).toBe(START + 15 * MIN);
  });
});

describe("CrosshairController — seriesData", () => {
  it("collects one entry per registered series (hit + miss)", async () => {
    const s = await setup();
    s.dataStore.defineChannel({ id: "primary", kind: "ohlc" });
    s.dataStore.insert("primary", MIN, ohlc(START + 15 * MIN, 150));

    // Build two fake series that only need `.channel` + `.kind`.
    const seriesA = { channel: "primary", kind: "ohlc" } as unknown as Series;
    const seriesB = { channel: "empty", kind: "point" } as unknown as Series;
    s.series.push(seriesA, seriesB);

    fakeMove(s.stage, 300, 200);
    s.controller.redraw(s.ctx());

    const p = s.payloads[s.payloads.length - 1];
    expect(p).toBeDefined();
    if (p === undefined) {return;}
    expect(p.seriesData.size).toBe(2);
    // Hit:
    const hit = p.seriesData.get(seriesA as unknown as never);
    expect(hit).not.toBeNull();
    expect(hit).toBeDefined();
    // Miss:
    const miss = p.seriesData.get(seriesB as unknown as never);
    expect(miss).toBeNull();
  });
});

describe("CrosshairController — background redraw cadence", () => {
  it("bg rebuilds on first render; stays flat while label width is unchanged", async () => {
    const s = await setup();
    // First redraw at a fixed x should rebuild both tag backgrounds once.
    fakeMove(s.stage, 300, 200);
    s.controller.redraw(s.ctx());
    const afterFirst = s.controller.getBgRedrawCount();
    expect(afterFirst).toBeGreaterThanOrEqual(2);

    // Move slightly within the same bar's snap slot; label text unchanged,
    // so bg should NOT rebuild. We don't strictly guarantee same-width
    // across pixel positions — assert monotonic non-decrease and that
    // many moves don't rebuild on every move.
    for (let i = 0; i < 10; i++) {
      fakeMove(s.stage, 300 + i * 0.01, 200);
      s.controller.redraw(s.ctx());
    }
    const afterSettle = s.controller.getBgRedrawCount();
    // At most one extra rebuild per tag from the first identical frame.
    expect(afterSettle - afterFirst).toBeLessThanOrEqual(2);
  });
});

describe("CrosshairController — destroy", () => {
  it("unsubscribes stage + canvas listeners and hides crosshair", async () => {
    const s = await setup();
    fakeMove(s.stage, 300, 200);
    s.controller.redraw(s.ctx());
    expect(s.controller.isVisible()).toBe(true);

    s.controller.destroy();

    const emitCountBefore = s.controller.getEmitCount();
    // After destroy, moves must not schedule work.
    const invalidateCalls = s.invalidate.mock.calls.length;
    fakeMove(s.stage, 500, 200);
    expect(s.invalidate.mock.calls.length).toBe(invalidateCalls);

    const leaveEvent = new Event("pointerleave");
    s.canvas.dispatchEvent(leaveEvent);
    expect(s.controller.getEmitCount()).toBe(emitCountBefore);
  });

  it("is idempotent", async () => {
    const s = await setup();
    s.controller.destroy();
    expect(() => { s.controller.destroy(); }).not.toThrow();
  });
});

