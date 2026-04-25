import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidationQueue, type DirtyReason } from "./InvalidationQueue.js";

interface FakeFrame {
  id: number;
  cb: FrameRequestCallback;
}

describe("InvalidationQueue", () => {
  let pending: FakeFrame[] = [];
  let nextId = 1;

  const runFrame = (): void => {
    const frame = pending.shift();
    if (frame === undefined) {
      return;
    }
    frame.cb(performance.now());
  };

  beforeEach(() => {
    pending = [];
    nextId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
      const id = nextId++;
      pending.push({ id, cb });
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
      pending = pending.filter((f) => f.id !== id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("coalesces multiple invalidations in the same tick into one flush", () => {
    const calls: ReadonlySet<DirtyReason>[] = [];
    const q = new InvalidationQueue((reasons) => {
      calls.push(reasons);
    });
    q.invalidate("data");
    q.invalidate("viewport");
    q.invalidate("data");
    expect(pending.length).toBe(1);
    expect(calls.length).toBe(0);

    runFrame();

    expect(calls.length).toBe(1);
    const reasons = calls[0];
    expect(reasons).toBeDefined();
    expect(Array.from(reasons ?? [])).toEqual(expect.arrayContaining(["data", "viewport"]));
    expect(reasons?.size).toBe(2);
  });

  it("schedules a next-frame RAF for re-entrant invalidates during flush", () => {
    const calls: ReadonlySet<DirtyReason>[] = [];
    const q = new InvalidationQueue((reasons) => {
      calls.push(reasons);
      if (reasons.has("data")) {
        q.invalidate("crosshair");
      }
    });
    q.invalidate("data");
    runFrame();
    expect(calls.length).toBe(1);
    expect(pending.length).toBe(1); // next frame scheduled for re-entrant 'crosshair'

    runFrame();
    expect(calls.length).toBe(2);
    expect(Array.from(calls[1] ?? [])).toEqual(["crosshair"]);
  });

  it("dispose cancels a pending RAF and makes further invalidates no-op", () => {
    const flush = vi.fn();
    const q = new InvalidationQueue(flush);
    q.invalidate("size");
    expect(pending.length).toBe(1);
    q.dispose();
    expect(pending.length).toBe(0);
    q.invalidate("size");
    expect(pending.length).toBe(0);
    expect(flush).not.toHaveBeenCalled();
  });

  it("does not flush if disposed between schedule and frame", () => {
    const flush = vi.fn();
    const q = new InvalidationQueue(flush);
    q.invalidate("layout");
    q.dispose();
    runFrame(); // the frame was cancelled; shift returns undefined
    expect(flush).not.toHaveBeenCalled();
  });
});
