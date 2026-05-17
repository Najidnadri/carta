/**
 * Phase 15 Cycle C — IDB Promise wrapper tests.
 */

import { describe, expect, it } from "vitest";
import { reqAsPromise, txAsPromise } from "./idbPromise.js";

interface FakeEvtTarget {
  readonly listeners: Map<string, EventListenerOrEventListenerObject[]>;
  addEventListener(type: string, l: EventListenerOrEventListenerObject): void;
  fire(type: string): void;
}

function fakeEvtTarget(): FakeEvtTarget {
  const listeners = new Map<string, EventListenerOrEventListenerObject[]>();
  return {
    listeners,
    addEventListener(type, l): void {
      const arr = listeners.get(type) ?? [];
      arr.push(l);
      listeners.set(type, arr);
    },
    fire(type): void {
      const arr = listeners.get(type) ?? [];
      const evt = { type } as Event;
      for (const l of arr) {
        if (typeof l === "function") {
          l(evt);
        } else {
          l.handleEvent(evt);
        }
      }
    },
  };
}

function fakeReq<T>(): { req: IDBRequest<T>; setResult: (v: T) => void; setError: (e: DOMException) => void; et: FakeEvtTarget } {
  const et = fakeEvtTarget();
  let result: T | undefined;
  let error: DOMException | null = null;
  const req = {
    addEventListener: (type: string, l: EventListenerOrEventListenerObject): void => { et.addEventListener(type, l); },
    get result(): T { return result as T; },
    get error(): DOMException | null { return error; },
  } as unknown as IDBRequest<T>;
  return {
    req,
    setResult(v): void { result = v; },
    setError(e): void { error = e; },
    et,
  };
}

function fakeTx(): { tx: IDBTransaction; setError: (e: DOMException) => void; et: FakeEvtTarget } {
  const et = fakeEvtTarget();
  let error: DOMException | null = null;
  const tx = {
    addEventListener: (type: string, l: EventListenerOrEventListenerObject): void => { et.addEventListener(type, l); },
    get error(): DOMException | null { return error; },
  } as unknown as IDBTransaction;
  return {
    tx,
    setError(e): void { error = e; },
    et,
  };
}

describe("reqAsPromise", () => {
  it("resolves on success", async () => {
    const { req, setResult, et } = fakeReq<string>();
    const p = reqAsPromise(req);
    setResult("hello");
    et.fire("success");
    await expect(p).resolves.toBe("hello");
  });

  it("rejects on error with req.error", async () => {
    const { req, setError, et } = fakeReq<string>();
    const p = reqAsPromise(req);
    const dom = new DOMException("io fail", "InvalidStateError");
    setError(dom);
    et.fire("error");
    await expect(p).rejects.toBe(dom);
  });

  it("rejects with synthetic error when req.error is null", async () => {
    const { req, et } = fakeReq<string>();
    const p = reqAsPromise(req);
    et.fire("error");
    await expect(p).rejects.toThrow(/IDB request failed/);
  });
});

describe("txAsPromise", () => {
  it("resolves on complete", async () => {
    const { tx, et } = fakeTx();
    const p = txAsPromise(tx);
    et.fire("complete");
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects on error with tx.error", async () => {
    const { tx, setError, et } = fakeTx();
    const dom = new DOMException("commit fail", "QuotaExceededError");
    setError(dom);
    const p = txAsPromise(tx);
    et.fire("error");
    await expect(p).rejects.toBe(dom);
  });

  it("rejects on abort", async () => {
    const { tx, et } = fakeTx();
    const p = txAsPromise(tx);
    et.fire("abort");
    await expect(p).rejects.toThrow(/aborted/);
  });
});
