import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Container, Graphics } from "pixi.js";
import { ShapePool } from "./ShapePool.js";

describe("ShapePool", () => {
  let layer: Container;
  let pool: ShapePool;

  beforeEach(() => {
    layer = new Container();
    pool = new ShapePool(layer);
  });

  afterEach(() => {
    pool.destroy();
    layer.destroy();
  });

  it("acquires a fresh Graphics when pool is empty", () => {
    const g = pool.acquire();
    expect(g).toBeInstanceOf(Graphics);
    expect(g.visible).toBe(true);
    expect(g.parent).toBe(layer);
    expect(pool.activeCount()).toBe(1);
    expect(pool.totalCount()).toBe(1);
  });

  it("releaseAll hides + recycles everything", () => {
    const a = pool.acquire();
    const b = pool.acquire();
    pool.releaseAll();
    expect(a.visible).toBe(false);
    expect(b.visible).toBe(false);
    expect(pool.activeCount()).toBe(0);
    expect(pool.totalCount()).toBe(2);
  });

  it("re-uses freed Graphics on next acquire", () => {
    const a = pool.acquire();
    pool.releaseAll();
    const b = pool.acquire();
    expect(b).toBe(a);
    expect(b.visible).toBe(true);
    expect(pool.totalCount()).toBe(1);
  });

  it("never shrinks mid-session — high-water mark stays resident", () => {
    for (let i = 0; i < 5; i++) {
      pool.acquire();
    }
    pool.releaseAll();
    // Second frame acquires only 2 — pool's total is still 5.
    pool.acquire();
    pool.acquire();
    expect(pool.totalCount()).toBe(5);
    expect(pool.activeCount()).toBe(2);
  });

  it("parents Graphics onto layer on first acquire, keeps them thereafter", () => {
    const a = pool.acquire();
    expect(a.parent).toBe(layer);
    pool.releaseAll();
    // parent is still the layer — we don't reparent on release.
    expect(a.parent).toBe(layer);
    const b = pool.acquire();
    expect(b).toBe(a);
    expect(b.parent).toBe(layer);
  });

  it("destroy tears down every Graphics in both lists", () => {
    pool.acquire();
    pool.acquire();
    pool.releaseAll();
    pool.acquire();
    expect(pool.totalCount()).toBe(2);
    pool.destroy();
    expect(pool.totalCount()).toBe(0);
    expect(pool.activeCount()).toBe(0);
  });

  it("destroy is idempotent", () => {
    pool.acquire();
    pool.destroy();
    pool.destroy();
    expect(pool.totalCount()).toBe(0);
  });
});
