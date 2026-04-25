import { beforeEach, describe, expect, it, vi } from "vitest";
import { StorageBinding } from "./storage.js";
import type { DrawingScope, DrawingsSnapshot, DrawingsStorageAdapter } from "./types.js";
import type { Logger } from "../../types.js";

const noop: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const emptySnap: DrawingsSnapshot = Object.freeze({ schemaVersion: 1, drawings: Object.freeze([]) });

function fakeAdapter(): DrawingsStorageAdapter & { saved: { scope: DrawingScope; snap: DrawingsSnapshot }[]; loaded: DrawingScope[]; nextLoad: DrawingsSnapshot | null } {
  const a: DrawingsStorageAdapter & { saved: { scope: DrawingScope; snap: DrawingsSnapshot }[]; loaded: DrawingScope[]; nextLoad: DrawingsSnapshot | null } = {
    saved: [],
    loaded: [],
    nextLoad: null,
    load: (scope) => {
      a.loaded.push(scope);
      return Promise.resolve(a.nextLoad);
    },
    save: (scope, snap) => {
      a.saved.push({ scope, snap });
      return Promise.resolve();
    },
  };
  return a;
}

describe("StorageBinding", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("auto-loads on attach when scope is non-empty", async () => {
    const adapter = fakeAdapter();
    let applied: DrawingsSnapshot | null = null;
    const sb = new StorageBinding({
      logger: noop,
      applySnapshot: (s) => { applied = s; },
      takeSnapshot: () => emptySnap,
    });
    adapter.nextLoad = emptySnap;
    sb.attach(adapter, { symbol: "AAPL" });
    await Promise.resolve();
    await Promise.resolve();
    expect(adapter.loaded).toEqual([{ symbol: "AAPL" }]);
    expect(applied).toBe(emptySnap);
  });

  it("rejects empty symbol with a warn", () => {
    const adapter = fakeAdapter();
    const warnings: unknown[] = [];
    const logger: Logger = {
      ...noop,
      warn: (...args) => { warnings.push(args); },
    };
    const sb = new StorageBinding({
      logger,
      applySnapshot: () => undefined,
      takeSnapshot: () => emptySnap,
    });
    sb.attach(adapter, { symbol: "" });
    expect(warnings.length).toBe(1);
    expect(adapter.loaded.length).toBe(0);
  });

  it("debounces saves over 250 ms", () => {
    const adapter = fakeAdapter();
    const sb = new StorageBinding({
      logger: noop,
      applySnapshot: () => undefined,
      takeSnapshot: () => emptySnap,
    });
    sb.attach(adapter, { symbol: "AAPL" });
    sb.scheduleSave();
    sb.scheduleSave();
    sb.scheduleSave();
    expect(adapter.saved.length).toBe(0);
    vi.advanceTimersByTime(249);
    expect(adapter.saved.length).toBe(0);
    vi.advanceTimersByTime(2);
    expect(adapter.saved.length).toBe(1);
  });

  it("cancels pending save when scope changes mid-debounce", () => {
    const adapter1 = fakeAdapter();
    const adapter2 = fakeAdapter();
    const sb = new StorageBinding({
      logger: noop,
      applySnapshot: () => undefined,
      takeSnapshot: () => emptySnap,
    });
    sb.attach(adapter1, { symbol: "AAPL" });
    sb.scheduleSave();
    vi.advanceTimersByTime(100);
    sb.attach(adapter2, { symbol: "MSFT" });
    vi.advanceTimersByTime(300);
    // No save should have fired against adapter1 (cancelled mid-debounce);
    // adapter2's only activity was the auto-load.
    expect(adapter1.saved.length).toBe(0);
    expect(adapter2.saved.length).toBe(0);
  });

  it("flushPending fires save synchronously and clears pending", () => {
    const adapter = fakeAdapter();
    const sb = new StorageBinding({
      logger: noop,
      applySnapshot: () => undefined,
      takeSnapshot: () => emptySnap,
    });
    sb.attach(adapter, { symbol: "AAPL" });
    sb.scheduleSave();
    sb.flushPending();
    expect(adapter.saved.length).toBe(1);
    sb.flushPending();
    expect(adapter.saved.length).toBe(1);
  });

  it("detach flushes a pending save before invalidating generation", () => {
    const adapter = fakeAdapter();
    const sb = new StorageBinding({
      logger: noop,
      applySnapshot: () => undefined,
      takeSnapshot: () => emptySnap,
    });
    sb.attach(adapter, { symbol: "AAPL" });
    sb.scheduleSave();
    expect(adapter.saved.length).toBe(0);
    sb.detach();
    expect(adapter.saved.length).toBe(1);
    // Subsequent timer ticks must NOT produce a second save.
    vi.advanceTimersByTime(500);
    expect(adapter.saved.length).toBe(1);
  });

  it("destroy cancels pending and prevents further saves", () => {
    const adapter = fakeAdapter();
    const sb = new StorageBinding({
      logger: noop,
      applySnapshot: () => undefined,
      takeSnapshot: () => emptySnap,
    });
    sb.attach(adapter, { symbol: "AAPL" });
    sb.scheduleSave();
    sb.destroy();
    vi.advanceTimersByTime(500);
    expect(adapter.saved.length).toBe(0);
  });
});
