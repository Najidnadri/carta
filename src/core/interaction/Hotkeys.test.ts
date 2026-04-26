import { describe, expect, it } from "vitest";
import { installHotkeys, isEditableTarget, RECOMMENDED_HOTKEY_BINDINGS, type HotkeysChart } from "./Hotkeys.js";
import type { CartaEventHandler, CartaEventMap, EventKey, KeyboardHotkeyPayload } from "../../types.js";

interface HandlerStore {
  handler: ((e: Event) => void) | null;
}

function makeTarget(store: HandlerStore): EventTarget {
  return {
    addEventListener: ((_event: string, fn: EventListener): void => {
      store.handler = fn as (e: Event) => void;
    }) as EventTarget["addEventListener"],
    removeEventListener: ((): void => {
      store.handler = null;
    }) as EventTarget["removeEventListener"],
    dispatchEvent: (): boolean => true,
  };
}

function makeChart(): {
  chart: HotkeysChart;
  emitted: { event: EventKey; payload: unknown }[];
  beginCalls: string[];
} {
  const emitted: { event: EventKey; payload: unknown }[] = [];
  const beginCalls: string[] = [];
  const noop = (): void => { /* test stub */ };
  const chart: HotkeysChart = {
    on: <K extends EventKey>(_e: K, _h: CartaEventHandler<K>): void => { /* test stub */ },
    off: <K extends EventKey>(_e: K, _h: CartaEventHandler<K>): void => { /* test stub */ },
    emit: <K extends EventKey>(event: K, payload: CartaEventMap[K]): void => {
      emitted.push({ event, payload });
    },
    drawings: {
      beginCreate: (kind): void => { beginCalls.push(kind); },
      cancelCreate: noop,
      isCreating: (): boolean => false,
      list: () => [],
      getById: (): null => null,
      add: noop,
      update: (): boolean => false,
      remove: (): boolean => false,
      clear: noop,
      getSelectedIds: (): readonly never[] => [],
      getPrimarySelectedId: (): null => null,
      toggleSelection: noop,
      select: noop,
      getSnapshot: () => ({ schemaVersion: 1, drawings: [] }),
      loadSnapshot: () => ({ droppedCount: 0, droppedKinds: [] }),
      attachStorage: noop,
      detachStorage: noop,
      getDevHooks: () => ({
        beginDragForTest: (): boolean => false,
        continueDragForTest: (): boolean => false,
        endDragForTest: (): boolean => false,
        getDragState: () => null,
        cancelActiveDrag: noop,
        visibleHandlesFor: () => [],
      }),
    },
  };
  return { chart, emitted, beginCalls };
}

