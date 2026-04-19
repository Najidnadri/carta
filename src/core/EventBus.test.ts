import { describe, it, expect, vi } from "vitest";
import { EventBus } from "./EventBus.js";
import type { Logger } from "../types.js";

interface TestMap extends Record<string, unknown> {
  "evt:a": { value: number };
  "evt:b": string;
}

function capturingLogger(): Logger & { readonly errors: unknown[][] } {
  const errors: unknown[][] = [];
  return {
    errors,
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (...args): void => {
      errors.push([...args]);
    },
  };
}

describe("EventBus", () => {
  it("delivers payload to registered handler", () => {
    const bus = new EventBus<TestMap>();
    const h = vi.fn();
    bus.on("evt:a", h);
    bus.emit("evt:a", { value: 42 });
    expect(h).toHaveBeenCalledWith({ value: 42 });
  });

  it("emit is a no-op when no listener is registered", () => {
    const bus = new EventBus<TestMap>();
    expect(() => {
      bus.emit("evt:a", { value: 1 });
    }).not.toThrow();
  });

  it("off removes only that handler", () => {
    const bus = new EventBus<TestMap>();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on("evt:b", h1);
    bus.on("evt:b", h2);
    bus.off("evt:b", h1);
    bus.emit("evt:b", "hello");
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledWith("hello");
  });

  it("once fires exactly once and unsubscribes itself", () => {
    const bus = new EventBus<TestMap>();
    const h = vi.fn();
    bus.once("evt:a", h);
    bus.emit("evt:a", { value: 1 });
    bus.emit("evt:a", { value: 2 });
    expect(h).toHaveBeenCalledTimes(1);
    expect(h).toHaveBeenCalledWith({ value: 1 });
    expect(bus.listenerCount("evt:a")).toBe(0);
  });

  it("once handler that re-subscribes survives", () => {
    const bus = new EventBus<TestMap>();
    const calls: number[] = [];
    const registerAgain = (): void => {
      bus.once("evt:a", (p) => {
        calls.push(p.value);
      });
    };
    bus.once("evt:a", (p) => {
      calls.push(p.value);
      registerAgain();
    });
    bus.emit("evt:a", { value: 1 });
    bus.emit("evt:a", { value: 2 });
    expect(calls).toEqual([1, 2]);
  });

  it("emit clones the handler set so mid-emit off does not skip siblings", () => {
    const bus = new EventBus<TestMap>();
    const calls: string[] = [];
    const hA: (p: string) => void = () => {
      calls.push("A");
      bus.off("evt:b", hB);
    };
    const hB: (p: string) => void = () => {
      calls.push("B");
    };
    bus.on("evt:b", hA);
    bus.on("evt:b", hB);
    bus.emit("evt:b", "go");
    expect(calls).toEqual(["A", "B"]);
    // second emit should not fire B
    bus.emit("evt:b", "again");
    expect(calls).toEqual(["A", "B", "A"]);
  });

  it("thrown handler is caught, logged, and does not abort siblings", () => {
    const logger = capturingLogger();
    const bus = new EventBus<TestMap>({ logger });
    const h1 = vi.fn(() => {
      throw new Error("boom");
    });
    const h2 = vi.fn();
    bus.on("evt:b", h1);
    bus.on("evt:b", h2);
    bus.emit("evt:b", "go");
    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalledWith("go");
    expect(logger.errors.length).toBe(1);
    expect(String(logger.errors[0]?.[0])).toContain("evt:b");
  });

  it("thrown once-handler is caught and still unsubscribed", () => {
    const logger = capturingLogger();
    const bus = new EventBus<TestMap>({ logger });
    bus.once("evt:b", () => {
      throw new Error("boom");
    });
    bus.emit("evt:b", "a");
    bus.emit("evt:b", "b");
    expect(logger.errors.length).toBe(1);
    expect(bus.listenerCount("evt:b")).toBe(0);
  });

  it("removeAllListeners clears every event", () => {
    const bus = new EventBus<TestMap>();
    bus.on("evt:a", (): void => undefined);
    bus.on("evt:b", (): void => undefined);
    expect(bus.listenerCount("evt:a")).toBe(1);
    expect(bus.listenerCount("evt:b")).toBe(1);
    bus.removeAllListeners();
    expect(bus.listenerCount("evt:a")).toBe(0);
    expect(bus.listenerCount("evt:b")).toBe(0);
  });

  it("removeAllListeners mid-emit does not throw; snapshotted handlers still fire", () => {
    const bus = new EventBus<TestMap>();
    const calls: string[] = [];
    bus.on("evt:b", () => {
      calls.push("first");
      bus.removeAllListeners();
    });
    bus.on("evt:b", () => {
      calls.push("second");
    });
    bus.emit("evt:b", "go");
    expect(calls).toEqual(["first", "second"]);
    expect(bus.listenerCount("evt:b")).toBe(0);
  });

  it("off of unregistered handler is a no-op", () => {
    const bus = new EventBus<TestMap>();
    expect(() => {
      bus.off("evt:a", vi.fn());
    }).not.toThrow();
  });

  it("listenerCount reflects on/off", () => {
    const bus = new EventBus<TestMap>();
    const h = vi.fn();
    expect(bus.listenerCount("evt:a")).toBe(0);
    bus.on("evt:a", h);
    expect(bus.listenerCount("evt:a")).toBe(1);
    bus.off("evt:a", h);
    expect(bus.listenerCount("evt:a")).toBe(0);
  });
});
