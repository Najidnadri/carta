import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DebouncedEmitter } from "./DebouncedEmitter.js";

describe("DebouncedEmitter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires after `delay` ms on a single push", () => {
    const fn = vi.fn();
    const em = new DebouncedEmitter<number>(150, fn);
    em.push(42);
    vi.advanceTimersByTime(149);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledWith(42);
  });

  it("multiple pushes within delay — one fire, last payload wins", () => {
    const fn = vi.fn();
    const em = new DebouncedEmitter<number>(150, fn);
    em.push(1);
    vi.advanceTimersByTime(50);
    em.push(2);
    vi.advanceTimersByTime(50);
    em.push(3);
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });

  it("timer fires at `delay` ms from the first push (does not reset)", () => {
    const fn = vi.fn();
    const em = new DebouncedEmitter<number>(100, fn);
    em.push(1);
    vi.advanceTimersByTime(50);
    em.push(2);
    vi.advanceTimersByTime(49);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2);
  });

  it("re-arms after firing on a subsequent push", () => {
    const fn = vi.fn();
    const em = new DebouncedEmitter<number>(100, fn);
    em.push(1);
    vi.advanceTimersByTime(100);
    em.push(2);
    vi.advanceTimersByTime(99);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(2);
  });

  it("cancel() before fire suppresses the emission", () => {
    const fn = vi.fn();
    const em = new DebouncedEmitter<number>(100, fn);
    em.push(1);
    em.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel() makes future push()/flushNow() no-ops", () => {
    const fn = vi.fn();
    const em = new DebouncedEmitter<number>(100, fn);
    em.cancel();
    em.push(1);
    em.flushNow();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });

  it("flushNow() fires the pending payload immediately", () => {
    const fn = vi.fn();
    const em = new DebouncedEmitter<number>(500, fn);
    em.push(7);
    em.flushNow();
    expect(fn).toHaveBeenCalledWith(7);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flushNow() with nothing pending is a no-op", () => {
    const fn = vi.fn();
    const em = new DebouncedEmitter<number>(500, fn);
    em.flushNow();
    expect(fn).not.toHaveBeenCalled();
  });

  it("hasPending() tracks pending state", () => {
    const fn = vi.fn();
    const em = new DebouncedEmitter<number>(100, fn);
    expect(em.hasPending()).toBe(false);
    em.push(1);
    expect(em.hasPending()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(em.hasPending()).toBe(false);
  });

  it("accepts an injected clock (real setTimeout not used)", () => {
    const timers: { id: number; fn: () => void }[] = [];
    let nextId = 1;
    const clock = {
      setTimeout: (fn: () => void): number => {
        const id = nextId++;
        timers.push({ id, fn });
        return id;
      },
      clearTimeout: (id: number): void => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) {
          timers.splice(i, 1);
        }
      },
    };
    const fn = vi.fn();
    const em = new DebouncedEmitter<number>(100, fn, clock);
    em.push(7);
    expect(timers.length).toBe(1);
    // fire manually
    timers[0]?.fn();
    expect(fn).toHaveBeenCalledWith(7);
  });
});