describe("installHotkeys", () => {
  it("emits keyboard:hotkey and calls beginCreate for Alt+T", () => {
    const store: HandlerStore = { handler: null };
    const target = makeTarget(store);
    const { chart, emitted, beginCalls } = makeChart();
    const dispose = installHotkeys(chart, { target });
    expect(store.handler).not.toBeNull();
    const e = new KeyboardEvent("keydown", { key: "T", altKey: true });
    store.handler!(e);
    expect(emitted.length).toBe(1);
    expect(emitted[0]?.event).toBe("keyboard:hotkey");
    const payload = emitted[0]?.payload as KeyboardHotkeyPayload;
    expect(payload.binding).toBe("trendline");
    expect(payload.key).toBe("t");
    expect(beginCalls).toEqual(["trendline"]);
    dispose();
    expect(store.handler).toBeNull();
  });

  it("emits with binding=null for Alt+letter outside the recommended set", () => {
    const store: HandlerStore = { handler: null };
    const target = makeTarget(store);
    const { chart, emitted, beginCalls } = makeChart();
    installHotkeys(chart, { target });
    store.handler!(new KeyboardEvent("keydown", { key: "z", altKey: true }));
    expect(emitted.length).toBe(1);
    expect((emitted[0]?.payload as KeyboardHotkeyPayload).binding).toBeNull();
    expect(beginCalls).toEqual([]);
  });

  it("ignores event.repeat", () => {
    const store: HandlerStore = { handler: null };
    const { chart, emitted } = makeChart();
    installHotkeys(chart, { target: makeTarget(store) });
    const e = new KeyboardEvent("keydown", { key: "t", altKey: true, repeat: true });
    store.handler!(e);
    expect(emitted.length).toBe(0);
  });

  it("isEditableTarget identifies input/textarea/select/contenteditable", () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(document.createElement("input"))).toBe(true);
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(document.createElement("select"))).toBe(true);
    // jsdom does not reflect `.contentEditable` setter into the attribute,
    // so use setAttribute directly for a reliable test.
    const ce = document.createElement("div");
    ce.setAttribute("contenteditable", "true");
    expect(isEditableTarget(ce)).toBe(true);
  });

  it("does not act when alt is not held", () => {
    const store: HandlerStore = { handler: null };
    const { chart, emitted } = makeChart();
    installHotkeys(chart, { target: makeTarget(store) });
    store.handler!(new KeyboardEvent("keydown", { key: "t", altKey: false }));
    expect(emitted.length).toBe(0);
  });

  it("ignores IME composition", () => {
    const store: HandlerStore = { handler: null };
    const { chart, emitted } = makeChart();
    installHotkeys(chart, { target: makeTarget(store) });
    const e = new KeyboardEvent("keydown", { key: "t", altKey: true, isComposing: true });
    store.handler!(e);
    expect(emitted.length).toBe(0);
  });

  it("RECOMMENDED_HOTKEY_BINDINGS table contains all cycle-A + cycle-B kinds", () => {
    const values = Object.values(RECOMMENDED_HOTKEY_BINDINGS);
    expect(new Set(values)).toEqual(new Set([
      "trendline",
      "horizontalLine",
      "verticalLine",
      "fibRetracement",
      "rectangle",
      "ray",
      "extendedLine",
      "horizontalRay",
      "parallelChannel",
      "longPosition",
      "shortPosition",
      "text",
      "callout",
      "arrow",
      "dateRange",
      "priceRange",
      "priceDateRange",
    ]));
  });

  it("Alt+Shift+L resolves to longPosition (Cycle B.2)", () => {
    const store: HandlerStore = { handler: null };
    const { chart, emitted, beginCalls } = makeChart();
    installHotkeys(chart, { target: makeTarget(store) });
    const e = new KeyboardEvent("keydown", { key: "L", altKey: true, shiftKey: true });
    store.handler!(e);
    expect(emitted.length).toBe(1);
    expect((emitted[0]?.payload as KeyboardHotkeyPayload).binding).toBe("longPosition");
    expect(beginCalls).toEqual(["longPosition"]);
  });

  it("Alt+Shift+S resolves to shortPosition (Cycle B.2)", () => {
    const store: HandlerStore = { handler: null };
    const { chart, emitted } = makeChart();
    installHotkeys(chart, { target: makeTarget(store) });
    const e = new KeyboardEvent("keydown", { key: "S", altKey: true, shiftKey: true });
    store.handler!(e);
    expect((emitted[0]?.payload as KeyboardHotkeyPayload).binding).toBe("shortPosition");
  });

  it("Alt+N resolves to text (Cycle B.2)", () => {
    const store: HandlerStore = { handler: null };
    const { chart, emitted } = makeChart();
    installHotkeys(chart, { target: makeTarget(store) });
    const e = new KeyboardEvent("keydown", { key: "n", altKey: true });
    store.handler!(e);
    expect((emitted[0]?.payload as KeyboardHotkeyPayload).binding).toBe("text");
  });

  it("Alt+M resolves to priceRange (Cycle B.2)", () => {
    const store: HandlerStore = { handler: null };
    const { chart, emitted } = makeChart();
    installHotkeys(chart, { target: makeTarget(store) });
    const e = new KeyboardEvent("keydown", { key: "m", altKey: true });
    store.handler!(e);
    expect((emitted[0]?.payload as KeyboardHotkeyPayload).binding).toBe("priceRange");
  });

  it("Alt+L (without Shift) does NOT collide with Alt+Shift+L longPosition binding", () => {
    const store: HandlerStore = { handler: null };
    const { chart, emitted } = makeChart();
    installHotkeys(chart, { target: makeTarget(store) });
    const e = new KeyboardEvent("keydown", { key: "l", altKey: true });
    store.handler!(e);
    expect((emitted[0]?.payload as KeyboardHotkeyPayload).binding).toBeNull();
  });

  it("disposer detaches the listener", () => {
    const store: HandlerStore = { handler: null };
    const { chart, emitted } = makeChart();
    const dispose = installHotkeys(chart, { target: makeTarget(store) });
    dispose();
    // After disposal, dispatching is a no-op on the test target.
    expect(store.handler).toBeNull();
    expect(emitted.length).toBe(0);
  });

  it("custom bindings override the default table", () => {
    const store: HandlerStore = { handler: null };
    const { chart, emitted, beginCalls } = makeChart();
    installHotkeys(chart, { target: makeTarget(store), bindings: { x: "rectangle" } });
    store.handler!(new KeyboardEvent("keydown", { key: "x", altKey: true }));
    expect((emitted[0]?.payload as KeyboardHotkeyPayload).binding).toBe("rectangle");
    expect(beginCalls).toEqual(["rectangle"]);
    // T no longer maps to trendline under this custom table.
    store.handler!(new KeyboardEvent("keydown", { key: "t", altKey: true }));
    expect(beginCalls).toEqual(["rectangle"]);
  });

  it("host can preventDefault on payload.originalEvent inside the emit listener to suppress beginCreate", () => {
    const store: HandlerStore = { handler: null };
    const { chart, beginCalls } = makeChart();
    chart.emit = <K extends EventKey>(_event: K, payload: CartaEventMap[K]): void => {
      const p = payload as KeyboardHotkeyPayload;
      p.originalEvent.preventDefault();
    };
    installHotkeys(chart, { target: makeTarget(store) });
    const e = new KeyboardEvent("keydown", { key: "t", altKey: true, cancelable: true });
    store.handler!(e);
    expect(beginCalls).toEqual([]);
  });
});
